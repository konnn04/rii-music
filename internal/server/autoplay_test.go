package server

import "testing"

func TestBaseTitle(t *testing.T) {
	for in, want := range map[string]string{
		"Tìm Em (cùng với Bảo Anh)":                         "Tìm Em",
		"Vờ Như Chẳng Yêu [Hoa Vương OST] (cùng với Negav)": "Vờ Như Chẳng Yêu",
		"Người Ấy": "Người Ấy",
		"(Intro)":  "(Intro)", // nothing left: keep as is
	} {
		if got := baseTitle(in); got != want {
			t.Errorf("baseTitle(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestLooseMatch(t *testing.T) {
	if !looseMatch("JAYKII & SARA", "JayKii") || !looseMatch("Sơn Tùng M-TP", "Son Tung M-TP") {
		t.Error("expected match")
	}
	if looseMatch("", "x") || looseMatch("Đạt G", "Bùi Anh Tuấn") {
		t.Error("unexpected match")
	}
}
