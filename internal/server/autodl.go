package server

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"math/rand/v2"
	"net/http"
	"sort"
	"sync"
	"time"
)

// Tự động tải nhạc, per user: every few hours, look at the user's listening
// habits and pre-download songs from favourite and similar artists while their
// library stays under the storage limit the admin set. Over the limit, the
// tracks least likely to be played again leave their library (the shared file
// goes once nobody has it). Nothing runs, and nothing is removed, for users
// who have it off.

const (
	autoDLInterval  = 6 * time.Hour
	autoDLFirstWait = 2 * time.Minute
	autoDLMaxPerRun = 8
	autoDLMaxActive = 4                   // don't stack runs while earlier downloads are still going
	staleAutoAfter  = 14 * 24 * time.Hour // unplayed auto-downloads may be rotated out after this
)

type autoStatus struct {
	Running     bool   `json:"running"`
	LastRun     int64  `json:"lastRun"`
	LastAdded   int    `json:"lastAdded"`
	LastEvicted int    `json:"lastEvicted"`
	LastMsg     string `json:"lastMessage"`
}

type autoDL struct {
	kick    chan string // user id
	evictMu sync.Mutex

	mu      sync.Mutex
	nextRun int64
	status  map[string]*autoStatus
}

func newAutoDL() *autoDL {
	return &autoDL{kick: make(chan string, 64), status: map[string]*autoStatus{}}
}

func (a *autoDL) kickNow(uid string) {
	select {
	case a.kick <- uid:
	default:
	}
}

func (a *autoDL) get(uid string) autoStatus {
	a.mu.Lock()
	defer a.mu.Unlock()
	if st := a.status[uid]; st != nil {
		return *st
	}
	return autoStatus{}
}

func (a *autoDL) set(uid string, f func(*autoStatus)) {
	a.mu.Lock()
	defer a.mu.Unlock()
	st := a.status[uid]
	if st == nil {
		st = &autoStatus{}
		a.status[uid] = st
	}
	f(st)
}

func (s *Server) runAutoDownloader(ctx context.Context) {
	timer := time.NewTimer(autoDLFirstWait)
	defer timer.Stop()
	s.autodl.mu.Lock()
	s.autodl.nextRun = time.Now().Add(autoDLFirstWait).UnixMilli()
	s.autodl.mu.Unlock()
	for {
		select {
		case <-ctx.Done():
			return
		case uid := <-s.autodl.kick:
			s.autoDownloadOnce(ctx, uid)
			continue
		case <-timer.C:
		}
		for _, uid := range s.autoDownloadUsers() {
			if ctx.Err() != nil {
				return
			}
			s.autoDownloadOnce(ctx, uid)
		}
		timer.Reset(autoDLInterval)
		s.autodl.mu.Lock()
		s.autodl.nextRun = time.Now().Add(autoDLInterval).UnixMilli()
		s.autodl.mu.Unlock()
	}
}

// autoDownloadUsers lists active users who turned Tự động tải nhạc on.
func (s *Server) autoDownloadUsers() []string {
	rows, err := s.db.Query(`SELECT id, settings_json FROM users WHERE disabled = 0`)
	if err != nil {
		return nil
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var id, raw string
		var st Settings
		if rows.Scan(&id, &raw) == nil && json.Unmarshal([]byte(raw), &st) == nil && st.AutoDownload {
			out = append(out, id)
		}
	}
	return out
}

func (s *Server) autoDownloadOnce(ctx context.Context, uid string) {
	u, err := s.userByID(uid)
	if err != nil || u.Disabled || !s.loadSettings(uid).AutoDownload {
		return
	}
	a := s.autodl
	a.set(uid, func(st *autoStatus) { st.Running = true })
	s.hub.Publish(uid, "autodl", map[string]bool{"changed": true})

	ctx, cancel := context.WithTimeout(ctx, 3*time.Minute)
	defer cancel()
	added, evicted, msg := 0, 0, ""
	defer func() {
		a.set(uid, func(st *autoStatus) {
			st.Running, st.LastRun, st.LastAdded, st.LastEvicted, st.LastMsg = false, nowMs(), added, evicted, msg
		})
		s.hub.Publish(uid, "autodl", map[string]bool{"changed": true})
		s.log.Info("tự động tải nhạc", "user", uid, "added", added, "evicted", evicted, "msg", msg)
	}()

	evicted = s.enforceBudget(ctx, uid)
	limit := int64(u.StorageLimitMB) << 20
	used, count := s.userUsage(uid)
	var active int
	s.db.QueryRow(`SELECT COUNT(*) FROM download_jobs WHERE user_id = ? AND origin = 'auto' AND status IN ('queued','downloading','processing')`, uid).Scan(&active)
	if active >= autoDLMaxActive {
		msg = fmt.Sprintf("Còn %d bài đang tải từ lần trước", active)
		return
	}
	avg := int64(6 << 20)
	if count > 0 {
		avg = max(2<<20, used/int64(count))
	}
	n := min(autoDLMaxPerRun, int((limit-used-int64(active)*avg)/avg))
	if n <= 0 {
		// Full: make room by rotating out auto-downloads that were never played.
		k := s.evictStaleAuto(ctx, uid, 3)
		evicted += k
		n = k
		if n == 0 {
			msg = "Đã chạm giới hạn dung lượng, không còn bài tự tải nào để thay"
			return
		}
	}

	rc, err := s.newRecCtx(ctx, uid, false)
	if err != nil {
		msg = "Lỗi đọc thư viện"
		return
	}
	seeds := rc.taste.seeds(8)
	if len(seeds) == 0 {
		msg = "Cần nghe thêm vài bài để biết gu của bạn"
		return
	}
	var arts []artW
	seen := map[string]bool{}
	for i, k := range seeds {
		w := 1 - float64(i)*0.08
		name := rc.taste.name(k)
		if !seen[k] {
			seen[k] = true
			arts = append(arts, artW{name, "Bạn hay nghe " + name, 0.7 * w})
		}
		sim, _ := s.ext.Similar(ctx, name, false)
		for j, x := range sim {
			kx := looseName(x.Name)
			if j >= 6 || seen[kx] || rc.taste.dislikedArt[kx] {
				continue
			}
			seen[kx] = true
			arts = append(arts, artW{x.Name, "Giống " + name, w * (0.3 + 0.6*x.Match)})
		}
	}
	rng := rand.New(rand.NewPCG(uint64(time.Now().UnixNano()), hashSeed(uid)))
	for _, e := range s.externalFromArtists(ctx, rc, arts, n, rng, "") {
		target, err := normalizeInput(e.URL)
		if err != nil {
			continue
		}
		j, err := s.insertJob(uid, target, e.Artist+" - "+e.Title, "auto")
		if err != nil {
			continue
		}
		s.dl.enqueue(j.ID)
		added++
	}
	if added == 0 {
		msg = "Chưa tìm được bài mới hợp gu (thử lại sau)"
	} else {
		msg = fmt.Sprintf("Đã thêm %d bài vào hàng chờ tải", added)
	}
}

type evictCand struct {
	id, artist, origin string
	size, plays        int64
	lastPlay, addedAt  int64
	liked, inPlaylist  bool
	score              float64
}

// libraryForEviction lists a user's tracks that may be removed, least wanted
// first. Protected (never removed): liked, in one of their manual playlists,
// added in the last 3 days, played in the last 14 days.
func (s *Server) libraryForEviction(ctx context.Context, uid string) ([]evictCand, error) {
	rc, err := s.newRecCtx(ctx, uid, false)
	if err != nil {
		return nil, err
	}
	rows, err := s.db.Query(`SELECT t.id, t.artist, ut.origin, t.size_bytes, ut.play_count, COALESCE(ut.last_played_at, 0), ut.added_at,
		EXISTS(SELECT 1 FROM likes l WHERE l.user_id = ut.user_id AND l.track_id = t.id),
		EXISTS(SELECT 1 FROM playlist_items p JOIN playlists pl ON pl.id = p.playlist_id WHERE p.track_id = t.id AND pl.user_id = ut.user_id AND pl.kind = 'manual')
		FROM user_tracks ut JOIN tracks t ON t.id = ut.track_id WHERE ut.user_id = ?`, uid)
	if err != nil {
		return nil, err
	}
	var all []evictCand
	for rows.Next() {
		var c evictCand
		if err := rows.Scan(&c.id, &c.artist, &c.origin, &c.size, &c.plays, &c.lastPlay, &c.addedAt, &c.liked, &c.inPlaylist); err != nil {
			rows.Close()
			return nil, err
		}
		all = append(all, c)
	}
	rows.Close()

	now := time.Now()
	out := all[:0]
	for _, c := range all {
		if c.liked || c.inPlaylist || c.addedAt > now.Add(-3*24*time.Hour).UnixMilli() || c.lastPlay > now.Add(-14*24*time.Hour).UnixMilli() {
			continue
		}
		// How likely it is to be played again: its own history, how much the
		// artist is liked, and whether it was chosen by hand.
		art := 0.0
		for _, a := range splitArtists(c.artist) {
			art = math.Max(art, rc.taste.artist[looseName(a)])
		}
		c.score = rc.taste.track[c.id] + 0.4*math.Log1p(float64(c.plays)) + 0.3*art
		if c.origin == "user" {
			c.score += 1
		} else if c.plays == 0 {
			c.score -= 0.5
		}
		out = append(out, c)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].score < out[j].score })
	return out, nil
}

// enforceBudget removes a user's least wanted tracks until their library fits
// the limit. No-op while their Tự động tải nhạc is off. Returns how many.
func (s *Server) enforceBudget(ctx context.Context, uid string) int {
	if !s.loadSettings(uid).AutoDownload {
		return 0
	}
	u, err := s.userByID(uid)
	if err != nil {
		return 0
	}
	s.autodl.evictMu.Lock()
	defer s.autodl.evictMu.Unlock()
	limit := int64(u.StorageLimitMB) << 20
	used, _ := s.userUsage(uid)
	if used <= limit {
		return 0
	}
	cands, err := s.libraryForEviction(ctx, uid)
	if err != nil {
		s.log.Warn("eviction list failed", "err", err)
		return 0
	}
	n := 0
	for _, c := range cands {
		if used <= limit {
			break
		}
		if err := s.removeFromLibrary(uid, c.id); err != nil {
			s.log.Warn("evict failed", "track", c.id, "err", err)
			continue
		}
		used -= c.size
		n++
		s.log.Info("vượt giới hạn dung lượng, đã bỏ bài ít khả năng nghe", "user", uid, "track", c.id, "score", c.score)
	}
	if used > limit {
		s.log.Warn("vẫn vượt giới hạn: các bài còn lại đều được giữ (thích, trong playlist, mới thêm hoặc mới nghe)", "user", uid)
	}
	return n
}

// evictStaleAuto removes up to k of a user's auto-downloaded tracks that were
// never played and are older than two weeks, to make room for fresh ones.
func (s *Server) evictStaleAuto(ctx context.Context, uid string, k int) int {
	s.autodl.evictMu.Lock()
	defer s.autodl.evictMu.Unlock()
	cands, err := s.libraryForEviction(ctx, uid)
	if err != nil {
		return 0
	}
	cutoff := time.Now().Add(-staleAutoAfter).UnixMilli()
	n := 0
	for _, c := range cands {
		if n == k {
			break
		}
		if c.origin != "auto" || c.plays > 0 || c.addedAt > cutoff {
			continue
		}
		if s.removeFromLibrary(uid, c.id) == nil {
			n++
		}
	}
	return n
}

func (s *Server) handleAutoDLStatus(w http.ResponseWriter, r *http.Request) {
	u := userOf(r)
	used, count := s.userUsage(u.ID)
	var autoTracks, active int
	s.db.QueryRow(`SELECT COUNT(*) FROM user_tracks WHERE user_id = ? AND origin = 'auto'`, u.ID).Scan(&autoTracks)
	s.db.QueryRow(`SELECT COUNT(*) FROM download_jobs WHERE user_id = ? AND origin = 'auto' AND status IN ('queued','downloading','processing')`, u.ID).Scan(&active)
	st := s.autodl.get(u.ID)
	s.autodl.mu.Lock()
	next := s.autodl.nextRun
	s.autodl.mu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{
		"enabled": s.loadSettings(u.ID).AutoDownload, "limitBytes": int64(u.StorageLimitMB) << 20, "usedBytes": used,
		"tracks": count, "autoTracks": autoTracks, "pending": active,
		"running": st.Running, "lastRun": st.LastRun, "nextRun": next,
		"lastAdded": st.LastAdded, "lastEvicted": st.LastEvicted, "lastMessage": st.LastMsg,
	})
}

func (s *Server) handleAutoDLRun(w http.ResponseWriter, r *http.Request) {
	uid := userOf(r).ID
	if !s.loadSettings(uid).AutoDownload {
		httpError(w, http.StatusConflict, "Bật Tự động tải nhạc trước")
		return
	}
	s.autodl.kickNow(uid)
	writeJSON(w, http.StatusAccepted, map[string]bool{"ok": true})
}
