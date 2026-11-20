package server

import (
	"context"
	"math"
	"math/cmplx"
	"math/rand/v2"
	"os"
	"os/exec"
	"testing"
	"time"
)

func TestFFT(t *testing.T) {
	// A pure tone at bin 5 puts all its energy in bins 5 and N−5.
	n := 64
	a := make([]complex128, n)
	for i := range a {
		a[i] = complex(math.Cos(2*math.Pi*5*float64(i)/float64(n)), 0)
	}
	fft(a)
	for k, v := range a {
		want := 0.0
		if k == 5 || k == n-5 {
			want = float64(n) / 2
		}
		if math.Abs(cmplx.Abs(v)-want) > 1e-6 {
			t.Fatalf("bin %d: %.3f, want %.3f", k, cmplx.Abs(v), want)
		}
	}
}

func tone(freqs []float64, sec float64, noise float64, seed uint64) []float32 {
	r := rand.New(rand.NewPCG(seed, 1))
	out := make([]float32, int(sec*tSR))
	for i := range out {
		v := 0.0
		for h, f := range freqs {
			v += math.Sin(2*math.Pi*f*float64(i)/tSR) / float64(h+1)
		}
		v += noise * (r.Float64()*2 - 1)
		out[i] = float32(v * 0.3)
	}
	return out
}

func cosine(a, b []float64) float64 {
	var d, na, nb float64
	for i := range a {
		d += a[i] * b[i]
		na += a[i] * a[i]
		nb += b[i] * b[i]
	}
	return d / math.Sqrt(na*nb)
}

func TestTimbreFeatures(t *testing.T) {
	// Same "instrument" (harmonics) in A and in C: the rotated chroma matches.
	a, err := timbreFromPCM(tone([]float64{440, 880, 1320}, 10, 0, 1))
	if err != nil {
		t.Fatal(err)
	}
	c, _ := timbreFromPCM(tone([]float64{523.25, 1046.5, 1569.75}, 10, 0, 2))
	noisy, _ := timbreFromPCM(tone([]float64{440}, 10, 1, 3))
	if len(a) != 2*tMFCC+12 {
		t.Fatalf("dims = %d", len(a))
	}
	chromaA, chromaC := a[2*tMFCC:], c[2*tMFCC:]
	if s := cosine(chromaA, chromaC); s < 0.95 {
		t.Errorf("chroma should not depend on the key: cosine %.3f", s)
	}
	mA, mN := a[:2*tMFCC], noisy[:2*tMFCC]
	mC := c[:2*tMFCC]
	if cosine(mA, mC) <= cosine(mA, mN) {
		t.Errorf("a clean tone should sound more like another clean tone than like noise (%.3f vs %.3f)", cosine(mA, mC), cosine(mA, mN))
	}
	if _, err := timbreFromPCM(make([]float32, 100)); err == nil {
		t.Error("too little audio should fail")
	}
}

// TestTimbreRealFile measures one real song when RII_SAMPLE_AUDIO points to one.
func TestTimbreRealFile(t *testing.T) {
	f := os.Getenv("RII_SAMPLE_AUDIO")
	ff, err := exec.LookPath("ffmpeg")
	if f == "" || err != nil {
		t.Skip("set RII_SAMPLE_AUDIO to an audio file (and have ffmpeg) to run")
	}
	start := time.Now()
	vec, err := extractFeatures(context.Background(), ff, f, 240_000)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("%d dims in %v", len(vec), time.Since(start))
	if len(vec) != 20+2*tMFCC+12 {
		t.Fatalf("dims = %d", len(vec))
	}
}
