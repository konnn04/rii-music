package server

import (
	"math"
	"math/rand/v2"
	"net/http"
	"sort"
	"time"
)

// Mood playlists ("Hôm nay bạn thấy thế nào?"): the user's library ranked by
// the audio features (features.go) that fit a mood, plus a little taste,
// in one language.
//
// Feature vector layout (before z-scoring): mean/sd pairs of centroid(0,1),
// spread(2,3), flatness(4,5), crest(6,7), entropy(8,9), rolloff(10,11),
// flux(12,13), slope(14,15), then RMS level mean/sd (16,17), log2 BPM (18),
// pulse clarity (19).

type moodDef struct {
	Name   string
	Reason string
	score  func(z []float64) float64
}

var moods = map[string]moodDef{
	"happy": {"Vui vẻ", "Nhịp nhanh, sáng, nhiều năng lượng", func(z []float64) float64 {
		return 0.8*energy(z) + 0.8*z[18] + 0.6*z[0] + 0.3*z[19]
	}},
	"sad": {"Buồn một chút", "Chậm, nhẹ, trầm", func(z []float64) float64 {
		return -0.9*energy(z) - 0.7*z[18] - 0.5*z[0]
	}},
	"chill": {"Thư giãn", "Nhẹ nhàng, đều, không gắt", func(z []float64) float64 {
		return -0.6*energy(z) - 0.4*z[18] - 0.6*z[13] - 0.4*z[17]
	}},
	"energetic": {"Sôi động", "Mạnh, nhanh, nhịp rõ", func(z []float64) float64 {
		return 1.2*energy(z) + 0.9*z[18] + 0.6*z[19]
	}},
	"focus": {"Tập trung", "Đều đặn, ít thay đổi đột ngột", func(z []float64) float64 {
		return -0.8*z[13] - 0.7*z[17] - 0.3*math.Abs(energy(z)) + 0.2*z[19]
	}},
}

func energy(z []float64) float64 { return (z[16] + z[12]) / 2 }

func (s *Server) handleMood(w http.ResponseWriter, r *http.Request) {
	uid := userOf(r).ID
	var body struct {
		Mood string `json:"mood"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	m, ok := moods[body.Mood]
	if !ok {
		httpError(w, http.StatusBadRequest, "Tâm trạng không hợp lệ")
		return
	}
	rc, err := s.newRecCtx(r.Context(), uid, false)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	// The language the user listens to most, so a mood list doesn't mix.
	lang, best := "", 0.0
	for l, v := range rc.langPref {
		if v > best {
			lang, best = l, v
		}
	}
	z := s.featureZ()
	type sc struct {
		t Track
		v float64
	}
	var list []sc
	withFeatures := 0
	rng := rand.New(rand.NewPCG(uint64(time.Now().UnixNano()), hashSeed(uid, body.Mood)))
	for _, t := range rc.all {
		if rc.taste.trackDisliked(t) || !sameLang(lang, rc.lang[t.ID]) {
			continue
		}
		v := 0.0
		if f, ok := z[t.ID]; ok && len(f) >= 20 {
			v = m.score(f)
			withFeatures++
		} else {
			v = -1 // no audio analysis yet: only as filler
		}
		v += 0.3*math.Tanh(rc.taste.track[t.ID]) + 0.4*rng.Float64() // a little taste, a little variety
		list = append(list, sc{t, v})
	}
	sort.Slice(list, func(i, j int) bool { return list[i].v > list[j].v })
	n := min(25, max(len(list)/2, min(len(list), 8)))
	tracks := make([]Track, 0, len(list))
	for _, x := range list {
		tracks = append(tracks, x.t)
	}
	// Songs finished in the last 3 hours go only if the list would be too short.
	tracks = rc.taste.dropRecent(tracks, n)
	if len(tracks) > n {
		tracks = tracks[:n]
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"mood": body.Mood, "name": m.Name, "reason": m.Reason, "tracks": tracks,
		"analyzed": withFeatures, "lang": lang,
	})
}

// featureZ: per-dimension z-scores of every analysed track (not unit-length,
// so each dimension keeps its meaning).
func (s *Server) featureZ() map[string][]float64 {
	f := s.loadFeatures()
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make(map[string][]float64, len(f.ids))
	for i, id := range f.ids {
		if i < len(f.zs) {
			out[id] = f.zs[i]
		}
	}
	return out
}
