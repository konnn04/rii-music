package server

import (
	"context"
	"math"
	"net/url"
	"regexp"
	"strings"

	"rii_music/internal/textutil"
)

// Styles: genre tags (Deezer album genres, Last.fm tags) folded into a few
// buckets that matter when choosing what plays next, so a bolero radio
// doesn't drift into V-pop or EDM, and lofi / soundtracks stay apart.

type styleVec map[string]float64

// styleRules: tag substring (folded, lower case) → bucket and weight. Order
// matters only for readability; every matching rule adds.
var styleRules = []struct {
	match  []string
	bucket string
	w      float64
}{
	{[]string{"bolero", "tru tinh", "nhac vang", "que huong", "dan ca", "nhac xua", "cai luong", "vong co"}, "bolero", 1},
	{[]string{"v-pop", "vpop", "nhac tre", "vietnamese pop"}, "vpop", 1},
	{[]string{"rap", "hip hop", "hip-hop", "hiphop", "trap", "drill", "grime"}, "rap", 1},
	{[]string{"r&b", "rnb", "soul", "neo soul"}, "rnb", 1},
	{[]string{"edm", "electronic", "electro", "dance", "house", "techno", "trance", "dubstep", "vinahouse", "drum and bass", "future bass"}, "edm", 1},
	{[]string{"rock", "metal", "punk", "grunge", "emo"}, "rock", 1},
	{[]string{"indie"}, "indie", 0.8},
	{[]string{"ballad"}, "ballad", 0.8},
	{[]string{"lofi", "lo-fi", "chillhop", "ambient", "study"}, "lofi", 1},
	{[]string{"acoustic", "folk", "singer-songwriter", "unplugged"}, "acoustic", 0.8},
	{[]string{"jazz", "blues", "bossa", "swing"}, "jazz", 1},
	{[]string{"classical", "orchestra", "piano", "instrumental", "soundtrack", "ost", "score", "bgm", "game music"}, "instrumental", 1},
	{[]string{"k-pop", "kpop", "korean"}, "kpop", 1},
	{[]string{"j-pop", "jpop", "j-rock", "anime", "japanese", "vocaloid", "city pop"}, "jpop", 1},
	{[]string{"c-pop", "cpop", "mandopop", "cantopop", "chinese"}, "cpop", 1},
	{[]string{"latin", "reggaeton", "salsa", "bachata"}, "latin", 1},
	{[]string{"country"}, "country", 1},
	{[]string{"pop"}, "pop", 0.35}, // everywhere: weak
}

// styleOf maps genre tags (best first) to a normalised style vector.
func styleOf(tags []string) styleVec {
	v := styleVec{}
	for i, t := range tags {
		t = textutil.Fold(t)
		rank := 1 / (1 + 0.25*float64(i)) // earlier tags count more
		for _, r := range styleRules {
			for _, m := range r.match {
				if strings.Contains(t, m) {
					v[r.bucket] += r.w * rank
					break
				}
			}
		}
	}
	var n float64
	for _, x := range v {
		n += x * x
	}
	if n == 0 {
		return nil
	}
	n = math.Sqrt(n)
	for k := range v {
		v[k] /= n
	}
	return v
}

// styleSim: cosine of two style vectors; -1 when either is unknown.
func styleSim(a, b styleVec) float64 {
	if len(a) == 0 || len(b) == 0 {
		return -1
	}
	var d float64
	for k, x := range a {
		d += x * b[k]
	}
	return d
}

// styleFactor scales a recommendation score by how close the styles are:
// unknown → unchanged, same style → ×1, unrelated → ×0.15.
func styleFactor(a, b styleVec) float64 {
	sim := styleSim(a, b)
	if sim < 0 {
		return 1
	}
	return 0.15 + 0.85*sim
}

// styleConflict: both styles known and clearly different (e.g. bolero vs EDM).
func styleConflict(a, b styleVec) bool {
	sim := styleSim(a, b)
	return sim >= 0 && sim < 0.2
}

// ── kinds: songs vs long mixes, lofi, BGM, karaoke… ──────────────────────

// specialRe: titles of things that are not a regular song.
var specialRe = regexp.MustCompile(`(?i)(lo-?fi|\bbgm\b|karaoke|instrumental|non-?stop|liên khúc|lien khuc|medley|\bslowed\b|\breverb\b|\b8d\b|\b\d+\s*(hour|hours|giờ|gio)\b|\bmix\b|mixtape|\bplaylist\b|không lời|khong loi|[(\[]\s*beat\s*[)\]]|-\s*beat\b|beat ver|nhạc nền|nhac nen|tuyển tập|tuyen tap|full album|compilation|study music|sleep music|relaxing music)`)

const longSongMs = 9 * 60_000

type songKind struct {
	special bool // lofi, BGM, karaoke, a mix…
	long    bool // over 9 minutes
	durMs   int64
}

func kindOf(title string, durMs int64) songKind {
	return songKind{special: specialRe.MatchString(title), long: durMs > longSongMs, durMs: durMs}
}

// kindCompatible: may c follow seed? Listening to regular songs, no mixes,
// lofi or tracks much longer than the seed; listening to lofi / a long mix,
// anything (the style decides).
func kindCompatible(seed, c songKind) bool {
	if seed.special || seed.long {
		return true
	}
	if c.special || c.long {
		return false
	}
	if seed.durMs > 0 && c.durMs > 0 && c.durMs > max(2*seed.durMs, seed.durMs+4*60_000) {
		return false
	}
	return true
}

// librarySongStyles: every library song's style, falling back to its artist's
// (from the artist's other songs) when the song has no tags.
func librarySongStyles(all []Track) map[string]styleVec {
	out := make(map[string]styleVec, len(all))
	artist := map[string]styleVec{}
	for _, t := range all {
		v := styleOf(t.Genres)
		if v == nil {
			continue
		}
		out[t.ID] = v
		for _, a := range splitArtists(t.Artist) {
			k := looseName(a)
			if artist[k] == nil {
				artist[k] = styleVec{}
			}
			for b, x := range v {
				artist[k][b] += x
			}
		}
	}
	for _, t := range all {
		if out[t.ID] != nil {
			continue
		}
		sum := styleVec{}
		for _, a := range splitArtists(t.Artist) {
			for b, x := range artist[looseName(a)] {
				sum[b] += x
			}
		}
		if len(sum) > 0 {
			out[t.ID] = normalise(sum)
		}
	}
	return out
}

func normalise(v styleVec) styleVec {
	var n float64
	for _, x := range v {
		n += x * x
	}
	if n == 0 {
		return nil
	}
	n = math.Sqrt(n)
	out := styleVec{}
	for k, x := range v {
		out[k] = x / n
	}
	return out
}

// ArtistTags: an artist's top Last.fm tags (cached 7 days). Empty without a key.
func (e *extClient) ArtistTags(ctx context.Context, name string, cacheOnly bool) ([]string, error) {
	k := e.s.cfg.LastfmKey
	if k == "" || strings.TrimSpace(name) == "" {
		return nil, nil
	}
	var out []string
	_, err := e.cached(ctx, "lfartisttags:"+textutil.Fold(name), cacheOnly, &out, func(ctx context.Context) (any, error) {
		var r struct {
			Error   int `json:"error"`
			TopTags struct {
				Tag []struct {
					Name  string `json:"name"`
					Count int    `json:"count"`
				} `json:"tag"`
			} `json:"toptags"`
		}
		q := url.Values{"method": {"artist.gettoptags"}, "artist": {name}, "api_key": {k}, "format": {"json"}, "autocorrect": {"1"}}
		if err := e.getJSON(ctx, "https://ws.audioscrobbler.com/2.0/?"+q.Encode(), &r); err != nil {
			return nil, err
		}
		tags := []string{}
		for i, t := range r.TopTags.Tag {
			if i >= 8 || t.Count < 10 {
				break
			}
			tags = append(tags, strings.ToLower(strings.TrimSpace(t.Name)))
		}
		return tags, nil
	})
	return out, err
}
