package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"

	"vang/internal/textutil"
)

// External music metadata for tier-1 recommendations. Deezer's public API
// needs no key and covers Vietnamese artists well; when a Last.fm key is set
// in Settings, Last.fm's weighted similar-artists list is used instead.
// Responses are cached in ext_cache so the APIs are hit rarely.

type ExtArtist struct {
	Name  string  `json:"name"`
	Image string  `json:"image"`
	Match float64 `json:"match"` // 0..1
}

type ExtTrack struct {
	Title       string `json:"title"`
	Artist      string `json:"artist"`
	DurationSec int    `json:"durationSec"`
	Image       string `json:"image"`
}

type extClient struct {
	s    *Server
	hc   *http.Client
	mu   sync.Mutex
	next time.Time
}

func newExtClient(s *Server) *extClient {
	return &extClient{s: s, hc: &http.Client{Timeout: 10 * time.Second}}
}

const (
	extTTL     = 7 * 24 * time.Hour
	extMissTTL = 24 * time.Hour
)

var errExtUnavailable = errors.New("nguồn đề xuất bên ngoài tạm không truy cập được")

// cached returns the cached value for key, or calls fetch and caches the result.
// cacheOnly=true never touches the network (used on hot paths like the home page).
func (e *extClient) cached(ctx context.Context, key string, cacheOnly bool, out any, fetch func(context.Context) (any, error)) (bool, error) {
	var raw string
	var at int64
	err := e.s.db.QueryRow(`SELECT json, fetched_at FROM ext_cache WHERE key = ?`, key).Scan(&raw, &at)
	if err == nil {
		age := time.Since(time.UnixMilli(at))
		empty := raw == "null" || raw == "[]"
		if (!empty && age < extTTL) || (empty && age < extMissTTL) || cacheOnly {
			return true, json.Unmarshal([]byte(raw), out)
		}
	} else if !errors.Is(err, sql.ErrNoRows) {
		return false, err
	} else if cacheOnly {
		return false, nil
	}
	v, err := fetch(ctx)
	if err != nil {
		return false, err
	}
	b, _ := json.Marshal(v)
	e.s.db.Exec(`INSERT INTO ext_cache(key, json, fetched_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET json=excluded.json, fetched_at=excluded.fetched_at`,
		key, string(b), nowMs())
	return true, json.Unmarshal(b, out)
}

func (e *extClient) getJSON(ctx context.Context, u string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "RiiMusic self-hosted music player")
	// One request at a time, ~4/s at most: polite to free APIs. Only the HTTP
	// call is locked, since fetchers nest (similar → artist id lookup).
	e.mu.Lock()
	time.Sleep(time.Until(e.next))
	e.next = time.Now().Add(250 * time.Millisecond)
	e.mu.Unlock()
	res, err := e.hc.Do(req)
	if err != nil {
		return fmt.Errorf("%w: %v", errExtUnavailable, err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("%w: %s", errExtUnavailable, res.Status)
	}
	return json.NewDecoder(res.Body).Decode(out)
}

// Similar returns artists similar to name. Errors are not cached.
func (e *extClient) Similar(ctx context.Context, name string, cacheOnly bool) ([]ExtArtist, error) {
	key := e.provider() + "2:similar:" + textutil.Fold(name) // v2: with artist pictures
	var out []ExtArtist
	_, err := e.cached(ctx, key, cacheOnly, &out, func(ctx context.Context) (any, error) {
		if k := e.s.cfg.LastfmKey; k != "" {
			return e.lastfmSimilar(ctx, k, name)
		}
		return e.deezerSimilar(ctx, name)
	})
	return out, err
}

// TopTracks returns an artist's popular tracks (Deezer, which has covers).
func (e *extClient) TopTracks(ctx context.Context, name string, cacheOnly bool) ([]ExtTrack, error) {
	var out []ExtTrack
	_, err := e.cached(ctx, "deezer:top:"+textutil.Fold(name), cacheOnly, &out, func(ctx context.Context) (any, error) {
		return e.deezerTop(ctx, name)
	})
	return out, err
}

func (e *extClient) provider() string {
	if e.s.cfg.LastfmKey != "" {
		return "lastfm"
	}
	return "deezer"
}

// ── Deezer ──────────────────────────────────────────────────────────────

type dzArtist struct {
	ID      int64  `json:"id"`
	Name    string `json:"name"`
	Picture string `json:"picture_medium"`
	NbFan   int    `json:"nb_fan"`
}

// deezerArtist resolves an artist name to a Deezer artist, refusing fuzzy
// matches so a similarly named stranger is not used.
func (e *extClient) deezerArtist(ctx context.Context, name string, cacheOnly bool) (dzArtist, error) {
	var a dzArtist
	_, err := e.cached(ctx, "deezer:artist:"+textutil.Fold(name), cacheOnly, &a, func(ctx context.Context) (any, error) {
		var r struct {
			Data []dzArtist `json:"data"`
		}
		if err := e.getJSON(ctx, "https://api.deezer.com/search/artist?limit=5&q="+url.QueryEscape(name), &r); err != nil {
			return nil, err
		}
		want := looseName(name)
		for _, a := range r.Data {
			if looseName(a.Name) == want {
				return a, nil
			}
		}
		return dzArtist{}, nil
	})
	return a, err
}

func (e *extClient) deezerArtistID(ctx context.Context, name string) (int64, error) {
	a, err := e.deezerArtist(ctx, name, false)
	return a.ID, err
}

// ArtistImage: a picture of the artist (Deezer); "" when unknown.
func (e *extClient) ArtistImage(ctx context.Context, name string, cacheOnly bool) string {
	a, _ := e.deezerArtist(ctx, name, cacheOnly)
	return a.Picture
}

func (e *extClient) deezerSimilar(ctx context.Context, name string) ([]ExtArtist, error) {
	id, err := e.deezerArtistID(ctx, name)
	if err != nil || id == 0 {
		return []ExtArtist{}, err
	}
	var r struct {
		Data []dzArtist `json:"data"`
	}
	if err := e.getJSON(ctx, fmt.Sprintf("https://api.deezer.com/artist/%d/related?limit=20", id), &r); err != nil {
		return nil, err
	}
	out := make([]ExtArtist, 0, len(r.Data))
	for i, a := range r.Data {
		// Deezer gives an ordered list without scores: decay by rank.
		out = append(out, ExtArtist{Name: a.Name, Image: a.Picture, Match: 1 - float64(i)/float64(len(r.Data)+1)})
	}
	return out, nil
}

func (e *extClient) deezerTop(ctx context.Context, name string) ([]ExtTrack, error) {
	id, err := e.deezerArtistID(ctx, name)
	if err != nil || id == 0 {
		return []ExtTrack{}, err
	}
	var r struct {
		Data []struct {
			Title    string `json:"title"`
			Duration int    `json:"duration"`
			Artist   struct {
				Name string `json:"name"`
			} `json:"artist"`
			Album struct {
				Cover string `json:"cover_medium"`
			} `json:"album"`
		} `json:"data"`
	}
	if err := e.getJSON(ctx, fmt.Sprintf("https://api.deezer.com/artist/%d/top?limit=10", id), &r); err != nil {
		return nil, err
	}
	out := []ExtTrack{}
	for _, t := range r.Data {
		out = append(out, ExtTrack{Title: t.Title, Artist: t.Artist.Name, DurationSec: t.Duration, Image: t.Album.Cover})
	}
	return out, nil
}

// ── Last.fm ─────────────────────────────────────────────────────────────

func (e *extClient) lastfmSimilar(ctx context.Context, key, name string) ([]ExtArtist, error) {
	q := url.Values{"method": {"artist.getsimilar"}, "artist": {name}, "api_key": {key}, "format": {"json"}, "limit": {"20"}, "autocorrect": {"1"}}
	var r struct {
		Error   int    `json:"error"`
		Message string `json:"message"`
		Similar struct {
			Artist []struct {
				Name  string `json:"name"`
				Match string `json:"match"`
			} `json:"artist"`
		} `json:"similarartists"`
	}
	if err := e.getJSON(ctx, "https://ws.audioscrobbler.com/2.0/?"+q.Encode(), &r); err != nil {
		return nil, err
	}
	if r.Error == 6 { // artist not found
		return []ExtArtist{}, nil
	}
	if r.Error != 0 {
		return nil, fmt.Errorf("%w: Last.fm %s", errExtUnavailable, r.Message)
	}
	// Last.fm stopped serving artist pictures in 2019: take them from Deezer.
	out := []ExtArtist{}
	for i, a := range r.Similar.Artist {
		var m float64
		fmt.Sscanf(a.Match, "%g", &m)
		img := ""
		if i < 16 {
			img = e.ArtistImage(ctx, a.Name, false)
		}
		out = append(out, ExtArtist{Name: a.Name, Match: m, Image: img})
	}
	return out, nil
}

// ── name helpers ────────────────────────────────────────────────────────

var artistSplitRe = regexp.MustCompile(`(?i)\s*(?:,|&|/|;|\bft\.?|\bfeat\.?|\bfeaturing\b|\sx\s|\swith\s)\s*`)

// splitArtists turns "A, B ft. C" into ["A", "B", "C"].
func splitArtists(s string) []string {
	out := []string{}
	for _, p := range artistSplitRe.Split(s, -1) {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

var looseRe = regexp.MustCompile(`[^a-z0-9]+`)

// looseName folds accents, case and punctuation: "SƠN TÙNG M-TP" == "Son Tung M-TP".
func looseName(s string) string {
	return looseRe.ReplaceAllString(textutil.Fold(s), "")
}
