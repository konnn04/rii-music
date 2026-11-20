package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"rii_music/internal/textutil"
	"rii_music/internal/ytdlp"
)

type Job struct {
	ID       string  `json:"id"`
	UserID   string  `json:"userId"`
	URL      string  `json:"url"`
	SourceID string  `json:"sourceId"`
	Title    string  `json:"title"`
	Status   string  `json:"status"`
	Progress float64 `json:"progress"`
	Stage    string  `json:"stage"` // human-readable step while running
	Error    string  `json:"error"`
	TrackID  string  `json:"trackId"`
	Origin   string  `json:"origin"` // user | autoplay | auto
	// Saved album / playlist this download goes into (collections.go).
	PlaylistID  string `json:"playlistId,omitempty"`
	PlaylistPos int    `json:"-"`
	CreatedAt   int64  `json:"createdAt"`
	UpdatedAt   int64  `json:"updatedAt"`
}

type Downloader struct {
	s       *Server
	queue   chan string
	mu      sync.Mutex
	cancels map[string]context.CancelFunc
}

func NewDownloader(s *Server) *Downloader {
	return &Downloader{s: s, queue: make(chan string, 10000), cancels: map[string]context.CancelFunc{}}
}

// Start re-queues jobs interrupted by a restart and launches the workers.
func (d *Downloader) Start(ctx context.Context) {
	db := d.s.db
	db.Exec(`UPDATE download_jobs SET status = 'queued', progress = 0, stage = '' WHERE status IN ('downloading', 'processing')`)
	rows, err := db.Query(`SELECT id FROM download_jobs WHERE status = 'queued' ORDER BY created_at`)
	if err == nil {
		ids, _ := scanStrings(rows)
		for _, id := range ids {
			d.queue <- id
		}
	}
	os.RemoveAll(d.s.cfg.TmpDir())
	for i := 0; i < d.s.cfg.MaxJobs; i++ {
		go d.worker(ctx)
	}
}

func (d *Downloader) worker(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case id := <-d.queue:
			d.run(ctx, id)
		}
	}
}

func (d *Downloader) enqueue(id string) {
	select {
	case d.queue <- id:
	default:
		d.s.log.Error("download queue full", "job", id)
	}
}

func (d *Downloader) cancel(id string) {
	d.mu.Lock()
	if c, ok := d.cancels[id]; ok {
		c()
	}
	d.mu.Unlock()
}

// ── job storage ─────────────────────────────────────────────────────────

const jobCols = `id, user_id, url, COALESCE(source_id, ''), title, status, progress, stage, error, COALESCE(track_id, ''), origin, COALESCE(playlist_id, ''), playlist_pos, created_at, updated_at`

func (s *Server) queryJobs(q string, args ...any) ([]Job, error) {
	rows, err := s.db.Query(`SELECT `+jobCols+` FROM download_jobs `+q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Job{}
	for rows.Next() {
		var j Job
		if err := rows.Scan(&j.ID, &j.UserID, &j.URL, &j.SourceID, &j.Title, &j.Status, &j.Progress, &j.Stage, &j.Error, &j.TrackID, &j.Origin, &j.PlaylistID, &j.PlaylistPos, &j.CreatedAt, &j.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, j)
	}
	return out, rows.Err()
}

func (s *Server) getJob(id string) (*Job, error) {
	js, err := s.queryJobs(`WHERE id = ?`, id)
	if err != nil {
		return nil, err
	}
	if len(js) == 0 {
		return nil, errNotFound
	}
	return &js[0], nil
}

func (d *Downloader) save(j *Job) {
	j.UpdatedAt = nowMs()
	res, err := d.s.db.Exec(`UPDATE download_jobs SET url=?, source_id=NULLIF(?, ''), title=?, status=?, progress=?, stage=?, error=?, track_id=NULLIF(?, ''), updated_at=? WHERE id=?`,
		j.URL, j.SourceID, j.Title, j.Status, j.Progress, j.Stage, j.Error, j.TrackID, j.UpdatedAt, j.ID)
	if err != nil {
		d.s.log.Error("save job", "job", j.ID, "err", err)
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return // job was deleted
	}
	d.s.hub.Publish(j.UserID, "job", j)
}

func (s *Server) insertJob(uid, rawURL, title, origin string) (*Job, error) {
	return s.insertJobFor(uid, rawURL, title, origin, "", 0)
}

// insertJobFor also records the saved playlist (and position) the song goes into.
func (s *Server) insertJobFor(uid, rawURL, title, origin, playlistID string, pos int) (*Job, error) {
	now := nowMs()
	if origin != "autoplay" && origin != "auto" {
		origin = "user"
	}
	j := &Job{ID: newID(), UserID: uid, URL: rawURL, Title: title, Status: "queued", Origin: origin, PlaylistID: playlistID, PlaylistPos: pos, CreatedAt: now, UpdatedAt: now}
	if vid := videoIDFromURL(rawURL); vid != "" {
		j.SourceID = vid
	}
	_, err := s.db.Exec(`INSERT INTO download_jobs(id, user_id, url, source_id, title, status, origin, playlist_id, playlist_pos, created_at, updated_at) VALUES (?,?,?,NULLIF(?, ''),?,?,?,NULLIF(?, ''),?,?,?)`,
		j.ID, uid, j.URL, j.SourceID, j.Title, j.Status, j.Origin, playlistID, pos, now, now)
	if err != nil {
		return nil, err
	}
	s.hub.Publish(uid, "job", j)
	return j, nil
}

// ── input validation ────────────────────────────────────────────────────

var (
	videoIDRe  = regexp.MustCompile(`^[A-Za-z0-9_-]{11}$`)
	listIDRe   = regexp.MustCompile(`^[A-Za-z0-9_-]{2,64}$`)
	allowHosts = map[string]bool{"youtube.com": true, "www.youtube.com": true, "m.youtube.com": true, "music.youtube.com": true, "youtu.be": true}
)

// normalizeInput turns user input into a canonical target: a watch URL, a
// playlist URL, or "ytsearch1:<keywords>". Anything else is refused, so yt-dlp
// never sees an arbitrary URL or an option-looking string.
func normalizeInput(in string) (string, error) {
	in = strings.TrimSpace(in)
	if in == "" {
		return "", errors.New("Trống")
	}
	if !strings.HasPrefix(in, "http://") && !strings.HasPrefix(in, "https://") {
		if strings.Contains(in, "://") {
			return "", errors.New("Chỉ nhận liên kết YouTube")
		}
		if len([]rune(in)) > 200 {
			return "", errors.New("Từ khoá quá dài")
		}
		return "ytsearch1:" + in, nil
	}
	u, err := url.Parse(in)
	if err != nil || !allowHosts[strings.ToLower(u.Hostname())] {
		return "", errors.New("Chỉ nhận liên kết YouTube / YouTube Music")
	}
	if vid := videoIDFromURL(in); vid != "" {
		return "https://www.youtube.com/watch?v=" + vid, nil
	}
	if list := u.Query().Get("list"); listIDRe.MatchString(list) {
		return "https://www.youtube.com/playlist?list=" + list, nil
	}
	return "", errors.New("Không nhận ra video hay playlist trong liên kết này")
}

func videoIDFromURL(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || !allowHosts[strings.ToLower(u.Hostname())] {
		return ""
	}
	if strings.EqualFold(u.Hostname(), "youtu.be") {
		if id := strings.Trim(u.Path, "/"); videoIDRe.MatchString(id) {
			return id
		}
		return ""
	}
	if v := u.Query().Get("v"); videoIDRe.MatchString(v) {
		return v
	}
	parts := strings.Split(strings.Trim(u.Path, "/"), "/")
	if len(parts) == 2 && (parts[0] == "shorts" || parts[0] == "live" || parts[0] == "embed") && videoIDRe.MatchString(parts[1]) {
		return parts[1]
	}
	return ""
}

// ── handlers ────────────────────────────────────────────────────────────

func (s *Server) handleListJobs(w http.ResponseWriter, r *http.Request) {
	js, err := s.queryJobs(`WHERE user_id = ? ORDER BY created_at DESC LIMIT 300`, userOf(r).ID)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	ready, yerr := s.yt.Status()
	msg := ""
	if yerr != nil {
		msg = yerr.Error()
	}
	writeJSON(w, http.StatusOK, map[string]any{"jobs": js, "ytdlpReady": ready, "ytdlpError": msg})
}

func (s *Server) handleCreateJobs(w http.ResponseWriter, r *http.Request) {
	u := userOf(r)
	var body struct {
		Input  string `json:"input"`
		Title  string `json:"title"`
		Origin string `json:"origin"` // "autoplay" for queue suggestions; anything else = user
	}
	if !readJSON(w, r, &body) {
		return
	}
	lines := strings.FieldsFunc(body.Input, func(r rune) bool { return r == '\n' || r == '\r' })
	if len(lines) == 0 {
		httpError(w, http.StatusBadRequest, "Dán liên kết YouTube hoặc gõ từ khoá")
		return
	}
	if len(lines) > 50 {
		httpError(w, http.StatusBadRequest, "Tối đa 50 dòng mỗi lần")
		return
	}
	var pending int
	s.db.QueryRow(`SELECT COUNT(*) FROM download_jobs WHERE user_id = ? AND status IN ('queued','downloading','processing')`, u.ID).Scan(&pending)
	if pending+len(lines) > 500 {
		httpError(w, http.StatusTooManyRequests, "Hàng chờ tải đang quá dài, đợi bớt rồi thêm tiếp")
		return
	}
	// Storage limit: with Tự động tải nhạc on, old tracks make room by
	// themselves; otherwise a full library takes no new downloads.
	if used, _ := s.userUsage(u.ID); used >= int64(u.StorageLimitMB)<<20 && !s.loadSettings(u.ID).AutoDownload {
		httpError(w, http.StatusInsufficientStorage, fmt.Sprintf("Thư viện đã đầy giới hạn %s. Xoá bớt bài, bật Tự động tải nhạc (tự dọn bài ít nghe) hoặc nhờ admin nâng giới hạn.", fmtMB(u.StorageLimitMB)))
		return
	}
	if !s.jobRL.Allow("jobs:" + u.ID) {
		httpError(w, http.StatusTooManyRequests, "Thêm quá nhanh, đợi một phút")
		return
	}
	created := []Job{}
	errs := []string{}
	for _, line := range lines {
		target, err := normalizeInput(line)
		if err != nil {
			errs = append(errs, fmt.Sprintf("%s: %s", strings.TrimSpace(line), err.Error()))
			continue
		}
		title := strings.TrimSpace(body.Title)
		if strings.HasPrefix(target, "ytsearch1:") && title == "" {
			title = "Tìm: " + strings.TrimPrefix(target, "ytsearch1:")
		}
		j, err := s.insertJob(u.ID, target, title, body.Origin)
		if err != nil {
			s.internalError(w, r, err)
			return
		}
		s.dl.enqueue(j.ID)
		created = append(created, *j)
	}
	if len(created) == 0 {
		httpError(w, http.StatusBadRequest, strings.Join(errs, "; "))
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"jobs": created, "errors": errs})
}

func (s *Server) handleRetryJob(w http.ResponseWriter, r *http.Request) {
	j, err := s.getJob(r.PathValue("id"))
	if err == nil && j.UserID != userOf(r).ID && !userOf(r).IsAdmin() {
		err = errNotFound
	}
	if errors.Is(err, errNotFound) {
		httpError(w, http.StatusNotFound, "Không có job này")
		return
	} else if err != nil {
		s.internalError(w, r, err)
		return
	}
	if j.Status != "error" {
		httpError(w, http.StatusConflict, "Chỉ thử lại được job lỗi")
		return
	}
	j.Status, j.Progress, j.Error = "queued", 0, ""
	s.dl.save(j)
	s.dl.enqueue(j.ID)
	writeJSON(w, http.StatusOK, j)
}

func (s *Server) handleDeleteJob(w http.ResponseWriter, r *http.Request) {
	u := userOf(r)
	id := r.PathValue("id")
	j, err := s.getJob(id)
	if err != nil || (j.UserID != u.ID && !u.IsAdmin()) {
		httpError(w, http.StatusNotFound, "Không có job này")
		return
	}
	s.dl.cancel(id)
	if _, err := s.db.Exec(`DELETE FROM download_jobs WHERE id = ?`, id); err != nil {
		s.internalError(w, r, err)
		return
	}
	s.hub.Publish(j.UserID, "jobRemoved", map[string]string{"id": id})
	w.WriteHeader(http.StatusNoContent)
}

// handleClearJobs removes finished jobs (done, skipped, and optionally error).
func (s *Server) handleClearJobs(w http.ResponseWriter, r *http.Request) {
	statuses := "'done','skipped'"
	if r.URL.Query().Get("errors") == "1" {
		statuses += ",'error'"
	}
	uid := userOf(r).ID
	if _, err := s.db.Exec(`DELETE FROM download_jobs WHERE user_id = ? AND status IN (`+statuses+`)`, uid); err != nil {
		s.internalError(w, r, err)
		return
	}
	s.hub.Publish(uid, "jobsCleared", map[string]bool{"ok": true})
	w.WriteHeader(http.StatusNoContent)
}

// ── pipeline ────────────────────────────────────────────────────────────

func (d *Downloader) run(parent context.Context, id string) {
	j, err := d.s.getJob(id)
	if err != nil || j.Status != "queued" {
		return // deleted or already handled
	}
	ctx, cancel := context.WithTimeout(parent, 30*time.Minute)
	d.mu.Lock()
	d.cancels[id] = cancel
	d.mu.Unlock()
	defer func() {
		cancel()
		d.mu.Lock()
		delete(d.cancels, id)
		d.mu.Unlock()
	}()

	j.Status, j.Progress, j.Error = "downloading", 0, ""
	switch {
	case strings.Contains(j.URL, "/playlist?list="):
		j.Stage = "Đang đọc danh sách playlist"
	case strings.HasPrefix(j.URL, "ytsearch1:"):
		j.Stage = "Đang tìm trên YouTube"
	default:
		j.Stage = "Đang lấy thông tin từ YouTube"
	}
	d.save(j)
	start := time.Now()
	err = d.process(ctx, j)
	if err != nil {
		if parent.Err() != nil {
			return // shutting down; Start() re-queues it next boot
		}
		if _, gerr := d.s.getJob(id); errors.Is(gerr, errNotFound) {
			return // deleted while running
		}
		j.Status, j.Error, j.Stage = "error", friendlyError(err), ""
		d.s.log.Warn("download failed", "job", id, "url", j.URL, "err", err)
	} else {
		j.Stage = ""
		d.s.log.Info("download finished", "job", id, "status", j.Status, "title", j.Title, "dur_ms", time.Since(start).Milliseconds())
	}
	d.save(j)
}

func friendlyError(err error) string {
	var ye *ytdlp.Error
	msg := err.Error()
	if errors.As(err, &ye) {
		msg = ye.Reason
	}
	low := strings.ToLower(msg)
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		return "Quá thời gian (30 phút)"
	case strings.Contains(low, "sign in to confirm") || strings.Contains(low, "not a bot"):
		return "YouTube yêu cầu xác minh (chống bot). Thêm cookies.txt vào thư mục dữ liệu rồi thử lại. Chi tiết: " + msg
	case strings.Contains(low, "private video"):
		return "Video riêng tư"
	case strings.Contains(low, "video unavailable"):
		return "Video không còn hoặc bị chặn ở khu vực này"
	case strings.Contains(low, "age"):
		return "Video giới hạn độ tuổi, cần cookies.txt. Chi tiết: " + msg
	}
	if len(msg) > 500 {
		msg = msg[:500] + "…"
	}
	return msg
}

func (d *Downloader) process(ctx context.Context, j *Job) error {
	s := d.s
	if strings.Contains(j.URL, "/playlist?list=") {
		return d.expandPlaylist(ctx, j)
	}
	if strings.HasPrefix(j.URL, "ytsearch1:") {
		res, err := s.yt.Flat(ctx, j.URL)
		if err != nil {
			return err
		}
		if len(res.Entries) == 0 || !videoIDRe.MatchString(res.Entries[0].ID) {
			return errors.New("Không tìm thấy kết quả nào trên YouTube")
		}
		e := res.Entries[0]
		j.URL = "https://www.youtube.com/watch?v=" + e.ID
		j.SourceID = e.ID
		j.Title = e.Title
		j.Stage = "Đang lấy thông tin từ YouTube"
		d.save(j)
	}
	if j.SourceID == "" {
		j.SourceID = videoIDFromURL(j.URL)
	}
	if j.SourceID == "" {
		return errors.New("Liên kết không hợp lệ")
	}

	// Shared store: a song someone already downloaded is just added to this
	// user's library, no download needed.
	var existing string
	if err := s.db.QueryRow(`SELECT id FROM tracks WHERE source_id = ?`, j.SourceID).Scan(&existing); err == nil {
		j.TrackID, j.Progress = existing, 1
		if t, err := s.sharedTrack(existing); err == nil {
			j.Title = strings.TrimSpace(t.Artist + " - " + t.Title)
		}
		res, err := s.db.Exec(`INSERT INTO user_tracks(user_id, track_id, origin, added_at) VALUES (?,?,?,?) ON CONFLICT DO NOTHING`,
			j.UserID, existing, j.Origin, nowMs())
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			j.Status, j.Error = "skipped", "Đã có trong thư viện"
			s.fillPlaylist(j)
			return nil
		}
		j.Status = "done"
		s.afterAdd(j.UserID, existing)
		s.fillPlaylist(j)
		return nil
	} else if !errors.Is(err, sql.ErrNoRows) {
		return err
	}

	tmp := filepath.Join(s.cfg.TmpDir(), j.ID)
	os.RemoveAll(tmp)
	if err := os.MkdirAll(tmp, 0o755); err != nil {
		return err
	}
	defer os.RemoveAll(tmp)

	settings := s.serverSettings()
	src, info, err := d.fetch(ctx, j, tmp, settings)
	if err != nil {
		return err
	}

	j.Status, j.Progress, j.Stage = "processing", 0.82, "Đang cắt ảnh bìa, gắn thông tin"
	d.save(j)

	trackID, err := d.ingest(ctx, j, tmp, src, info, settings)
	if err != nil {
		return err
	}
	if j.Status != "skipped" {
		j.Status = "done"
	}
	j.Progress, j.TrackID = 1, trackID
	s.features.Kick()
	s.afterAdd(j.UserID, trackID)
	s.fillPlaylist(j)
	return nil
}

// afterAdd: a track entered a user's library.
func (s *Server) afterAdd(uid, trackID string) {
	s.db.Exec(`DELETE FROM removed_tracks WHERE user_id = ? AND source_id = (SELECT source_id FROM tracks WHERE id = ?)`, uid, trackID)
	s.hub.Publish(uid, "library", map[string]string{"added": trackID})
	go s.enforceBudget(context.Background(), uid) // no-op unless Tự động tải nhạc is on
}

func fmtMB(mb int) string {
	if mb >= 1024 && mb%1024 == 0 {
		return strconv.Itoa(mb/1024) + " GB"
	}
	return strconv.Itoa(mb) + " MB"
}

func (d *Downloader) expandPlaylist(ctx context.Context, j *Job) error {
	res, err := d.s.yt.Flat(ctx, j.URL)
	if err != nil {
		return err
	}
	n := 0
	for _, e := range res.Entries {
		if !videoIDRe.MatchString(e.ID) || e.Title == "[Private video]" || e.Title == "[Deleted video]" {
			continue
		}
		child, err := d.s.insertJob(j.UserID, "https://www.youtube.com/watch?v="+e.ID, e.Title, j.Origin)
		if err != nil {
			return err
		}
		d.enqueue(child.ID)
		n++
	}
	j.Status, j.Progress = "done", 1
	j.Title = fmt.Sprintf("Playlist: %s (%d bài)", firstNonEmpty(res.Title, "không tên"), n)
	return nil
}

type ytInfo struct {
	ID         string   `json:"id"`
	Title      string   `json:"title"`
	Track      string   `json:"track"`
	Artist     string   `json:"artist"`
	Artists    []string `json:"artists"`
	Creator    string   `json:"creator"`
	Uploader   string   `json:"uploader"`
	Channel    string   `json:"channel"`
	Album      string   `json:"album"`
	Duration   float64  `json:"duration"`
	ACodec     string   `json:"acodec"`
	WebpageURL string   `json:"webpage_url"`
	IsLive     bool     `json:"is_live"`
}

var playerClients = []string{"", "tv", "web_safari", "android"}

// fetch downloads the best audio stream plus thumbnail and info.json, trying
// alternative YouTube player clients when the default one is refused.
func (d *Downloader) fetch(ctx context.Context, j *Job, tmp string, st ServerSettings) (string, *ytInfo, error) {
	format := "bestaudio[acodec^=mp4a]/bestaudio/best"
	if st.AudioFormat == "opus" {
		format = "bestaudio[acodec=opus]/bestaudio/best"
	}
	var lastErr error
	lastPublish := time.Time{}
	for _, client := range playerClients {
		args := []string{
			"--no-playlist", "--newline", "--no-simulate", "--progress",
			"-f", format,
			"--match-filter", fmt.Sprintf("!is_live & duration < %d", d.s.cfg.MaxDuration),
			"--write-info-json", "--write-thumbnail", "--convert-thumbnails", "jpg",
			"--print", "before_dl:[vang-title]%(title)s",
			"--progress-template", "download:[vang-dl]%(progress.downloaded_bytes)s/%(progress.total_bytes)s/%(progress.total_bytes_estimate)s",
			"-o", filepath.Join(tmp, "src.%(ext)s"),
		}
		if client != "" {
			args = append(args, "--extractor-args", "youtube:player_client="+client)
		}
		args = append(args, "--", j.URL)

		_, err := d.s.yt.Run(ctx, args, func(line string) {
			switch {
			case strings.HasPrefix(line, "[vang-title]"):
				if t := strings.TrimPrefix(line, "[vang-title]"); t != "" && t != "NA" {
					j.Title = t
					j.Stage = "Đang tải"
					d.save(j)
				}
			case strings.HasPrefix(line, "[vang-dl]"):
				p := parseProgress(strings.TrimPrefix(line, "[vang-dl]"))
				if p >= 0 && time.Since(lastPublish) > 400*time.Millisecond {
					lastPublish = time.Now()
					j.Progress = p * 0.8
					j.Stage = "Đang tải"
					d.save(j)
				}
			}
		})
		if err != nil {
			lastErr = err
			if ctx.Err() != nil {
				return "", nil, ctx.Err()
			}
			d.s.log.Info("yt-dlp attempt failed, trying next client", "job", j.ID, "client", client, "err", err)
			j.Progress, j.Stage = 0, "YouTube từ chối, đang thử cách khác"
			d.save(j)
			continue
		}
		src, info, err := readFetched(tmp)
		if err != nil {
			return "", nil, err
		}
		return src, info, nil
	}
	return "", nil, lastErr
}

func parseProgress(s string) float64 {
	parts := strings.Split(s, "/")
	if len(parts) != 3 {
		return -1
	}
	done, err := strconv.ParseFloat(parts[0], 64)
	if err != nil {
		return -1
	}
	total, err := strconv.ParseFloat(parts[1], 64)
	if err != nil || total <= 0 {
		total, err = strconv.ParseFloat(parts[2], 64)
		if err != nil || total <= 0 {
			return -1
		}
	}
	return min(done/total, 1)
}

func readFetched(tmp string) (string, *ytInfo, error) {
	entries, err := os.ReadDir(tmp)
	if err != nil {
		return "", nil, err
	}
	var src string
	var info ytInfo
	gotInfo := false
	for _, e := range entries {
		name := e.Name()
		switch {
		case strings.HasSuffix(name, ".info.json"):
			b, err := os.ReadFile(filepath.Join(tmp, name))
			if err == nil && json.Unmarshal(b, &info) == nil {
				gotInfo = true
			}
		case strings.HasSuffix(name, ".jpg"), strings.HasSuffix(name, ".webp"), strings.HasSuffix(name, ".png"), strings.HasSuffix(name, ".part"), strings.HasSuffix(name, ".ytdl"):
		default:
			src = filepath.Join(tmp, name)
		}
	}
	if src == "" {
		if gotInfo && info.IsLive {
			return "", nil, errors.New("Không tải được livestream")
		}
		return "", nil, errors.New("Video bị bỏ qua (livestream, quá dài hoặc không có âm thanh)")
	}
	if !gotInfo {
		return "", nil, errors.New("thiếu info.json từ yt-dlp")
	}
	return src, &info, nil
}

// ingest measures loudness, transcodes/remuxes with tags and cover, and inserts the track.
func (d *Downloader) ingest(ctx context.Context, j *Job, tmp, src string, info *ytInfo, st ServerSettings) (string, error) {
	s := d.s
	// Names: YouTube Music's data for official songs and music videos; the
	// cleaned-up YouTube title only for other uploads.
	ytm, err := ytmVideoMeta(ctx, s.ext.hc, info.ID)
	if err != nil {
		s.log.Debug("YouTube Music metadata", "video", info.ID, "err", err)
	}
	artist, title, album := trackMeta(ytm, textutil.Meta{
		Title: info.Title, Track: info.Track, Artist: info.Artist, Artists: info.Artists,
		Creator: info.Creator, Uploader: info.Uploader, Channel: info.Channel, Album: info.Album,
	})
	id := newID()

	// Cover: center-square crop of the thumbnail.
	hasCover := false
	thumb := filepath.Join(tmp, "src.jpg")
	coverOut := filepath.Join(s.cfg.CoverDir(), id+".jpg")
	if _, err := os.Stat(thumb); err == nil {
		vf := "crop='min(iw,ih)':'min(iw,ih)',scale=720:720:flags=lanczos"
		if bars := detectBars(ctx, s.cfg.FFmpeg, thumb); bars != "" {
			vf = bars + "," + vf // drop letterbox bars first
		}
		if err := runFFmpeg(ctx, s.cfg.FFmpeg, "-y", "-i", thumb, "-vf", vf, "-q:v", "3", coverOut); err == nil {
			hasCover = true
		} else {
			s.log.Warn("cover crop failed", "job", j.ID, "err", err)
		}
	}

	// Loudness is measured afterwards by the analysis worker, so the track is
	// playable as soon as it is saved.
	j.Progress, j.Stage = 0.94, "Đang lưu vào thư viện"
	d.save(j)

	ext, mime := "m4a", "audio/mp4"
	if st.AudioFormat == "opus" {
		ext, mime = "opus", "audio/ogg"
	}
	codec := strings.ToLower(info.ACodec)
	args := []string{"-y", "-i", src}
	if hasCover && ext == "m4a" {
		args = append(args, "-i", coverOut, "-map", "0:a:0", "-map", "1:v:0", "-c:v", "copy", "-disposition:v:0", "attached_pic")
	} else {
		args = append(args, "-map", "0:a:0", "-vn")
	}
	switch {
	case ext == "m4a" && strings.HasPrefix(codec, "mp4a"):
		args = append(args, "-c:a", "copy")
	case ext == "m4a":
		args = append(args, "-c:a", "aac", "-b:a", strconv.Itoa(st.Bitrate)+"k")
	case ext == "opus" && codec == "opus":
		args = append(args, "-c:a", "copy")
	default:
		args = append(args, "-c:a", "libopus", "-b:a", strconv.Itoa(st.Bitrate)+"k")
	}
	args = append(args,
		"-map_metadata", "-1",
		"-metadata", "title="+title, "-metadata", "artist="+artist, "-metadata", "album="+album,
		"-metadata", "comment="+info.WebpageURL,
	)
	if ext == "m4a" {
		args = append(args, "-movflags", "+faststart")
	}
	tmpOut := filepath.Join(tmp, "out."+ext)
	args = append(args, tmpOut)
	if err := runFFmpeg(ctx, s.cfg.FFmpeg, args...); err != nil {
		os.Remove(coverOut)
		return "", fmt.Errorf("ffmpeg: %w", err)
	}

	rel := "music/" + id + "." + ext
	final := filepath.Join(s.cfg.DataDir, filepath.FromSlash(rel))
	if err := moveFile(tmpOut, final); err != nil {
		os.Remove(coverOut)
		return "", err
	}
	stat, _ := os.Stat(final)
	size := int64(0)
	if stat != nil {
		size = stat.Size()
	}

	now := nowMs()
	err = s.tx(func(exec func(string, ...any) error) error {
		if err := exec(`INSERT INTO tracks(id, source, source_id, source_url, title, artist, album, duration_ms, file_path, mime, size_bytes, has_cover, loudness_done, search, lang, added_at)
			VALUES (?, 'youtube', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
			id, info.ID, info.WebpageURL, title, artist, album, int64(info.Duration*1000), rel, mime, size, hasCover,
			searchText(title, artist, album), textutil.DetectLang(title, artist), now); err != nil {
			return err
		}
		return exec(`INSERT INTO user_tracks(user_id, track_id, origin, added_at) VALUES (?,?,?,?)`, j.UserID, id, j.Origin, now)
	})
	if err != nil {
		os.Remove(final)
		os.Remove(coverOut)
		if strings.Contains(err.Error(), "UNIQUE") {
			// Someone else downloaded the same song meanwhile: use theirs.
			var existing string
			s.db.QueryRow(`SELECT id FROM tracks WHERE source_id = ?`, info.ID).Scan(&existing)
			s.db.Exec(`INSERT INTO user_tracks(user_id, track_id, origin, added_at) VALUES (?,?,?,?) ON CONFLICT DO NOTHING`, j.UserID, existing, j.Origin, now)
			return existing, nil
		}
		return "", err
	}
	j.Title = strings.TrimSpace(artist + " - " + title)
	if artist == "" {
		j.Title = title
	}
	return id, nil
}

func isNaN(f float64) bool { return f != f }

func moveFile(from, to string) error {
	if err := os.MkdirAll(filepath.Dir(to), 0o755); err != nil {
		return err
	}
	if err := os.Rename(from, to); err == nil {
		return nil
	}
	b, err := os.ReadFile(from)
	if err != nil {
		return err
	}
	return os.WriteFile(to, b, 0o644)
}

func runFFmpeg(ctx context.Context, bin string, args ...string) error {
	cmd := exec.CommandContext(ctx, bin, append([]string{"-hide_banner", "-loglevel", "error", "-nostdin"}, args...)...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		msg := strings.TrimSpace(string(out))
		if len(msg) > 400 {
			msg = msg[len(msg)-400:]
		}
		return fmt.Errorf("%w: %s", err, msg)
	}
	return nil
}

const targetLUFS = -14.0

// measureLoudness runs an EBU R128 pass and returns integrated loudness and
// the gain (dB) that brings the track to -14 LUFS without pushing the true
// peak above -1 dBTP.
//
// It uses the ebur128 filter: same EBU R128 measurement as loudnorm's analysis
// pass but about 7× faster (loudnorm resamples to 192 kHz internally).
func measureLoudness(ctx context.Context, bin, src string) (lufs float64, gain float64) {
	nan := math.NaN()
	cmd := exec.CommandContext(ctx, bin, "-hide_banner", "-nostats", "-nostdin", "-i", src, "-map", "0:a:0",
		"-af", "ebur128=peak=true", "-f", "null", "-")
	out, err := cmd.CombinedOutput()
	if err != nil {
		return nan, 0
	}
	i, tp, ok := parseEBUR128(string(out))
	if !ok || i < -70 {
		return nan, 0
	}
	g := targetLUFS - i
	if !math.IsNaN(tp) && g > -1-tp {
		g = -1 - tp
	}
	g = max(-15, min(g, 10))
	return i, math.Round(g*10) / 10
}

var (
	ebuIRe    = regexp.MustCompile(`(?m)^\s*I:\s+(-?[\d.]+|-inf)\s+LUFS`)
	ebuPeakRe = regexp.MustCompile(`(?m)^\s*Peak:\s+(-?[\d.]+|-inf)\s+dBFS`)
)

// parseEBUR128 reads integrated loudness and true peak from the filter's final
// summary (per-frame log lines also contain "I:", so only the summary is read).
func parseEBUR128(out string) (i, tp float64, ok bool) {
	idx := strings.LastIndex(out, "Summary:")
	if idx < 0 {
		return 0, 0, false
	}
	sum := out[idx:]
	m := ebuIRe.FindStringSubmatch(sum)
	if m == nil {
		return 0, 0, false
	}
	i, err := strconv.ParseFloat(m[1], 64)
	if err != nil || math.IsInf(i, 0) {
		return 0, 0, false // "-inf": silence
	}
	tp = math.NaN()
	if p := ebuPeakRe.FindStringSubmatch(sum); p != nil {
		if v, err := strconv.ParseFloat(p[1], 64); err == nil {
			tp = v
		}
	}
	return i, tp, true
}

var cropRe = regexp.MustCompile(`crop=(\d+):(\d+):(\d+):(\d+)`)

// detectBars finds black letterbox/pillarbox bars in a thumbnail and returns a
// crop filter that removes them, or "" when there is nothing worth cropping.
func detectBars(ctx context.Context, bin, img string) string {
	out, err := exec.CommandContext(ctx, bin, "-hide_banner", "-nostdin", "-i", img, "-vf", "cropdetect=limit=24:round=2:reset=0:skip=0", "-f", "null", "-").CombinedOutput()
	if err != nil {
		return ""
	}
	m := cropRe.FindAllStringSubmatch(string(out), -1)
	if len(m) == 0 {
		return ""
	}
	last := m[len(m)-1]
	w, _ := strconv.Atoi(last[1])
	h, _ := strconv.Atoi(last[2])
	if w < 64 || h < 64 {
		return "" // nearly black image: keep as is
	}
	return "crop=" + last[1] + ":" + last[2] + ":" + last[3] + ":" + last[4]
}
