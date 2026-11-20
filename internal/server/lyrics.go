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
	"regexp"
	"strconv"
	"strings"
	"time"

	"vang/internal/textutil"
)

// Lyrics as one user sees them.
type Lyrics struct {
	Plain    string `json:"plain"`
	Synced   string `json:"synced"`
	Source   string `json:"source"` // lrclib | manual | none
	OffsetMs int64  `json:"offsetMs"`
	LrclibID int64  `json:"lrclibId,omitempty"`
	// Where they come from: auto (found by Vang), mine (this user picked or
	// pasted them), community (picked by several other users of this server).
	Choice string `json:"choice"`
}

// LRCLib is a client for lrclib.net (open lyrics API, synced LRC by line).
type LRCLib struct{ hc *http.Client }

func NewLRCLib() *LRCLib { return &LRCLib{hc: &http.Client{Timeout: 10 * time.Second}} }

type lrcItem struct {
	ID           int64   `json:"id"`
	TrackName    string  `json:"trackName"`
	ArtistName   string  `json:"artistName"`
	AlbumName    string  `json:"albumName"`
	Duration     float64 `json:"duration"`
	Instrumental bool    `json:"instrumental"`
	PlainLyrics  string  `json:"plainLyrics"`
	SyncedLyrics string  `json:"syncedLyrics"`
}

func (l *LRCLib) get(ctx context.Context, path string, q url.Values, v any) error {
	u := "https://lrclib.net/api/" + path
	if len(q) > 0 {
		u += "?" + q.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "Vang self-hosted music player")
	res, err := l.hc.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusNotFound {
		return errNotFound
	}
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("lrclib %s: %s", path, res.Status)
	}
	return json.NewDecoder(res.Body).Decode(v)
}

// Search lists LRCLIB entries for free text and/or title + artist.
func (l *LRCLib) Search(ctx context.Context, title, artist, q string) ([]lrcItem, error) {
	v := url.Values{}
	if q != "" {
		v.Set("q", q)
	}
	if title != "" {
		v.Set("track_name", title)
	}
	if artist != "" {
		v.Set("artist_name", artist)
	}
	var list []lrcItem
	if err := l.get(ctx, "search", v, &list); err != nil && !errors.Is(err, errNotFound) {
		return nil, err
	}
	return list, nil
}

// ByID fetches one LRCLIB entry.
func (l *LRCLib) ByID(ctx context.Context, id int64) (*lrcItem, error) {
	var it lrcItem
	if err := l.get(ctx, "get/"+strconv.FormatInt(id, 10), nil, &it); err != nil {
		return nil, err
	}
	return &it, nil
}

// Find tries an exact match first, then a search filtered by duration (±4 s)
// so a same-named but different song is not picked.
func (l *LRCLib) Find(ctx context.Context, title, artist string, durationSec float64) (*lrcItem, error) {
	if artist != "" {
		q := url.Values{"track_name": {title}, "artist_name": {artist}}
		if durationSec > 0 {
			q.Set("duration", fmt.Sprint(int(math.Round(durationSec))))
		}
		var it lrcItem
		err := l.get(ctx, "get", q, &it)
		if err == nil && (it.SyncedLyrics != "" || it.PlainLyrics != "") {
			return &it, nil
		}
		if err != nil && !errors.Is(err, errNotFound) {
			return nil, err
		}
	}
	list, err := l.Search(ctx, title, artist, "")
	if err != nil {
		return nil, err
	}
	if len(list) == 0 && artist != "" {
		if list, err = l.Search(ctx, "", "", title+" "+artist); err != nil {
			return nil, err
		}
	}
	var best *lrcItem
	bestScore := math.Inf(1)
	for i := range list {
		it := &list[i]
		if it.SyncedLyrics == "" && it.PlainLyrics == "" {
			continue
		}
		diff := math.Abs(it.Duration - durationSec)
		if durationSec > 0 && diff > 4 {
			continue
		}
		score := diff
		if it.SyncedLyrics == "" {
			score += 3 // prefer synced
		}
		if score < bestScore {
			best, bestScore = it, score
		}
	}
	if best == nil {
		return nil, errNotFound
	}
	return best, nil
}

// ── storage ─────────────────────────────────────────────────────────────

// sharedLyrics: what Vang found automatically (one row per track).
func (s *Server) sharedLyrics(id string) (*Lyrics, error) {
	var l Lyrics
	err := s.db.QueryRow(`SELECT plain, synced, source, offset_ms, lrclib_id FROM lyrics WHERE track_id = ?`, id).Scan(&l.Plain, &l.Synced, &l.Source, &l.OffsetMs, &l.LrclibID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	l.Choice = "auto"
	return &l, err
}

func (s *Server) saveShared(id string, l Lyrics) error {
	_, err := s.db.Exec(`INSERT INTO lyrics(track_id, plain, synced, source, offset_ms, lrclib_id, updated_at) VALUES (?,?,?,?,?,?,?)
		ON CONFLICT(track_id) DO UPDATE SET plain=excluded.plain, synced=excluded.synced, source=excluded.source, offset_ms=excluded.offset_ms, lrclib_id=excluded.lrclib_id, updated_at=excluded.updated_at`,
		id, l.Plain, l.Synced, l.Source, l.OffsetMs, l.LrclibID, nowMs())
	return err
}

type choiceRow struct {
	source        string
	lrclibID      int64
	plain, synced string
	offset        int64
}

func (s *Server) userChoice(uid, tid string) (*choiceRow, error) {
	var c choiceRow
	err := s.db.QueryRow(`SELECT source, lrclib_id, plain, synced, offset_ms FROM lyrics_choices WHERE user_id = ? AND track_id = ?`, uid, tid).
		Scan(&c.source, &c.lrclibID, &c.plain, &c.synced, &c.offset)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return &c, err
}

// communityChoice: an LRCLIB entry at least two other users picked for this track.
func (s *Server) communityChoice(uid, tid string) *Lyrics {
	var l Lyrics
	var n int
	err := s.db.QueryRow(`SELECT lrclib_id, MAX(plain), MAX(synced), COUNT(*) AS n FROM lyrics_choices
		WHERE track_id = ? AND user_id != ? AND source = 'lrclib' AND lrclib_id > 0
		GROUP BY lrclib_id ORDER BY n DESC LIMIT 1`, tid, uid).Scan(&l.LrclibID, &l.Plain, &l.Synced, &n)
	if err != nil || n < 2 {
		return nil
	}
	l.Source, l.Choice = "lrclib", "community"
	return &l
}

// lyricsFor resolves what one user sees: their own choice, else what several
// others picked (when Vang's automatic lookup found nothing or something
// else), else the automatic result. ok=false: nothing looked up yet.
func (s *Server) lyricsFor(uid, tid string) (*Lyrics, bool, error) {
	c, err := s.userChoice(uid, tid)
	if err != nil {
		return nil, false, err
	}
	shared, err := s.sharedLyrics(tid)
	if err != nil {
		return nil, false, err
	}
	if c != nil && c.source != "auto" {
		return &Lyrics{Plain: c.plain, Synced: c.synced, Source: c.source, OffsetMs: c.offset, LrclibID: c.lrclibID, Choice: "mine"}, true, nil
	}
	var l *Lyrics
	if comm := s.communityChoice(uid, tid); comm != nil && (shared == nil || shared.LrclibID != comm.LrclibID) {
		l = comm
	} else if shared != nil {
		l = shared
	}
	if l == nil {
		return nil, false, nil
	}
	if c != nil { // only an offset of their own
		l.OffsetMs = c.offset
	}
	return l, true, nil
}

func (s *Server) saveChoice(uid, tid string, c choiceRow) error {
	_, err := s.db.Exec(`INSERT INTO lyrics_choices(user_id, track_id, source, lrclib_id, plain, synced, offset_ms, updated_at) VALUES (?,?,?,?,?,?,?,?)
		ON CONFLICT(user_id, track_id) DO UPDATE SET source=excluded.source, lrclib_id=excluded.lrclib_id, plain=excluded.plain,
		synced=excluded.synced, offset_ms=excluded.offset_ms, updated_at=excluded.updated_at`,
		uid, tid, c.source, c.lrclibID, c.plain, c.synced, c.offset, nowMs())
	return err
}

func (s *Server) fetchShared(ctx context.Context, t *Track) (*Lyrics, error) {
	it, err := s.lrc.Find(ctx, t.Title, t.Artist, float64(t.DurationMs)/1000)
	l := Lyrics{Source: "none", Choice: "auto"}
	if err == nil {
		l = Lyrics{Plain: it.PlainLyrics, Synced: it.SyncedLyrics, Source: "lrclib", LrclibID: it.ID, Choice: "auto"}
	} else if !errors.Is(err, errNotFound) {
		return nil, err // network trouble: don't cache a miss
	}
	if err := s.saveShared(t.ID, l); err != nil {
		return nil, err
	}
	s.refineLang(t.ID, l.Plain)
	return &l, nil
}

// refineLang uses the lyrics to settle a track's language when the title
// alone couldn't (an English title, a title without diacritics). An English
// guess stays when the lyrics are English too; the artist's other songs still
// decide in the end (resolveLangs), so English songs by V-pop artists remain
// with V-pop.
func (s *Server) refineLang(trackID, lyrics string) {
	if len(lyrics) < 80 {
		return
	}
	got := textutil.DetectLang(lyrics, "")
	if got == "" || got == textutil.LangEN {
		return
	}
	s.db.Exec(`UPDATE tracks SET lang = ? WHERE id = ? AND lang IN ('', 'en', 'zh')`, got, trackID)
}

// ── handlers ────────────────────────────────────────────────────────────

func (s *Server) lyricsTrack(w http.ResponseWriter, r *http.Request) *Track {
	t, err := s.getTrack(userOf(r).ID, r.PathValue("id"))
	if errors.Is(err, errNotFound) {
		httpError(w, http.StatusNotFound, "Không có bài này")
		return nil
	} else if err != nil {
		s.internalError(w, r, err)
		return nil
	}
	return t
}

// handleGetLyrics returns the user's lyrics, looking them up on LRCLIB the first time.
func (s *Server) handleGetLyrics(w http.ResponseWriter, r *http.Request) {
	t := s.lyricsTrack(w, r)
	if t == nil {
		return
	}
	uid := userOf(r).ID
	l, ok, err := s.lyricsFor(uid, t.ID)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if !ok {
		if _, err := s.fetchShared(r.Context(), t); err != nil {
			s.log.Warn("lyrics lookup failed", "track", t.ID, "err", err)
			httpError(w, http.StatusBadGateway, "Không kết nối được nguồn lời bài hát")
			return
		}
		l, _, err = s.lyricsFor(uid, t.ID)
		if err != nil {
			s.internalError(w, r, err)
			return
		}
	}
	writeJSON(w, http.StatusOK, l)
}

// handleSearchLyrics retries the automatic lookup for everyone ("Tìm lại").
func (s *Server) handleSearchLyrics(w http.ResponseWriter, r *http.Request) {
	t := s.lyricsTrack(w, r)
	if t == nil {
		return
	}
	if _, err := s.fetchShared(r.Context(), t); err != nil {
		httpError(w, http.StatusBadGateway, "Không kết nối được nguồn lời bài hát")
		return
	}
	l, _, err := s.lyricsFor(userOf(r).ID, t.ID)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, l)
}

type lyricsCandidate struct {
	ID          int64   `json:"id"`
	Title       string  `json:"title"`
	Artist      string  `json:"artist"`
	Album       string  `json:"album"`
	DurationSec float64 `json:"durationSec"`
	Synced      bool    `json:"synced"`
	Preview     string  `json:"preview"` // first lines
	Picks       int     `json:"picks"`   // users of this server who picked it for this track
	DurationOK  bool    `json:"durationOk"`
}

// handleLyricsCandidates searches LRCLIB with the user's own words, so a song
// whose title or artist is written differently can still get lyrics.
func (s *Server) handleLyricsCandidates(w http.ResponseWriter, r *http.Request) {
	t := s.lyricsTrack(w, r)
	if t == nil {
		return
	}
	q := r.URL.Query()
	title, artist, free := strings.TrimSpace(q.Get("title")), strings.TrimSpace(q.Get("artist")), strings.TrimSpace(q.Get("q"))
	if title == "" && artist == "" && free == "" {
		title, artist = baseTitle(t.Title), splitArtists(t.Artist)[0]
	}
	if len(title)+len(artist)+len(free) > 300 {
		httpError(w, http.StatusBadRequest, "Từ khoá quá dài")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	list, err := s.lrc.Search(ctx, title, artist, free)
	if err != nil {
		httpError(w, http.StatusBadGateway, "Không kết nối được nguồn lời bài hát")
		return
	}
	picks := map[int64]int{}
	if rows, err := s.db.Query(`SELECT lrclib_id, COUNT(*) FROM lyrics_choices WHERE track_id = ? AND lrclib_id > 0 GROUP BY lrclib_id`, t.ID); err == nil {
		for rows.Next() {
			var id int64
			var n int
			if rows.Scan(&id, &n) == nil {
				picks[id] = n
			}
		}
		rows.Close()
	}
	dur := float64(t.DurationMs) / 1000
	out := []lyricsCandidate{}
	for _, it := range list {
		if it.PlainLyrics == "" && it.SyncedLyrics == "" {
			continue
		}
		prev := it.PlainLyrics
		if prev == "" {
			prev = stripLRC(it.SyncedLyrics)
		}
		lines := strings.Split(strings.TrimSpace(prev), "\n")
		if len(lines) > 4 {
			lines = lines[:4]
		}
		out = append(out, lyricsCandidate{
			ID: it.ID, Title: it.TrackName, Artist: it.ArtistName, Album: it.AlbumName, DurationSec: it.Duration,
			Synced: it.SyncedLyrics != "", Preview: strings.Join(lines, "\n"), Picks: picks[it.ID],
			DurationOK: dur == 0 || math.Abs(it.Duration-dur) <= 4,
		})
		if len(out) == 20 {
			break
		}
	}
	// Most picked first, then matching length, then synced.
	rank := func(c lyricsCandidate) int {
		v := c.Picks * 10
		if c.DurationOK {
			v += 5
		}
		if c.Synced {
			v += 2
		}
		return v
	}
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && rank(out[j]) > rank(out[j-1]); j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"results": out, "query": map[string]string{"title": title, "artist": artist, "q": free}})
}

var lrcLineRe = regexp.MustCompile(`(?m)^\s*\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\]`)

// handlePutLyrics saves this user's choice: an LRCLIB entry (lrclibId), pasted
// text (LRC detected), an offset, or reset=true to go back to the automatic ones.
func (s *Server) handlePutLyrics(w http.ResponseWriter, r *http.Request) {
	t := s.lyricsTrack(w, r)
	if t == nil {
		return
	}
	uid := userOf(r).ID
	var body struct {
		Text     *string `json:"text"`
		LrclibID *int64  `json:"lrclibId"`
		OffsetMs *int64  `json:"offsetMs"`
		Reset    bool    `json:"reset"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	if body.Reset {
		s.db.Exec(`DELETE FROM lyrics_choices WHERE user_id = ? AND track_id = ?`, uid, t.ID)
	} else {
		cur, _, err := s.lyricsFor(uid, t.ID)
		if err != nil {
			s.internalError(w, r, err)
			return
		}
		c := choiceRow{source: "auto"}
		if old, _ := s.userChoice(uid, t.ID); old != nil {
			c = *old
		} else if cur != nil {
			c.offset = cur.OffsetMs
		}
		switch {
		case body.LrclibID != nil:
			ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
			it, err := s.lrc.ByID(ctx, *body.LrclibID)
			cancel()
			if err != nil {
				httpError(w, http.StatusBadGateway, "Không lấy được lời này từ LRCLIB")
				return
			}
			c = choiceRow{source: "lrclib", lrclibID: it.ID, plain: it.PlainLyrics, synced: it.SyncedLyrics, offset: 0}
		case body.Text != nil:
			text := strings.TrimSpace(*body.Text)
			if len(text) > 100_000 {
				httpError(w, http.StatusBadRequest, "Lời quá dài")
				return
			}
			c.source, c.lrclibID = "manual", 0
			if lrcLineRe.MatchString(text) {
				c.synced, c.plain = text, stripLRC(text)
			} else {
				c.synced, c.plain = "", text
			}
			if text == "" {
				c = choiceRow{source: "auto", offset: c.offset}
			}
		}
		if body.OffsetMs != nil {
			c.offset = max(-30000, min(*body.OffsetMs, 30000))
		}
		if err := s.saveChoice(uid, t.ID, c); err != nil {
			s.internalError(w, r, err)
			return
		}
	}
	l, ok, err := s.lyricsFor(uid, t.ID)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if !ok {
		l = &Lyrics{Source: "none", Choice: "auto"}
	}
	writeJSON(w, http.StatusOK, l)
}

var lrcTagRe = regexp.MustCompile(`\[[^\]]*\]`)

func stripLRC(s string) string {
	lines := strings.Split(s, "\n")
	out := make([]string, 0, len(lines))
	for _, ln := range lines {
		ln = strings.TrimSpace(lrcTagRe.ReplaceAllString(ln, ""))
		out = append(out, ln)
	}
	return strings.TrimSpace(strings.Join(out, "\n"))
}
