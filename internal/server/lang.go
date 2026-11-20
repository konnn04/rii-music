package server

import (
	"context"
	"net/http"
	"strings"
	"sync"

	"vang/internal/textutil"
)

// Song language keeps recommendations from mixing, say, V-pop into a J-pop
// radio. A track's language comes from its title / artist; tracks it can't
// tell (glued titles, kanji-only names) take their artist's majority.

// resolveLangs returns track id → language for a library.
func resolveLangs(all []Track) map[string]string {
	byArtist := map[string]map[string]int{}
	for _, t := range all {
		if t.Lang == "" {
			continue
		}
		for _, a := range splitArtists(t.Artist) {
			k := looseName(a)
			if byArtist[k] == nil {
				byArtist[k] = map[string]int{}
			}
			byArtist[k][t.Lang]++
		}
	}
	out := make(map[string]string, len(all))
	for _, t := range all {
		lang := t.Lang
		if lang == "" || lang == textutil.LangEN || lang == textutil.LangZH {
			// weak guesses: let the artist's other songs decide
			best, bestN, total := "", 0, 0
			for _, a := range splitArtists(t.Artist) {
				for l, n := range byArtist[looseName(a)] {
					total += n
					if n > bestN {
						best, bestN = l, n
					}
				}
			}
			if best != "" && best != lang && bestN >= 2 && bestN*2 > total {
				lang = best
			}
		}
		out[t.ID] = lang
	}
	return out
}

// langPrefs: share of each language in what the user likes (listening
// history), else what they picked at onboarding, else their library.
func langPrefs(all []Track, langs map[string]string, t *taste, st Settings) map[string]float64 {
	pref := map[string]float64{}
	total := 0.0
	for _, tr := range all {
		if v := t.track[tr.ID]; v > 0 && langs[tr.ID] != "" {
			pref[langs[tr.ID]] += v
			total += v
		}
	}
	if total == 0 && len(st.PrefLangs) > 0 {
		for _, l := range st.PrefLangs {
			pref[l] = 1
			total++
		}
	}
	if total == 0 {
		for _, tr := range all {
			if l := langs[tr.ID]; l != "" {
				pref[l]++
				total++
			}
		}
	}
	for l := range pref {
		pref[l] /= total
	}
	return pref
}

// langFactor scales a recommendation score by how much the user listens to
// that language (unknown language: neutral).
func (rc *recCtx) langFactor(id string) float64 {
	l := rc.lang[id]
	if l == "" || len(rc.langPref) == 0 {
		return 1
	}
	top := 0.0
	for _, v := range rc.langPref {
		top = max(top, v)
	}
	return 0.2 + 0.8*min(1, rc.langPref[l]/top)
}

// sameLang: two languages that should not be mixed in one radio / mix.
func sameLang(a, b string) bool { return a == "" || b == "" || a == b }

// langWanted says whether a song in this language may be suggested to the
// user at all (for downloads of new songs).
func (rc *recCtx) langWanted(l string) bool {
	if l == "" || len(rc.langPref) == 0 {
		return true
	}
	return rc.langPref[l] >= 0.15
}

// backfillLangs sets the language of tracks stored before it was detected.
func (s *Server) backfillLangs() {
	rows, err := s.db.Query(`SELECT id, title, artist FROM tracks WHERE lang = ''`)
	if err != nil {
		return
	}
	type tr struct{ id, title, artist string }
	var list []tr
	for rows.Next() {
		var t tr
		if rows.Scan(&t.id, &t.title, &t.artist) == nil {
			list = append(list, t)
		}
	}
	rows.Close()
	for _, t := range list {
		if l := textutil.DetectLang(t.title, t.artist); l != "" {
			s.db.Exec(`UPDATE tracks SET lang = ? WHERE id = ?`, l, t.id)
		}
	}
}

// ── onboarding ──────────────────────────────────────────────────────────

var genreQueries = map[string]map[string]string{
	// genre → language → YouTube Music query
	"pop":      {"vi": "nhạc pop việt", "en": "pop hits", "ja": "j-pop", "ko": "k-pop", "zh": "c-pop", "th": "t-pop"},
	"ballad":   {"vi": "ballad việt", "en": "pop ballad", "ja": "j-pop ballad", "ko": "k-ballad", "zh": "chinese ballad", "th": "thai ballad"},
	"rap":      {"vi": "rap việt", "en": "hip hop", "ja": "japanese hip hop", "ko": "k-hip hop", "zh": "chinese rap", "th": "thai hip hop"},
	"indie":    {"vi": "indie việt", "en": "indie", "ja": "japanese indie", "ko": "k-indie", "zh": "chinese indie", "th": "thai indie"},
	"edm":      {"vi": "nhạc edm việt", "en": "edm", "ja": "japanese edm", "ko": "k-pop edm", "zh": "chinese edm", "th": "thai edm"},
	"rnb":      {"vi": "r&b việt", "en": "r&b", "ja": "japanese r&b", "ko": "k-r&b", "zh": "chinese r&b", "th": "thai r&b"},
	"rock":     {"vi": "rock việt", "en": "rock", "ja": "j-rock", "ko": "k-rock", "zh": "chinese rock", "th": "thai rock"},
	"lofi":     {"vi": "lofi việt", "en": "lofi", "ja": "japanese lofi", "ko": "korean lofi", "zh": "chinese lofi", "th": "thai lofi"},
	"bolero":   {"vi": "bolero", "en": "country", "ja": "enka", "ko": "trot", "zh": "chinese oldies", "th": "luk thung"},
	"acoustic": {"vi": "acoustic việt", "en": "acoustic", "ja": "japanese acoustic", "ko": "korean acoustic", "zh": "chinese acoustic", "th": "thai acoustic"},
	"anime":    {"vi": "nhạc phim việt", "en": "movie soundtrack", "ja": "anime songs", "ko": "k-drama ost", "zh": "c-drama ost", "th": "thai drama ost"},
}

type suggestedArtist struct {
	Name  string `json:"name"`
	Image string `json:"image"`
	Lang  string `json:"lang"`
}

// handleOnboardingArtists suggests artists for the languages and genres a new
// user picked, from YouTube Music searches.
func (s *Server) handleOnboardingArtists(w http.ResponseWriter, r *http.Request) {
	langs := strings.Split(r.URL.Query().Get("langs"), ",")
	genres := strings.Split(r.URL.Query().Get("genres"), ",")
	var queries []struct{ q, lang string }
	for _, l := range langs {
		if textutil.LangName(l) == "" {
			continue
		}
		picked := false
		for _, g := range genres {
			if q, ok := genreQueries[g][l]; ok {
				queries = append(queries, struct{ q, lang string }{q, l})
				picked = true
			}
		}
		if !picked {
			queries = append(queries, struct{ q, lang string }{genreQueries["pop"][l], l})
		}
	}
	if len(queries) > 10 {
		queries = queries[:10]
	}
	var mu sync.Mutex
	var wg sync.WaitGroup
	results := make([][]WebResult, len(queries))
	ctx, cancel := context.WithTimeout(r.Context(), 15e9)
	defer cancel()
	for i, q := range queries {
		wg.Add(1)
		go func(i int, q string) {
			defer wg.Done()
			res, err := ytmSearch(ctx, s.ext.hc, q, "songs")
			if err == nil {
				mu.Lock()
				results[i] = res
				mu.Unlock()
			}
		}(i, q.q)
	}
	wg.Wait()
	seen := map[string]bool{}
	out := []suggestedArtist{}
	// Round-robin across queries so every genre gets a few.
	for round := 0; round < 20 && len(out) < 30; round++ {
		for i, res := range results {
			if round >= len(res) {
				continue
			}
			a := strings.TrimSpace(splitArtists(res[round].Artist)[0])
			k := looseName(a)
			if a == "" || seen[k] {
				continue
			}
			seen[k] = true
			out = append(out, suggestedArtist{Name: a, Image: res[round].Thumbnail, Lang: queries[i].lang})
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"artists": out})
}
