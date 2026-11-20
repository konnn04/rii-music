package server

import (
	"encoding/json"
	"os"
	"testing"

	"rii_music/internal/textutil"
)

// Real /next responses: names come from YouTube Music, not from guessing.
func TestTrackMetaFromYTM(t *testing.T) {
	cases := []struct {
		vid, artist, title string
		ytdlp              textutil.Meta // what yt-dlp alone would give
	}{
		// OMV whose YouTube title is "Bài - Nghệ sĩ": used to come out reversed.
		{"redFrGBZoJY", "Da LAB", "Sinh Ra Đã Là Thứ Đối Lập Nhau", textutil.Meta{Title: "Sinh Ra Đã Là Thứ Đối Lập Nhau - Emcee L (Da LAB) ft. Badbies | Official MV", Uploader: "Da LAB Official"}},
		// OMV with a raw title: the linked artist tells the sides apart.
		{"6eONmnFB9sw", "Emcee L (Da LAB) ft Muộii", "Chuyện Đôi Ta", textutil.Meta{Title: "Chuyện Đôi Ta - Emcee L (Da LAB) ft Muộii (Official MV)"}},
		// "Nghệ sĩ x Nghệ sĩ | Bài".
		{"KGyPe6h4BIE", "Hà Anh Tuấn, Bùi Anh Tuấn", "Hoang Mang", textutil.Meta{Title: "[FRAGILE+ IN SAIGON] Hoang Mang | Hà Anh Tuấn - Bùi Anh Tuấn"}},
		// Official song (ATV): clean fields as they are.
		{"PnGk00MuNM4", "Hngle", "Tìm Em (feat. Bảo Anh)", textutil.Meta{Title: "Tìm Em"}},
	}
	for _, c := range cases {
		b, err := os.ReadFile("testdata/ytm_next_" + c.vid + ".json")
		if err != nil {
			t.Fatal(err)
		}
		var raw any
		json.Unmarshal(b, &raw)
		v, ok := parseYTMNext(raw, c.vid)
		if !ok {
			t.Fatalf("%s: no metadata", c.vid)
		}
		a, ti, _ := trackMeta(v, c.ytdlp)
		t.Logf("%s [%s] → %q / %q", c.vid, v.Type, a, ti)
		if c.vid == "KGyPe6h4BIE" {
			// YouTube Music lists both singers; the title is "A x B | Bài".
			if ti != c.title {
				t.Errorf("%s: title %q, want %q", c.vid, ti, c.title)
			}
			continue
		}
		if a != c.artist || ti != c.title {
			t.Errorf("%s: got (%q, %q), want (%q, %q)", c.vid, a, ti, c.artist, c.title)
		}
	}
}
