package server

import (
	"context"
	"math"
	"os/exec"
	"path/filepath"
	"reflect"
	"testing"
)

func TestSplitArtists(t *testing.T) {
	cases := map[string][]string{
		"Sơn Tùng M-TP":                   {"Sơn Tùng M-TP"},
		"HÃY TRAO CHO ANH ft. Snoop Dogg": {"HÃY TRAO CHO ANH", "Snoop Dogg"},
		"A, B & C feat. D":                {"A", "B", "C", "D"},
		"Wren Evans x itsnk":              {"Wren Evans", "itsnk"},
		"Max":                             {"Max"}, // "x" inside a word is not a separator
	}
	for in, want := range cases {
		if got := splitArtists(in); !reflect.DeepEqual(got, want) {
			t.Errorf("splitArtists(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestLooseName(t *testing.T) {
	if looseName("SƠN TÙNG M-TP") != looseName("Son Tung M-TP") {
		t.Fatal("accents/case/punctuation must not matter")
	}
	if looseName("Min") == looseName("Minh") {
		t.Fatal("different artists must differ")
	}
}

func TestTempoFromFlux(t *testing.T) {
	// 100 frames/s, a pulse every 0.5 s → 120 BPM.
	fps := 100.0
	flux := make([]float64, 3000)
	for i := range flux {
		if i%50 == 0 {
			flux[i] = 1
		}
	}
	bpm, clarity := tempoFromFlux(flux, fps)
	if math.Abs(bpm-120) > 1 || clarity < 0.5 {
		t.Fatalf("bpm=%v clarity=%v", bpm, clarity)
	}
}

// Integration: real ffmpeg on a synthetic tone; skipped when ffmpeg is absent.
func TestExtractFeaturesFFmpeg(t *testing.T) {
	ff, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("ffmpeg not installed")
	}
	dir := t.TempDir()
	mk := func(name, src string) string {
		p := filepath.Join(dir, name)
		if out, err := exec.Command(ff, "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", src, "-t", "20", p).CombinedOutput(); err != nil {
			t.Fatalf("make %s: %v %s", name, err, out)
		}
		return p
	}
	low := mk("low.wav", "sine=frequency=220:sample_rate=44100")
	low2 := mk("low2.wav", "sine=frequency=247:sample_rate=44100")
	noise := mk("noise.wav", "anoisesrc=color=white:sample_rate=44100")
	vecs := [][]float64{}
	for _, p := range []string{low, low2, noise} {
		v, err := extractFeatures(context.Background(), ff, p, 20000)
		if err != nil {
			t.Fatalf("extract %s: %v", p, err)
		}
		if len(v) != 2*len(spectralMeasures)+4 {
			t.Fatalf("dim = %d", len(v))
		}
		vecs = append(vecs, v)
	}
	z := zscoreUnit(vecs)
	cos := func(a, b []float64) (s float64) {
		for i := range a {
			s += a[i] * b[i]
		}
		return
	}
	if cos(z[0], z[1]) <= cos(z[0], z[2]) {
		t.Fatalf("two sine tones should be closer to each other than to noise: tone/tone=%.2f tone/noise=%.2f", cos(z[0], z[1]), cos(z[0], z[2]))
	}
}
