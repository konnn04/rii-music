package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"rii_music/internal/textutil"
)

// Background enrichment of shared tracks, one at a time and slowly, so a small
// server stays quiet and songs are playable the moment they are downloaded:
//
//  1. Lyrics into the file: find the lyrics (LRCLIB) and write them into the
//     audio file's tags with an ffmpeg stream copy (no re-encode), replacing
//     the file. Runs again when the shared lyrics change.
//  2. Genres / tags: Deezer album genres (no key needed), plus Last.fm track
//     tags when LASTFM_API_KEY is set. Used by "theo thể loại" smart playlists.
//  3. Names: songs whose title / artist were guessed from a video title are
//     looked up on MusicBrainz (1 request / s, as they ask); a near-certain
//     match replaces the guess.

var enrichKickCh = make(chan struct{}, 1)

func (s *Server) enrichKick() {
	select {
	case enrichKickCh <- struct{}{}:
	default:
	}
}

func (s *Server) runEnrichWorker(ctx context.Context) {
	tick := time.NewTicker(5 * time.Minute)
	defer tick.Stop()
	retry := time.NewTicker(time.Hour)
	defer retry.Stop()
	// Let startup (migrations, yt-dlp) settle first.
	select {
	case <-ctx.Done():
		return
	case <-time.After(20 * time.Second):
	}
	for {
		for ctx.Err() == nil {
			did := s.embedNextLyrics(ctx) || s.tagNextTrack(ctx) || s.checkNextName(ctx)
			if !did {
				break
			}
			time.Sleep(time.Second)
		}
		select {
		case <-ctx.Done():
			return
		case <-enrichKickCh:
		case <-tick.C:
		case <-retry.C:
			// Retry what failed for a passing reason (file busy, service down).
			s.db.Exec(`UPDATE tracks SET lyrics_embedded = 0 WHERE lyrics_embedded = -2`)
			s.db.Exec(`UPDATE tracks SET genres_done = 0 WHERE genres_done = -1`)
			s.db.Exec(`UPDATE tracks SET mb_done = 0 WHERE mb_done = -1`)
		}
	}
}

// ── 1. lyrics into the file ──────────────────────────────────────────────

func (s *Server) embedNextLyrics(ctx context.Context) bool {
	t, err := s.nextTrack(`lyrics_embedded = 0`)
	if err != nil {
		return false
	}
	l, err := s.sharedLyrics(t.ID)
	if err != nil || l == nil {
		lctx, cancel := context.WithTimeout(ctx, 20*time.Second)
		l, err = s.fetchShared(lctx, t.Track)
		cancel()
		if err != nil {
			// LRCLIB unreachable: try again on a later round.
			s.db.Exec(`UPDATE tracks SET lyrics_embedded = -2 WHERE id = ?`, t.ID)
			return true
		}
	}
	text := l.Synced
	if text == "" {
		text = l.Plain
	}
	if strings.TrimSpace(text) == "" {
		s.db.Exec(`UPDATE tracks SET lyrics_embedded = -1 WHERE id = ?`, t.ID)
		return true
	}
	path := filepath.Join(s.cfg.DataDir, filepath.FromSlash(t.filePath))
	size, err := embedLyrics(ctx, s.cfg.FFmpeg, path, text)
	if err != nil {
		s.log.Debug("embed lyrics", "track", t.ID, "err", err)
		s.db.Exec(`UPDATE tracks SET lyrics_embedded = -2 WHERE id = ?`, t.ID) // busy (being streamed on Windows) or ffmpeg failed
		return true
	}
	s.db.Exec(`UPDATE tracks SET lyrics_embedded = 1, size_bytes = ? WHERE id = ?`, size, t.ID)
	return true
}

// fileLocks: never rewrite one file twice at once.
var fileLocks sync.Map

// embedLyrics writes text into the file's lyrics tag (m4a ©lyr, Opus/Ogg
// LYRICS) with a stream copy, then swaps the new file in.
func embedLyrics(ctx context.Context, ffmpeg, path, text string) (int64, error) {
	mu, _ := fileLocks.LoadOrStore(path, &sync.Mutex{})
	mu.(*sync.Mutex).Lock()
	defer mu.(*sync.Mutex).Unlock()
	ext := filepath.Ext(path)
	tmp := strings.TrimSuffix(path, ext) + ".lyrics" + ext
	key := "lyrics"
	if ext == ".opus" || ext == ".ogg" {
		key = "LYRICS"
	}
	cctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(cctx, ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", path,
		"-map", "0", "-c", "copy", "-map_metadata", "0", "-metadata", key+"="+text, tmp)
	if out, err := cmd.CombinedOutput(); err != nil {
		os.Remove(tmp)
		return 0, fmt.Errorf("ffmpeg: %v: %s", err, strings.TrimSpace(string(out)))
	}
	st, err := os.Stat(tmp)
	if err != nil || st.Size() == 0 {
		os.Remove(tmp)
		return 0, errors.New("ffmpeg wrote nothing")
	}
	if err := os.Rename(tmp, path); err != nil {
		os.Remove(tmp)
		return 0, err
	}
	return st.Size(), nil
}

// ── 2. genres / tags ────────────────────────────────────────────────────

func (s *Server) tagNextTrack(ctx context.Context) bool {
	t, err := s.nextTrack(`genres_done = 0`)
	if err != nil {
		return false
	}
	gctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	tags, err := s.ext.trackGenres(gctx, t.Artist, t.Title)
	if errors.Is(err, errRateLimited) {
		// Paused by the service: stop this round (the song stays pending) and
		// come back when the pause is over.
		s.enrichResumeAfterLimit()
		return false
	}
	if err != nil && ctx.Err() == nil {
		// Service unavailable: leave it for a later round (but don't spin on it now).
		s.db.Exec(`UPDATE tracks SET genres_done = -1 WHERE id = ?`, t.ID)
		return true
	}
	s.db.Exec(`UPDATE tracks SET genres = ?, genres_done = 1 WHERE id = ?`, strings.Join(tags, ","), t.ID)
	return true
}

func splitGenres(s string) []string {
	out := []string{}
	for _, g := range strings.Split(s, ",") {
		if g = strings.TrimSpace(g); g != "" {
			out = append(out, g)
		}
	}
	return out
}

// trackGenres: Deezer album genres for the song, plus the top Last.fm tags.
func (e *extClient) trackGenres(ctx context.Context, artist, title string) ([]string, error) {
	var out []string
	// v3: Last.fm artist tags when the song has none; rate limits are errors (retried), not "no tags".
	_, err := e.cached(ctx, "genres3:"+textutil.Fold(artist)+"|"+textutil.Fold(title), false, &out, func(ctx context.Context) (any, error) {
		set := map[string]int{}
		add := func(g string, w int) {
			g = strings.ToLower(strings.TrimSpace(g))
			if g != "" && len(g) <= 40 {
				set[g] += w
			}
		}
		var sr struct {
			Data []struct {
				Artist struct {
					Name string `json:"name"`
				} `json:"artist"`
				Album struct {
					ID int64 `json:"id"`
				} `json:"album"`
			} `json:"data"`
		}
		// Plain search: Deezer's artist:"…" track:"…" syntax misses Vietnamese names.
		q := firstArtist(artist) + " " + baseTitle(title)
		if err := e.getJSON(ctx, "https://api.deezer.com/search?limit=5&q="+url.QueryEscape(q), &sr); err != nil {
			return nil, err
		}
		albumID := int64(0)
		for _, d := range sr.Data {
			if d.Album.ID > 0 && (hasArtist(artist, looseName(d.Artist.Name)) || looseName(d.Artist.Name) == looseName(firstArtist(artist))) {
				albumID = d.Album.ID
				break
			}
		}
		if albumID > 0 {
			var al struct {
				Genres struct {
					Data []struct {
						Name string `json:"name"`
					} `json:"data"`
				} `json:"genres"`
			}
			if err := e.getJSON(ctx, fmt.Sprintf("https://api.deezer.com/album/%d", albumID), &al); err == nil {
				for _, g := range al.Genres.Data {
					add(g.Name, 100)
				}
			}
		}
		if k := e.s.cfg.LastfmKey; k != "" {
			var lf struct {
				TopTags struct {
					Tag []struct {
						Name  string `json:"name"`
						Count int    `json:"count"`
					} `json:"tag"`
				} `json:"toptags"`
			}
			u := "https://ws.audioscrobbler.com/2.0/?method=track.gettoptags&format=json&autocorrect=1&api_key=" + url.QueryEscape(k) +
				"&artist=" + url.QueryEscape(firstArtist(artist)) + "&track=" + url.QueryEscape(baseTitle(title))
			trackTags := 0
			if err := e.getJSON(ctx, u, &lf); err == nil {
				for i, tg := range lf.TopTags.Tag {
					if i >= 6 || tg.Count < 10 {
						break
					}
					add(tg.Name, tg.Count)
					trackTags++
				}
			} else if errors.Is(err, errRateLimited) {
				return nil, err
			}
			// Many songs (V-pop especially) have no tags of their own: the artist's.
			if trackTags == 0 {
				at, err := e.ArtistTags(ctx, firstArtist(artist), false)
				if errors.Is(err, errRateLimited) {
					return nil, err
				}
				for i, tg := range at {
					add(tg, 60-i*6)
				}
			}
		}
		tags := make([]string, 0, len(set))
		for g := range set {
			tags = append(tags, g)
		}
		sort.Slice(tags, func(i, j int) bool {
			return set[tags[i]] > set[tags[j]] || (set[tags[i]] == set[tags[j]] && tags[i] < tags[j])
		})
		if len(tags) > 6 {
			tags = tags[:6]
		}
		return tags, nil
	})
	return out, err
}

func firstArtist(s string) string {
	if a := splitArtists(s); len(a) > 0 {
		return a[0]
	}
	return s
}

// ── 3. names from MusicBrainz ────────────────────────────────────────────

var mbNext time.Time
var mbMu sync.Mutex

func (s *Server) checkNextName(ctx context.Context) bool {
	t, err := s.nextTrack(`mb_done = 0 AND meta_source = 'heuristic'`)
	if err != nil {
		return false
	}
	mctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	m, err := s.musicBrainzMatch(mctx, t.Artist, t.Title, t.DurationMs)
	if err != nil {
		s.log.Warn("MusicBrainz", "track", t.ID, "err", err)
		s.db.Exec(`UPDATE tracks SET mb_done = -1 WHERE id = ?`, t.ID) // retried within the hour
		return true
	}
	if m == nil {
		s.db.Exec(`UPDATE tracks SET mb_done = 1 WHERE id = ?`, t.ID)
		return true
	}
	album := t.Album
	if album == "" {
		album = m.album
	}
	s.db.Exec(`UPDATE tracks SET title = ?, artist = ?, album = ?, search = ?, meta_source = 'musicbrainz', mb_done = 1 WHERE id = ?`,
		m.title, m.artist, album, searchText(m.title, m.artist, album), t.ID)
	s.log.Info("tên bài theo MusicBrainz", "track", t.ID, "from", t.Artist+" - "+t.Title, "to", m.artist+" - "+m.title)
	s.hub.PublishAll("library", map[string]string{"id": t.ID})
	return true
}

type mbMatch struct{ title, artist, album string }

// musicBrainzMatch returns a recording only when it is near certain: top
// score, same artist (accents / case aside) and about the same length.
func (s *Server) musicBrainzMatch(ctx context.Context, artist, title string, durMs int64) (*mbMatch, error) {
	if artist == "" || title == "" {
		return nil, nil
	}
	q := fmt.Sprintf(`recording:"%s" AND artist:"%s"`, mbEscape(baseTitle(title)), mbEscape(firstArtist(artist)))
	var res struct {
		Recordings []struct {
			Score        int    `json:"score"`
			Title        string `json:"title"`
			Length       int64  `json:"length"`
			ArtistCredit []struct {
				Name       string `json:"name"`
				JoinPhrase string `json:"joinphrase"`
			} `json:"artist-credit"`
			Releases []struct {
				Title string `json:"title"`
			} `json:"releases"`
		} `json:"recordings"`
	}
	mbMu.Lock()
	time.Sleep(time.Until(mbNext))
	mbNext = time.Now().Add(1100 * time.Millisecond) // MusicBrainz: at most 1 request per second
	mbMu.Unlock()
	u := "https://musicbrainz.org/ws/2/recording?fmt=json&limit=3&query=" + url.QueryEscape(q)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "RiiMusic/"+Version+" (self-hosted music player)")
	resp, err := s.ext.hc.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("musicbrainz: %s", resp.Status)
	}
	if err := json.NewDecoder(resp.Body).Decode(&res); err != nil {
		return nil, err
	}
	for _, r := range res.Recordings {
		if r.Score < 95 {
			break
		}
		var credit strings.Builder
		for _, c := range r.ArtistCredit {
			credit.WriteString(c.Name + c.JoinPhrase)
		}
		a := strings.TrimSpace(credit.String())
		if !hasArtist(a, looseName(firstArtist(artist))) && looseName(a) != looseName(artist) {
			continue
		}
		if durMs > 0 && r.Length > 0 && abs64(durMs-r.Length) > 15000 {
			continue
		}
		if looseName(r.Title) != looseName(baseTitle(title)) && !strings.Contains(looseName(title), looseName(r.Title)) {
			continue
		}
		m := &mbMatch{title: r.Title, artist: a}
		if len(r.Releases) > 0 {
			m.album = r.Releases[0].Title
		}
		return m, nil
	}
	return nil, nil
}

func mbEscape(s string) string {
	return strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(s)
}

// ── shared ───────────────────────────────────────────────────────────────

type enrichTrack struct {
	*Track
	filePath string
}

// nextTrack picks the newest track matching cond (only tracks someone has).
func (s *Server) nextTrack(cond string) (*enrichTrack, error) {
	var t Track
	var path string
	err := s.db.QueryRow(`SELECT t.id, t.title, t.artist, t.album, t.duration_ms, t.file_path FROM tracks t
		WHERE `+cond+` AND EXISTS (SELECT 1 FROM user_tracks ut WHERE ut.track_id = t.id)
		ORDER BY t.added_at DESC LIMIT 1`).Scan(&t.ID, &t.Title, &t.Artist, &t.Album, &t.DurationMs, &path)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	if err != nil {
		return nil, err
	}
	return &enrichTrack{Track: &t, filePath: path}, nil
}

// handleGenres lists the genres / tags in the user's library with how many songs each.
func (s *Server) handleGenres(w http.ResponseWriter, r *http.Request) {
	all, err := s.libTracks(userOf(r).ID, ``)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	n := map[string]int{}
	for _, t := range all {
		for _, g := range t.Genres {
			n[g]++
		}
	}
	type genre struct {
		Name  string `json:"name"`
		Count int    `json:"count"`
	}
	out := []genre{}
	for g, c := range n {
		out = append(out, genre{g, c})
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].Count > out[j].Count || (out[i].Count == out[j].Count && out[i].Name < out[j].Name)
	})
	writeJSON(w, http.StatusOK, out)
}
