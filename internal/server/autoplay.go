package server

import (
	"context"
	"math"
	"math/rand/v2"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"vang/internal/textutil"
)

// AutoExt is a suggestion that is not in the library yet: a YouTube Music song
// the client downloads in the background before it is due.
type AutoExt struct {
	VideoID     string  `json:"videoId"`
	Title       string  `json:"title"`
	Artist      string  `json:"artist"`
	DurationSec float64 `json:"durationSec"`
	Thumbnail   string  `json:"thumbnail"`
	URL         string  `json:"url"`
	Reason      string  `json:"reason"`
}

// handleAutoplay feeds "Tự động gợi ý phát" with up to `ext` songs from the
// seed's artists or similar ones that are not downloaded yet. (Library tracks
// come from /api/radio.)
func (s *Server) handleAutoplay(w http.ResponseWriter, r *http.Request) {
	uid := userOf(r).ID
	seed, err := s.getTrack(uid, r.URL.Query().Get("seed"))
	if err != nil {
		httpError(w, http.StatusNotFound, "Không có bài này")
		return
	}
	nExt, _ := strconv.Atoi(r.URL.Query().Get("ext"))
	nExt = max(0, min(nExt, 6))
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	rc, err := s.newRecCtx(ctx, uid, false)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	var ext []AutoExt
	if nExt > 0 {
		ext = s.autoplayExternal(ctx, rc, seed, nExt)
	}
	if ext == nil {
		ext = []AutoExt{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"external": ext})
}

type autoCand struct {
	artist, title, reason string
	weight                float64
}

// artW is a candidate artist with a sampling weight and a reason to show.
type artW struct {
	name, reason string
	w            float64
}

func (s *Server) autoplayExternal(ctx context.Context, rc *recCtx, seed *Track, n int) []AutoExt {
	rng := rand.New(rand.NewPCG(uint64(time.Now().UnixNano()), hashSeed(seed.ID)))
	// Candidate artists: the seed's own (weight 1) and similar ones (their match).
	var arts []artW
	seen := map[string]bool{}
	for _, a := range splitArtists(seed.Artist) {
		k := looseName(a)
		if k == "" || seen[k] || rc.taste.dislikedArt[k] {
			continue
		}
		seen[k] = true
		arts = append(arts, artW{a, "Cùng nghệ sĩ " + a, 1})
		sim, _ := s.ext.Similar(ctx, a, false)
		for i, x := range sim {
			kx := looseName(x.Name)
			if i >= 8 || seen[kx] || rc.taste.dislikedArt[kx] {
				continue
			}
			seen[kx] = true
			arts = append(arts, artW{x.Name, "Giống " + a, 0.3 + 0.6*x.Match})
		}
	}
	if len(arts) == 0 {
		return nil
	}
	return s.externalFromArtists(ctx, rc, arts, n, rng, rc.lang[seed.ID])
}

// externalFromArtists samples artists by weight, takes top tracks the library
// lacks and resolves them to YouTube Music songs; at most n results.
// wantLang: only songs in that language (autoplay keeps the seed's); ""
// means any language the user listens to.
func (s *Server) externalFromArtists(ctx context.Context, rc *recCtx, arts []artW, n int, rng *rand.Rand, wantLang string) []AutoExt {
	// What we already have, by title+artist and by YouTube id. Titles are
	// compared loosely: the library holds "MV ĐỪNG NHƯ THÓI QUEN" where the
	// suggestion says "Đừng Như Thói Quen".
	// Tracks removed in the last 90 days (by hand or by the storage limit)
	// count as "have": don't download them again.
	removed := []Track{}
	haveVid := map[string]bool{}
	if rows, err := s.db.Query(`SELECT source_id, artist, title FROM removed_tracks WHERE user_id = ? AND removed_at > ?`, rc.uid, time.Now().Add(-90*24*time.Hour).UnixMilli()); err == nil {
		for rows.Next() {
			var t Track
			var sid string
			if rows.Scan(&sid, &t.Artist, &t.Title) == nil {
				haveVid[sid] = true
				removed = append(removed, t)
			}
		}
		rows.Close()
	}
	known := append(append([]Track{}, rc.all...), removed...)
	haveName := func(artist, title string) bool {
		bt := looseName(baseTitle(title))
		if bt == "" {
			return false
		}
		for _, t := range known {
			if !looseMatch(t.Artist, artist) && !looseMatch(t.Title, artist) {
				continue // (some library titles carry the artist instead)
			}
			lt, lb := looseName(t.Title), looseName(baseTitle(t.Title))
			if strings.Contains(lt, bt) || len(lb) >= 4 && strings.Contains(bt, lb) {
				return true
			}
		}
		return false
	}
	// The user's own library only: a song someone else downloaded is a fine
	// suggestion (and instant to add).
	if rows, err := s.db.Query(`SELECT t.source_id FROM user_tracks ut JOIN tracks t ON t.id = ut.track_id WHERE ut.user_id = ? AND t.source_id IS NOT NULL`, rc.uid); err == nil {
		for rows.Next() {
			var v string
			if rows.Scan(&v) == nil {
				haveVid[v] = true
			}
		}
		rows.Close()
	}
	// Also skip anything already queued or downloading.
	if rows, err := s.db.Query(`SELECT source_id FROM download_jobs WHERE user_id = ? AND source_id IS NOT NULL AND source_id != '' AND status IN ('queued','downloading','processing')`, rc.uid); err == nil {
		for rows.Next() {
			var v string
			if rows.Scan(&v) == nil {
				haveVid[v] = true
			}
		}
		rows.Close()
	}

	// Pick a few artists by weighted sampling, then their top tracks we lack.
	keys := make([]float64, len(arts))
	for i, a := range arts {
		keys[i] = math.Pow(rng.Float64(), 1/a.w)
	}
	idx := make([]int, len(arts))
	for i := range idx {
		idx[i] = i
	}
	sort.Slice(idx, func(i, j int) bool { return keys[idx[i]] > keys[idx[j]] })

	var cands []autoCand
	for _, i := range idx {
		if len(cands) >= n*3 {
			break
		}
		a := arts[i]
		top, err := s.ext.TopTracks(ctx, a.name, false)
		if err != nil {
			continue
		}
		picked := 0
		for rank, t := range top {
			if picked == 2 || rank >= 10 {
				break
			}
			if haveName(firstNonEmpty(t.Artist, a.name), t.Title) || rng.Float64() < 0.35 {
				continue // already have it, or skip some so repeats differ
			}
			cands = append(cands, autoCand{artist: firstNonEmpty(t.Artist, a.name), title: t.Title, reason: a.reason, weight: a.w})
			picked++
		}
	}

	// Resolve candidates to YouTube Music songs, a few at a time.
	out := make([]AutoExt, 0, n)
	var mu sync.Mutex
	var wg sync.WaitGroup
	sem := make(chan struct{}, 3)
	for _, c := range cands {
		wg.Add(1)
		go func(c autoCand) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			mu.Lock()
			full := len(out) >= n
			mu.Unlock()
			if full {
				return
			}
			res, err := ytmSearch(ctx, s.ext.hc, c.artist+" "+c.title, "songs")
			if err != nil {
				return
			}
			for i, r := range res {
				if i >= 3 {
					break
				}
				if !looseMatch(r.Artist, c.artist) || !looseMatch(baseTitle(r.Title), baseTitle(c.title)) || r.Duration <= 0 || r.Duration > float64(s.cfg.MaxDuration) {
					continue
				}
				if l := textutil.DetectLang(r.Title, r.Artist); (wantLang != "" && !sameLang(wantLang, l)) || (wantLang == "" && !rc.langWanted(l)) {
					return // another language than the user wants here
				}
				mu.Lock()
				if len(out) < n && !haveVid[r.ID] && !haveName(r.Artist, r.Title) {
					haveVid[r.ID] = true
					out = append(out, AutoExt{
						VideoID: r.ID, Title: r.Title, Artist: r.Artist, DurationSec: r.Duration,
						Thumbnail: r.Thumbnail, URL: "https://music.youtube.com/watch?v=" + r.ID, Reason: c.reason,
					})
				}
				mu.Unlock()
				return
			}
		}(c)
	}
	wg.Wait()
	return out
}

var bracketRe = regexp.MustCompile(`\s*[(\[][^)\]]*[)\]]`)

// baseTitle drops "(feat. …)", "(cùng với …)", "[Official]" and the like.
func baseTitle(t string) string {
	if b := strings.TrimSpace(bracketRe.ReplaceAllString(t, "")); b != "" {
		return b
	}
	return t
}

// looseMatch: one folded name contains the other ("Sơn Tùng M-TP" ~ "son tung mtp").
func looseMatch(a, b string) bool {
	x, y := looseName(a), looseName(b)
	if x == "" || y == "" {
		return false
	}
	return strings.Contains(x, y) || strings.Contains(y, x)
}
