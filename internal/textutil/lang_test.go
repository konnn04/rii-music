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
