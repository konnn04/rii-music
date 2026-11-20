package server

import "testing"

func TestNormalizeInput(t *testing.T) {
	ok := map[string]string{
		"https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
		"https://youtu.be/dQw4w9WgXcQ?si=abc":                    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
		"https://music.youtube.com/watch?v=dQw4w9WgXcQ":          "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
		"https://www.youtube.com/shorts/dQw4w9WgXcQ":             "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
		"https://www.youtube.com/playlist?list=PLabc_DEF-123":    "https://www.youtube.com/playlist?list=PLabc_DEF-123",
		"  mùa hè ở lại  ":                                       "ytsearch1:mùa hè ở lại",
		"--exec rm -rf /":                                        "ytsearch1:--exec rm -rf /", // passed after "--", so never an option
	}
	for in, want := range ok {
		got, err := normalizeInput(in)
		if err != nil || got != want {
			t.Errorf("normalizeInput(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	bad := []string{"", "https://evil.example.com/watch?v=dQw4w9WgXcQ", "file:///etc/passwd", "https://www.youtube.com/@channel", "https://youtube.com.evil.com/watch?v=dQw4w9WgXcQ"}
	for _, in := range bad {
		if got, err := normalizeInput(in); err == nil {
			t.Errorf("normalizeInput(%q) = %q, want error", in, got)
		}
	}
}

func TestParseProgress(t *testing.T) {
	if p := parseProgress("50/100/NA"); p != 0.5 {
		t.Errorf("got %v", p)
	}
	if p := parseProgress("25/NA/100"); p != 0.25 {
		t.Errorf("estimate fallback: got %v", p)
	}
	if p := parseProgress("NA/NA/NA"); p != -1 {
		t.Errorf("unknown: got %v", p)
	}
}

func TestParseEBUR128(t *testing.T) {
	out := `[Parsed_ebur128_0 @ 0x1] t: 1.2 TARGET:-23 LUFS M: -20.1 S:-120.7 I: -19.0 LUFS LRA: 0.0 LU
[Parsed_ebur128_0 @ 0x1] Summary:

  Integrated loudness:
    I:          -9.0 LUFS
    Threshold: -19.1 LUFS

  Loudness range:
    LRA:         5.0 LU

  True peak:
    Peak:       -0.4 dBFS
`
	i, tp, ok := parseEBUR128(out)
	if !ok || i != -9.0 || tp != -0.4 {
		t.Fatalf("got i=%v tp=%v ok=%v", i, tp, ok)
	}
	if _, _, ok := parseEBUR128("I: -19.0 LUFS (no summary)"); ok {
		t.Fatal("must ignore per-frame lines without a summary")
	}
	if _, _, ok := parseEBUR128("Summary:\n    I:          -inf LUFS\n"); ok {
		t.Fatal("silence must not yield a loudness")
	}
}
