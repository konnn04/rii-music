package textutil

import (
	"regexp"
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
	// "(feat. X)", "(cùng với X)", "(with X)" name other artists, not the song's language.
	if t := strings.TrimSpace(featPartRe.ReplaceAllString(title, "")); t != "" {
		title = t
	}
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

var featPartRe = regexp.MustCompile(`(?i)\s*[(\[]\s*(feat\.?|ft\.?|featuring|with|cùng với|cung voi)\s[^)\]]*[)\]]`)

// StripFeat removes "(feat. X)"-like parts from a title.
func StripFeat(title string) string {
	if t := strings.TrimSpace(featPartRe.ReplaceAllString(title, "")); t != "" {
		return t
	}
	return title
}

var lrcTimeRe = regexp.MustCompile(`\[\d+:\d+(?:[.:]\d+)?\]`)

// Romanised Japanese (romaji) that English lyrics practically never contain:
// particles and very common words of J-pop lyrics.
var romajiWords = map[string]bool{
	"wa": true, "ga": true, "wo": true, "ni": true, "mo": true, "ne": true, "yo": true, "ka": true, "kara": true,
	"made": false, "dake": true, "shite": true, "nai": true, "desu": true, "dakara": true, "demo": true,
	"watashi": true, "boku": true, "ore": true, "anata": true, "kimi": true, "omae": true, "kokoro": true,
	"sora": true, "yume": true, "koi": true, "namida": true, "sekai": true, "mirai": true, "ashita": true,
	"kyou": true, "kimochi": true, "hikari": true, "kaze": true, "hoshi": true, "tsuki": true, "hana": true,
	"sakura": true, "itsumo": true, "zutto": true, "mada": true, "motto": true, "kitto": true, "naze": true,
	"dou": true, "hitori": true, "futari": true, "issho": true, "nani": true, "doko": true, "koko": true,
	"sayonara": true, "arigatou": true, "suki": true, "daisuki": true, "aishiteru": true, "ima": true,
	"mou": true, "sou": true, "dare": true, "kono": true, "sono": true, "ano": true, "tame": true, "naku": true,
	"nakute": true, "shiteru": true, "kimi no": true, "yasashii": true, "tooku": true, "chikaku": true,
	"wasurenai": true, "aitai": true, "shinjite": true, "omoide": true, "toki": true, "basho": true, "michi": true,
}

// Very common English lyric words (to tell English from romaji).
var enWords = map[string]bool{
	"the": true, "you": true, "i": true, "and": true, "me": true, "my": true, "your": true, "is": true, "it": true,
	"in": true, "of": true, "that": true, "we": true, "love": true, "be": true, "all": true, "for": true, "on": true,
	"with": true, "what": true, "this": true, "dont": true, "know": true, "just": true, "can": true, "are": true,
	"but": true, "when": true, "like": true, "baby": true, "want": true, "never": true, "heart": true, "night": true,
	"im": true, "youre": true, "cause": true, "feel": true, "got": true, "way": true, "time": true, "now": true,
}

// DetectLyricsLang tells the language of song lyrics (LRC timestamps are
// ignored). Lyrics are long enough to judge by proportions, unlike titles,
// and romanised Japanese is recognised by its particles. "" when too short.
func DetectLyricsLang(text string) string {
	text = lrcTimeRe.ReplaceAllString(text, " ")
	var hangul, kana, han, thai, latin int
	for _, r := range text {
		switch {
		case unicode.Is(unicode.Hangul, r):
			hangul++
		case unicode.Is(unicode.Hiragana, r) || unicode.Is(unicode.Katakana, r):
			kana++
		case unicode.Is(unicode.Han, r):
			han++
		case unicode.Is(unicode.Thai, r):
			thai++
		case unicode.IsLetter(r):
			latin++
		}
	}
	total := hangul + kana + han + thai + latin
	// One CJK / Thai character carries about a word: weigh them so a short
	// verse of Japanese counts as much as a verse of English.
	if latin+3*(hangul+kana+han+thai) < 60 {
		return ""
	}
	share := func(n int) float64 { return float64(n) / float64(total) }
	switch {
	case share(hangul) >= 0.25:
		return LangKO
	case share(kana+han) >= 0.25 && kana >= 5:
		return LangJA
	case share(han) >= 0.25:
		return LangZH
	case share(thai) >= 0.25:
		return LangTH
	}
	low := strings.ToLower(text)
	words := strings.FieldsFunc(low, func(r rune) bool { return !unicode.IsLetter(r) && r != '\'' })
	if len(words) < 15 {
		return ""
	}
	var vi, viPlain, ro, en int
	for _, w := range words {
		if strings.ContainsAny(w, viLetters) {
			vi++
		}
		f := strings.ReplaceAll(Fold(w), "'", "")
		if viWords[f] {
			viPlain++
		}
		if romajiWords[f] {
			ro++
		}
		if enWords[f] {
			en++
		}
	}
	n := float64(len(words))
	switch {
	case float64(vi)/n >= 0.12:
		return LangVI
	case float64(ro)/n >= 0.1 && ro > en:
		return LangJA
	case float64(viPlain)/n >= 0.3 && viPlain > en*2:
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
