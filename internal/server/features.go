package server

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"math"
	"os/exec"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Tier-3 "nghe giống": a hand-crafted audio feature vector per track.
//   0–19   ffmpeg spectral stats over 90 s (centroid, spread, rolloff, flatness…),
//          energy dynamics, tempo and pulse clarity (mood.go reads these by index)
//   20–45  MFCC 1–13 mean / std (timbre), timbre.go
//   46–57  key-independent chroma profile (harmony), timbre.go
// Not semantics like a learned embedding (too heavy for a small server).
// Vectors are z-scored across the library, weighted per group and compared by
// cosine similarity.

const featureVersion = 2

// featureWeight: how much each group counts in "sounds like".
func featureWeight(i int) float64 {
	switch {
	case i < 20:
		return 1
	case i < 46:
		return 0.75
	default:
		return 0.6
	}
}

var spectralMeasures = []string{"centroid", "spread", "flatness", "crest", "entropy", "rolloff", "flux", "slope"}

// extractFeatures returns the feature vector for one audio file.
func extractFeatures(ctx context.Context, ffmpeg, file string, durationMs int64) ([]float64, error) {
	dur := float64(durationMs) / 1000
	start := 0.0
	if dur > 120 {
		start = dur * 0.2 // skip intros
	}
	af := "aspectralstats=win_size=2048:overlap=0.5:measure=" + strings.Join(spectralMeasures, "+") +
		",astats=metadata=1:reset=1:measure_overall=RMS_level:measure_perchannel=none,ametadata=print:file=-"
	cmd := exec.CommandContext(ctx, ffmpeg, "-hide_banner", "-nostdin", "-loglevel", "error",
		"-ss", fmt.Sprintf("%.1f", start), "-t", "90", "-i", file, "-ac", "1", "-ar", "22050", "-af", af, "-f", "null", "-")
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("ffmpeg features: %w", err)
	}
	vec, err := featuresFromMetadata(out)
	if err != nil {
		return nil, err
	}
	tim, err := timbreFeatures(ctx, ffmpeg, file, start)
	if err != nil {
		return nil, err
	}
	return append(vec, tim...), nil
}

// featuresFromMetadata aggregates ffmpeg's per-frame metadata into a vector:
// mean and std of each spectral measure, mean/std of RMS level, log2 tempo and
// pulse clarity from the autocorrelation of spectral flux.
func featuresFromMetadata(out []byte) ([]float64, error) {
	series := map[string][]float64{}
	var times []float64
	sc := bufio.NewScanner(bytes.NewReader(out))
	sc.Buffer(make([]byte, 64*1024), 1<<20)
	for sc.Scan() {
		line := sc.Text()
		if strings.HasPrefix(line, "frame:") {
			if i := strings.Index(line, "pts_time:"); i >= 0 {
				if t, err := strconv.ParseFloat(strings.TrimSpace(line[i+9:]), 64); err == nil {
					times = append(times, t)
				}
			}
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		f, err := strconv.ParseFloat(v, 64)
		if err != nil || math.IsNaN(f) || math.IsInf(f, 0) {
			continue
		}
		name := k[strings.LastIndex(k, ".")+1:] // lavfi.aspectralstats.1.centroid → centroid
		if strings.HasPrefix(k, "lavfi.astats.Overall.") {
			name = "rms"
		}
		series[name] = append(series[name], f)
	}
	if len(series["centroid"]) < 50 {
		return nil, fmt.Errorf("too few frames (%d)", len(series["centroid"]))
	}
	vec := []float64{}
	for _, m := range spectralMeasures {
		xs := series[m]
		if m == "centroid" || m == "spread" || m == "rolloff" {
			xs = mapf(xs, func(x float64) float64 { return math.Log1p(math.Max(x, 0)) })
		}
		mu, sd := meanStd(xs)
		vec = append(vec, mu, sd)
	}
	rmsMu, rmsSd := meanStd(series["rms"])
	vec = append(vec, rmsMu, rmsSd)

	// Tempo: autocorrelation of flux over lags of 0.3–1.0 s (60–200 BPM).
	bpm, clarity := 0.0, 0.0
	if len(times) > 2 {
		fps := float64(len(times)-1) / (times[len(times)-1] - times[0])
		bpm, clarity = tempoFromFlux(series["flux"], fps)
	}
	if bpm > 0 {
		vec = append(vec, math.Log2(bpm), clarity)
	} else {
		vec = append(vec, math.Log2(120), 0)
	}
	return vec, nil
}

func tempoFromFlux(flux []float64, fps float64) (bpm, clarity float64) {
	if fps <= 0 || len(flux) < int(fps*4) {
		return 0, 0
	}
	mu, _ := meanStd(flux)
	x := mapf(flux, func(v float64) float64 { return v - mu })
	var energy float64
	for _, v := range x {
		energy += v * v
	}
	if energy == 0 {
		return 0, 0
	}
	lo, hi := int(fps*0.3), int(fps*1.0)
	best, bestLag := -1.0, 0
	for lag := lo; lag <= hi && lag < len(x); lag++ {
		var s float64
		for i := 0; i+lag < len(x); i++ {
			s += x[i] * x[i+lag]
		}
		s /= energy
		if s > best {
			best, bestLag = s, lag
		}
	}
	if bestLag == 0 {
		return 0, 0
	}
	return 60 * fps / float64(bestLag), math.Max(0, best)
}

func mapf(xs []float64, f func(float64) float64) []float64 {
	out := make([]float64, len(xs))
	for i, x := range xs {
		out[i] = f(x)
	}
	return out
}

func meanStd(xs []float64) (float64, float64) {
	if len(xs) == 0 {
		return 0, 0
	}
	var s float64
	for _, x := range xs {
		s += x
	}
	mu := s / float64(len(xs))
	var v float64
	for _, x := range xs {
		v += (x - mu) * (x - mu)
	}
	return mu, math.Sqrt(v / float64(len(xs)))
}

// ── background worker ───────────────────────────────────────────────────

type featureIndex struct {
	mu      sync.Mutex
	kick    chan struct{}
	loaded  bool
	ids     []string
	vecs    [][]float64 // z-scored, unit length
	zs      [][]float64 // z-scored per dimension (mood playlists)
	byID    map[string]int
	dirty   bool
	pending int
}

func newFeatureIndex() *featureIndex {
	return &featureIndex{kick: make(chan struct{}, 1), byID: map[string]int{}, dirty: true}
}

// markDirty makes the next query reload vectors (a track was deleted).
func (f *featureIndex) markDirty() {
	f.mu.Lock()
	f.dirty = true
	f.mu.Unlock()
}

// Kick wakes the worker (after a download).
func (f *featureIndex) Kick() {
	select {
	case f.kick <- struct{}{}:
	default:
	}
}

// runFeatureWorker computes missing vectors one track at a time, at low priority.
func (s *Server) runFeatureWorker(ctx context.Context) {
	tick := time.NewTicker(10 * time.Minute)
	defer tick.Stop()
	for {
		for ctx.Err() == nil {
			// Loudness first: it is quick and playback uses it.
			if s.measurePendingLoudness(ctx) {
				continue
			}
			var id, path string
			var dur int64
			err := s.db.QueryRow(`SELECT t.id, t.file_path, t.duration_ms FROM tracks t
				LEFT JOIN track_features f ON f.track_id = t.id AND f.version = ?
				WHERE f.track_id IS NULL ORDER BY t.added_at DESC LIMIT 1`, featureVersion).Scan(&id, &path, &dur)
			if err != nil {
				break // none left (or db error; retry on next tick)
			}
			fctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
			vec, ferr := extractFeaturesFile(fctx, s, path, dur)
			cancel()
			if ctx.Err() != nil {
				return
			}
			if ferr != nil {
				s.log.Warn("audio features failed", "track", id, "err", ferr)
				vec = []float64{} // remember the failure so we don't loop on it
			}
			b, _ := json.Marshal(vec)
			s.db.Exec(`INSERT INTO track_features(track_id, version, vec, computed_at) VALUES (?,?,?,?)
				ON CONFLICT(track_id) DO UPDATE SET version=excluded.version, vec=excluded.vec, computed_at=excluded.computed_at`,
				id, featureVersion, string(b), nowMs())
			s.features.mu.Lock()
			s.features.dirty = true
			s.features.mu.Unlock()
			time.Sleep(300 * time.Millisecond)
		}
		select {
		case <-ctx.Done():
			return
		case <-s.features.kick:
		case <-tick.C:
		}
	}
}

// loadFeatures (re)builds the normalised in-memory index when vectors changed.
func (s *Server) loadFeatures() *featureIndex {
	f := s.features
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.dirty {
		return f
	}
	rows, err := s.db.Query(`SELECT track_id, vec FROM track_features WHERE version = ?`, featureVersion)
	if err != nil {
		return f
	}
	ids := []string{}
	raw := [][]float64{}
	for rows.Next() {
		var id, js string
		if rows.Scan(&id, &js) != nil {
			continue
		}
		var v []float64
		if json.Unmarshal([]byte(js), &v) == nil && len(v) > 0 {
			ids = append(ids, id)
			raw = append(raw, v)
		}
	}
	rows.Close()
	var total int
	s.db.QueryRow(`SELECT COUNT(*) FROM tracks`).Scan(&total)
	f.pending = max(0, total-len(ids))
	f.ids, f.vecs, f.zs, f.byID = ids, zscoreUnit(raw), zscore(raw), map[string]int{}
	for i, id := range ids {
		f.byID[id] = i
	}
	f.loaded, f.dirty = true, false
	return f
}

func zscoreUnit(raw [][]float64) [][]float64 {
	if len(raw) == 0 {
		return nil
	}
	dim := len(raw[0])
	mu := make([]float64, dim)
	sd := make([]float64, dim)
	n := 0.0
	for _, v := range raw {
		if len(v) != dim {
			continue
		}
		n++
		for i, x := range v {
			mu[i] += x
		}
	}
	for i := range mu {
		mu[i] /= math.Max(n, 1)
	}
	for _, v := range raw {
		if len(v) != dim {
			continue
		}
		for i, x := range v {
			sd[i] += (x - mu[i]) * (x - mu[i])
		}
	}
	for i := range sd {
		sd[i] = math.Sqrt(sd[i] / math.Max(n, 1))
		if sd[i] < 1e-9 {
			sd[i] = 1
		}
	}
	out := make([][]float64, len(raw))
	for k, v := range raw {
		z := make([]float64, dim)
		if len(v) == dim {
			var norm float64
			for i, x := range v {
				z[i] = (x - mu[i]) / sd[i] * featureWeight(i)
				norm += z[i] * z[i]
			}
			norm = math.Sqrt(norm)
			if norm > 0 {
				for i := range z {
					z[i] /= norm
				}
			}
		}
		out[k] = z
	}
	return out
}

type scored struct {
	ID    string
	Score float64
}

// audioNeighbors returns the k tracks whose sound is closest to id.
func (s *Server) audioNeighbors(id string, k int) []scored {
	f := s.loadFeatures()
	f.mu.Lock()
	defer f.mu.Unlock()
	i, ok := f.byID[id]
	if !ok || len(f.ids) < 3 {
		return nil
	}
	a := f.vecs[i]
	out := make([]scored, 0, len(f.ids))
	for j, b := range f.vecs {
		if j == i {
			continue
		}
		var dot float64
		for d := range a {
			dot += a[d] * b[d]
		}
		out = append(out, scored{f.ids[j], dot})
	}
	sort.Slice(out, func(x, y int) bool { return out[x].Score > out[y].Score })
	if len(out) > k {
		out = out[:k]
	}
	return out
}

// measurePendingLoudness measures one freshly downloaded track, if any, and
// pushes the new gain to open players. Reports whether it found one.
func (s *Server) measurePendingLoudness(ctx context.Context) bool {
	var id, path string
	if err := s.db.QueryRow(`SELECT id, file_path FROM tracks WHERE loudness_done = 0 ORDER BY added_at DESC LIMIT 1`).Scan(&id, &path); err != nil {
		return false
	}
	lctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	lufs, gain := measureLoudnessFile(lctx, s, path)
	cancel()
	if ctx.Err() != nil {
		return false
	}
	var lufsVal any
	if !isNaN(lufs) {
		lufsVal = lufs
	}
	s.db.Exec(`UPDATE tracks SET loudness_lufs = ?, gain_db = ?, loudness_done = 1 WHERE id = ?`, lufsVal, gain, id)
	s.hub.PublishAll("trackGain", map[string]any{"id": id, "gainDb": gain})
	return true
}

// zscore standardises each dimension across the library.
func zscore(raw [][]float64) [][]float64 {
	if len(raw) == 0 {
		return nil
	}
	dim := len(raw[0])
	mu, sd := make([]float64, dim), make([]float64, dim)
	n := 0.0
	for _, v := range raw {
		if len(v) == dim {
			n++
			for i, x := range v {
				mu[i] += x
			}
		}
	}
	for i := range mu {
		mu[i] /= math.Max(n, 1)
	}
	for _, v := range raw {
		if len(v) == dim {
			for i, x := range v {
				sd[i] += (x - mu[i]) * (x - mu[i])
			}
		}
	}
	for i := range sd {
		sd[i] = math.Sqrt(sd[i] / math.Max(n, 1))
		if sd[i] < 1e-9 {
			sd[i] = 1
		}
	}
	out := make([][]float64, len(raw))
	for k, v := range raw {
		z := make([]float64, dim)
		if len(v) == dim {
			for i, x := range v {
				z[i] = (x - mu[i]) / sd[i]
			}
		}
		out[k] = z
	}
	return out
}
