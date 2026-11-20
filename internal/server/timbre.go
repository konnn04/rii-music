package server

import (
	"bufio"
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"math"
	"math/cmplx"
	"os/exec"
)

// Timbre and harmony for tier-3 "nghe giống", computed in plain Go from 60 s
// of mono 22.05 kHz audio decoded by ffmpeg (≈0.1 s of CPU per song):
//
//   - MFCC 1–13, mean and std over frames (26 dims): the "colour" of the
//     sound (voice, instruments, production), the classic music-similarity
//     feature.
//   - Chroma (12 dims): energy per pitch class, rotated so the strongest class
//     comes first, so two songs in different keys can still match.

const (
	tSR    = 22050
	tFrame = 2048
	tHop   = 1024
	tMels  = 26
	tMFCC  = 13
)

func timbreFeatures(ctx context.Context, ffmpeg, file string, start float64) ([]float64, error) {
	cmd := exec.CommandContext(ctx, ffmpeg, "-hide_banner", "-nostdin", "-loglevel", "error",
		"-ss", fmt.Sprintf("%.1f", start), "-t", "60", "-i", file, "-ac", "1", "-ar", fmt.Sprint(tSR), "-f", "f32le", "-")
	out, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	samples := make([]float32, 0, tSR*60)
	r := bufio.NewReaderSize(out, 1<<16)
	buf := make([]byte, 4)
	for {
		if _, err := io.ReadFull(r, buf); err != nil {
			break
		}
		samples = append(samples, math.Float32frombits(binary.LittleEndian.Uint32(buf)))
	}
	if err := cmd.Wait(); err != nil {
		return nil, fmt.Errorf("ffmpeg pcm: %w", err)
	}
	return timbreFromPCM(samples)
}

func timbreFromPCM(x []float32) ([]float64, error) {
	if len(x) < tFrame*20 {
		return nil, fmt.Errorf("too little audio (%d samples)", len(x))
	}
	window := make([]float64, tFrame)
	for i := range window {
		window[i] = 0.5 - 0.5*math.Cos(2*math.Pi*float64(i)/float64(tFrame-1))
	}
	mel := melFilters()
	pcOf := pitchClasses()
	bins := tFrame/2 + 1
	frame := make([]complex128, tFrame)
	power := make([]float64, bins)

	var mfccs [][]float64
	chroma := make([]float64, 12)
	for off := 0; off+tFrame <= len(x); off += tHop {
		energy := 0.0
		for i := 0; i < tFrame; i++ {
			v := float64(x[off+i])
			energy += v * v
			frame[i] = complex(v*window[i], 0)
		}
		if energy/tFrame < 1e-7 {
			continue // silence says nothing about timbre
		}
		fft(frame)
		for k := 0; k < bins; k++ {
			a := cmplx.Abs(frame[k])
			power[k] = a * a
		}
		// log mel energies → DCT-II → MFCC 1..13 (MFCC 0 is just loudness)
		logMel := make([]float64, tMels)
		for m, f := range mel {
			s := 0.0
			for k, w := range f.w {
				s += w * power[f.start+k]
			}
			logMel[m] = math.Log(s + 1e-10)
		}
		c := make([]float64, tMFCC)
		for n := 1; n <= tMFCC; n++ {
			s := 0.0
			for m := 0; m < tMels; m++ {
				s += logMel[m] * math.Cos(math.Pi*float64(n)*(float64(m)+0.5)/tMels)
			}
			c[n-1] = s
		}
		mfccs = append(mfccs, c)
		// chroma, normalised per frame
		pc := make([]float64, 12)
		tot := 0.0
		for k := 1; k < bins; k++ {
			if p := pcOf[k]; p >= 0 {
				pc[p] += power[k]
				tot += power[k]
			}
		}
		if tot > 0 {
			for i := range pc {
				chroma[i] += pc[i] / tot
			}
		}
	}
	if len(mfccs) < 20 {
		return nil, fmt.Errorf("too few sounding frames (%d)", len(mfccs))
	}
	vec := make([]float64, 0, 2*tMFCC+12)
	for i := 0; i < tMFCC; i++ {
		col := make([]float64, len(mfccs))
		for j, c := range mfccs {
			col[j] = c[i]
		}
		mu, sd := meanStd(col)
		vec = append(vec, mu, sd)
	}
	// rotate chroma: strongest pitch class first (key-independent profile)
	top := 0
	sum := 0.0
	for i, v := range chroma {
		sum += v
		if v > chroma[top] {
			top = i
		}
	}
	for i := 0; i < 12; i++ {
		v := 0.0
		if sum > 0 {
			v = chroma[(top+i)%12] / sum
		}
		vec = append(vec, v)
	}
	return vec, nil
}

type melFilter struct {
	start int
	w     []float64
}

// melFilters: tMels triangular filters between 40 Hz and 8 kHz.
func melFilters() []melFilter {
	toMel := func(f float64) float64 { return 2595 * math.Log10(1+f/700) }
	toHz := func(m float64) float64 { return 700 * (math.Pow(10, m/2595) - 1) }
	lo, hi := toMel(40), toMel(8000)
	pts := make([]float64, tMels+2)
	for i := range pts {
		pts[i] = toHz(lo+(hi-lo)*float64(i)/float64(tMels+1)) * float64(tFrame) / tSR // in bins
	}
	out := make([]melFilter, tMels)
	for m := 0; m < tMels; m++ {
		a, b, c := pts[m], pts[m+1], pts[m+2]
		start := int(math.Floor(a))
		end := int(math.Ceil(c))
		f := melFilter{start: start}
		for k := start; k <= end; k++ {
			x := float64(k)
			w := 0.0
			switch {
			case x >= a && x <= b && b > a:
				w = (x - a) / (b - a)
			case x > b && x <= c && c > b:
				w = (c - x) / (c - b)
			}
			f.w = append(f.w, w)
		}
		out[m] = f
	}
	return out
}

// pitchClasses maps FFT bins of 60 Hz – 4 kHz to a pitch class (C = 0), else −1.
func pitchClasses() []int {
	bins := tFrame/2 + 1
	out := make([]int, bins)
	for k := range out {
		f := float64(k) * tSR / tFrame
		if f < 60 || f > 4000 {
			out[k] = -1
			continue
		}
		midi := 69 + 12*math.Log2(f/440)
		out[k] = ((int(math.Round(midi)) % 12) + 12) % 12
	}
	return out
}

// fft: in-place iterative radix-2 Cooley–Tukey (len must be a power of two).
func fft(a []complex128) {
	n := len(a)
	for i, j := 1, 0; i < n; i++ {
		bit := n >> 1
		for ; j&bit != 0; bit >>= 1 {
			j ^= bit
		}
		j ^= bit
		if i < j {
			a[i], a[j] = a[j], a[i]
		}
	}
	for size := 2; size <= n; size <<= 1 {
		w := cmplx.Exp(complex(0, -2*math.Pi/float64(size)))
		for start := 0; start < n; start += size {
			wn := complex(1, 0)
			for k := 0; k < size/2; k++ {
				u := a[start+k]
				v := a[start+k+size/2] * wn
				a[start+k] = u + v
				a[start+k+size/2] = u - v
				wn *= w
			}
		}
	}
}
