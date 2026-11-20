package textutil

import (
	"strings"
	"unicode"
)

// Languages tracks are grouped by, so recommendations don't mix them.
const (
	LangVI = "vi"
	LangEN = "en" // also other Latin-script songs
	LangJA = "ja"
	LangKO = "ko"
	LangZH = "zh"
	LangTH = "th"
)

// Letters only Vietnamese uses among Latin-script languages.
const viLetters = "ăđơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ"

// Common Vietnamese words still recognisable without diacritics ("Buong Doi Tay Nhau Ra").
var viWords = map[string]bool{
	"anh": true, "em": true, "yeu": true, "nguoi": true, "khong": true, "toi": true, "minh": true, "nhau": true,
	"tinh": true, "mot": true, "cua": true, "cho": true, "trong": true, "ngay": true, "dem": true, "buon": true,
	"thuong": true, "nho": true, "lai": true, "roi": true, "nhu": true, "ve": true, "di": true, "den": true,
	"tim": true, "doi": true, "chua": true, "mua": true, "nang": true, "giac": true, "mo": true, "noi": true,
	"nhieu": true, "con": true, "biet": true, "ai": true, "oi": true, "ta": true, "voi": true, "tay": true,
}

// DetectLang guesses a song's language from its title and artist.
// Returns "" when unsure.
func DetectLang(title, artist string) string {
	s := title + " " + artist
	var hangul, kana, han, thai, latin int
	for _, r := range s {
		switch {
		case unicode.Is(unicode.Hangul, r):
			hangul++
		case unicode.Is(unicode.Hiragana, r) || unicode.Is(unicode.Katakana, r):
			kana++
		case unicode.Is(unicode.Han, r):
			han++
		case unicode.Is(unicode.Thai, r):
			thai++
		case unicode.IsLetter(r) && r < 0x2B0 || strings.ContainsRune(viLetters, unicode.ToLower(r)):
			latin++
		}
	}
	switch {
	case hangul > 0:
		return LangKO
	case kana > 0:
		return LangJA
	case han > 0:
		return LangZH
	case thai > 0:
		return LangTH
	}
	if latin == 0 {
		return ""
	}
	low := strings.ToLower(s)
	for _, r := range viLetters {
		if strings.ContainsRune(low, r) {
			return LangVI
		}
	}
	// Without diacritics: count common Vietnamese words in the title.
	hits, words := 0, 0
	for _, w := range strings.FieldsFunc(Fold(title), func(r rune) bool { return !unicode.IsLetter(r) }) {
		words++
		if viWords[w] {
			hits++
		}
	}
	if hits >= 2 || words > 0 && hits*2 >= words && hits > 0 {
		return LangVI
	}
	return LangEN
}

// LangName is a short label for the UI.
func LangName(code string) string {
	switch code {
	case LangVI:
		return "Việt"
	case LangEN:
		return "Âu Mỹ"
	case LangJA:
		return "Nhật"
	case LangKO:
		return "Hàn"
	case LangZH:
		return "Hoa"
	case LangTH:
		return "Thái"
	}
	return ""
}
