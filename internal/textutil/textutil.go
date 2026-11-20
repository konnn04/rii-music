// Package textutil holds Vietnamese-aware search normalisation and YouTube title cleaning.
package textutil

import (
	"regexp"
	"strings"
	"unicode"

	"golang.org/x/text/runes"
	"golang.org/x/text/transform"
	"golang.org/x/text/unicode/norm"
)

var dReplacer = strings.NewReplacer("đ", "d", "Đ", "d")

// Fold lowercases s and removes diacritics, so "Mùa Hè Đỏ" matches "mua he do".
// Safe for concurrent use: a transform.Chain keeps state between calls, so
// each call builds its own (sharing one crashed under concurrent requests).
func Fold(s string) string {
	s = strings.ToLower(s)
	s = dReplacer.Replace(s)
	stripMarks := transform.Chain(norm.NFD, runes.Remove(runes.In(unicode.Mn)), norm.NFC)
	out, _, err := transform.String(stripMarks, s)
	if err != nil {
		return s
	}
	return strings.Join(strings.Fields(out), " ")
}

// Terms splits a query into folded search terms.
func Terms(q string) []string {
	return strings.Fields(Fold(q))
}

// Meta is the subset of yt-dlp's info.json we use for naming a track.
type Meta struct {
	Title    string
	Track    string
	Artist   string
	Artists  []string
	Creator  string
	Uploader string
	Channel  string
	Album    string
}

var (
	bracketRe = regexp.MustCompile(`\s*[\(\[【「]([^\)\]】」]*)[\)\]】」]`)
	noiseRe   = regexp.MustCompile(`(?i)^\s*(official|official\s+(music\s+)?video|official\s+mv|official\s+audio|official\s+lyrics?(\s+video)?|music\s+video|mv|m/v|lyrics?|lyric\s+video|lyrics?\s+video|audio|video|visuali[sz]er|hd|hq|4k|8k|4k\s+upgrade|4k\s+remaster(ed)?|1080p|720p|official\s+hd\s+video|video\s+clip|clip|official\s+visuali[sz]er|vietsub|engsub|color\s+coded\s+lyrics)\s*$`)
	tailNoise = regexp.MustCompile(`(?i)\s*[-–—|]?\s*(official\s+(music\s+)?video|official\s+mv|official\s+audio|music\s+video|lyric\s+video|m/v|\bmv\b)\s*$`)
	dashRe    = regexp.MustCompile(`\s+[-–—]\s+`)
	spaceRe   = regexp.MustCompile(`\s{2,}`)
)

// CleanMeta turns raw YouTube metadata into artist / title / album.
// "Nghệ sĩ - Bài (Official MV)" becomes artist "Nghệ sĩ", title "Bài".
func CleanMeta(m Meta) (artist, title, album string) {
	album = strings.TrimSpace(m.Album)

	// YouTube Music "art tracks" carry clean fields already.
	if strings.TrimSpace(m.Track) != "" {
		title = strings.TrimSpace(m.Track)
		switch {
		case len(m.Artists) > 0:
			artist = strings.Join(m.Artists, ", ")
		case m.Artist != "":
			artist = m.Artist
		case m.Creator != "":
			artist = m.Creator
		default:
			artist = cleanUploader(firstNonEmpty(m.Uploader, m.Channel))
		}
		return strings.TrimSpace(artist), title, album
	}

	raw := strings.TrimSpace(m.Title)
	// Drop bracketed noise: (Official MV), [Lyrics], 【4K】 ...
	raw = bracketRe.ReplaceAllStringFunc(raw, func(s string) string {
		inner := bracketRe.FindStringSubmatch(s)[1]
		if noiseRe.MatchString(inner) {
			return ""
		}
		return s
	})

	// "Bài | Nghệ sĩ | Official MV" → keep meaningful pipe segments.
	segs := strings.Split(raw, "|")
	clean := make([]string, 0, len(segs))
	for _, s := range segs {
		s = strings.TrimSpace(s)
		if s == "" || noiseRe.MatchString(s) {
			continue
		}
		clean = append(clean, s)
	}
	pipeArtist := ""
	if len(clean) > 0 {
		raw = clean[0]
		if len(clean) > 1 && !dashRe.MatchString(raw) {
			pipeArtist = clean[1]
		}
	}
	raw = tailNoise.ReplaceAllString(raw, "")

	if parts := dashRe.Split(raw, 2); len(parts) == 2 && parts[0] != "" && parts[1] != "" {
		artist, title = parts[0], parts[1]
		// "Bài - Nghệ sĩ" is common too: put the side that looks more like the
		// artist (names the channel, has "ft.") first.
		// "ft." alone never decides: "Nghệ sĩ - Bài ft. X" is just as common.
		if r, l := artistScore(title, m), artistScore(artist, m); r >= 3 && r > l {
			artist, title = title, artist
		}
	} else {
		title = raw
		artist = firstNonEmpty(pipeArtist, m.Artist, m.Creator, cleanUploader(firstNonEmpty(m.Uploader, m.Channel)))
		// "Nghệ sĩ | Bài | Official MV": the first segment names the artist, so swap.
		if pipeArtist != "" {
			if l, r := artistScore(title, m), artistScore(artist, m); l >= 3 && l > r {
				artist, title = title, artist
			}
		}
	}
	title = spaceRe.ReplaceAllString(strings.Trim(strings.TrimSpace(title), "-–—|"), " ")
	artist = spaceRe.ReplaceAllString(strings.TrimSpace(artist), " ")
	if title == "" {
		title = strings.TrimSpace(m.Title)
	}
	return strings.TrimSpace(artist), strings.TrimSpace(title), album
}

var (
	featRe      = regexp.MustCompile(`(?i)(\bft\.?\s|\bfeat\.?\s|\bfeaturing\s|\s[x×]\s)`)
	artistSplit = regexp.MustCompile(`(?i)\s*(?:,|&|\bft\.?|\bfeat\.?|\bfeaturing\b|\s[x×]\s|\(|\))\s*`)
)

// artistScore says how much one side of "A - B" looks like the artist name:
// it names the uploading channel (or yt-dlp's artist/creator), or joins
// several names with "ft." / "x".
func artistScore(side string, m Meta) int {
	f := Fold(side)
	score := 0
	for _, ref := range []string{cleanUploader(m.Uploader), cleanUploader(m.Channel), m.Artist, m.Creator} {
		r := Fold(ref)
		if len(r) < 2 {
			continue
		}
		if f == r || strings.Contains(f, r) {
			score += 3
			break
		}
		// "Emcee L (Da LAB)" vs channel "Emcee L": any named part matching counts.
		hit := false
		for _, p := range artistSplit.Split(side, -1) {
			if fp := Fold(p); len(fp) >= 3 && (fp == r || strings.Contains(r, fp)) {
				hit = true
				break
			}
		}
		if hit {
			score += 3
			break
		}
	}
	if featRe.MatchString(" " + side + " ") {
		score++
	}
	return score
}

var uploaderNoise = regexp.MustCompile(`(?i)(\s*-\s*topic|vevo|\s+official(\s+channel)?)$`)

func cleanUploader(s string) string {
	return strings.TrimSpace(uploaderNoise.ReplaceAllString(strings.TrimSpace(s), ""))
}

func firstNonEmpty(v ...string) string {
	for _, s := range v {
		if strings.TrimSpace(s) != "" {
			return strings.TrimSpace(s)
		}
	}
	return ""
}
