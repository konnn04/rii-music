package textutil

import "testing"

func TestDetectLang(t *testing.T) {
	for _, c := range []struct{ title, artist, want string }{
		{"Sinh Ra Đã Là Thứ Đối Lập Nhau", "Da LAB", LangVI},
		{"Tìm Em (cùng với Bảo Anh)", "Hngle", LangVI},
		{"Buong Doi Tay Nhau Ra", "Son Tung M-TP", LangVI},
		{"vaicaunoicokhiennguoithaydoi", "GREY D", LangEN}, // glued words: can't tell (artist-level fallback handles it)
		{"Numb", "Linkin Park", LangEN},
		{"Shape of You", "Ed Sheeran", LangEN},
		{"夜に駆ける", "YOASOBI", LangJA},
		{"Lemon", "米津玄師", LangZH}, // kanji only: reported as zh, artist-level majority corrects it
		{"봄날", "BTS", LangKO},
		{"月亮代表我的心", "鄧麗君", LangZH},
		{"Despacito", "Luis Fonsi", LangEN},
		{"", "", ""},
	} {
		if got := DetectLang(c.title, c.artist); got != c.want {
			t.Errorf("DetectLang(%q, %q) = %q, want %q", c.title, c.artist, got, c.want)
		}
	}
}

func TestDetectLangFeat(t *testing.T) {
	// YouTube Music in Vietnamese writes "(cùng với X)" for "(feat. X)": still English.
	for _, title := range []string{"Takeaway (cùng với Lennon Stella)", "So Far Away (feat. Jamie Scott)", "Stay (with Justin Bieber)"} {
		if got := DetectLang(title, "The Chainsmokers, Illenium"); got != LangEN {
			t.Errorf("DetectLang(%q) = %q, want en", title, got)
		}
	}
	if got := StripFeat("Tìm Em (cùng với Bảo Anh)"); got != "Tìm Em" {
		t.Errorf("StripFeat = %q", got)
	}
}

func TestDetectLyricsLang(t *testing.T) {
	en := `[00:12.00] I've been thinking about you all night long
[00:15.00] And I know that you feel the same way too
[00:18.00] Baby don't you go, I want you here with me
[00:21.00] Cause when you're gone the world is cold and grey`
	romaji := `[00:10.00] Kimi no koe ga kikoeru yo
[00:14.00] Itsumo soba ni ite kureta ne
[00:18.00] Namida wo fuite sora wo miageta
[00:22.00] Boku wa kimi no koto wo zutto wasurenai
[00:26.00] Ashita mo kitto aitai kara`
	vi := `Thời gian cho anh biết được anh cần em hơn anh nghĩ
Nên nếu anh có phải đi nơi đâu tìm em, anh vẫn sẽ đi
Và dù cho bao nhiêu năm tháng trôi qua anh vẫn ở đây`
	ja := "夜に駆ける 沈むように溶けてゆくように 二人だけの空が広がる夜に さよならだけだった その一言で全てが分かった"
	ko := "봄날 보고 싶다 이렇게 말하니까 더 보고 싶다 너희 사진을 보고 있어도 보고 싶다"
	for _, c := range []struct{ name, text, want string }{
		{"english", en, LangEN}, {"romaji", romaji, LangJA}, {"vietnamese", vi, LangVI},
		{"japanese", ja, LangJA}, {"korean", ko, LangKO}, {"short", "la la la", ""},
	} {
		if got := DetectLyricsLang(c.text); got != c.want {
			t.Errorf("%s: got %q, want %q", c.name, got, c.want)
		}
	}
}

func TestDetectLangArtistAndLyrics(t *testing.T) {
	// English title, Vietnamese artist name: V-pop.
	if got := DetectLang("There's No One At All", "Sơn Tùng M-TP"); got != LangVI {
		t.Errorf("english title by vietnamese artist = %q", got)
	}
	// Lyrics as the text: long Vietnamese text without a Vietnamese title.
	lyr := "Thời gian cho anh biết được anh cần em hơn anh nghĩ\nNên nếu anh có phải đi nơi đâu tìm em, anh vẫn sẽ đi"
	if got := DetectLang(lyr, ""); got != LangVI {
		t.Errorf("vietnamese lyrics = %q", got)
	}
	if got := DetectLang("夜に駆ける 沈むように溶けてゆくように 二人だけの空が広がる夜に", ""); got != LangJA {
		t.Errorf("japanese lyrics = %q", got)
	}
}
