package server

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func loadYTM(t *testing.T, file, kind string) []WebResult {
	t.Helper()
	b, err := os.ReadFile("testdata/" + file)
	if err != nil {
		t.Fatal(err)
	}
	var raw any
	if err := json.Unmarshal(b, &raw); err != nil {
		t.Fatal(err)
	}
	var out []WebResult
	for _, it := range collectYTMItems(raw) {
		if r, ok := parseYTMItem(it, kind); ok {
			out = append(out, r)
		}
	}
	return out
}

func TestParseYTMSongs(t *testing.T) {
	rs := loadYTM(t, "ytm_songs.json", "songs")
	if len(rs) < 10 {
		t.Fatalf("got %d songs", len(rs))
	}
	for _, r := range rs {
		t.Logf("%s | %s | %s | %s | %.0fs", r.ID, r.Title, r.Artist, r.Album, r.Duration)
		if r.Title == "" || r.Artist == "" || r.Duration <= 0 {
			t.Errorf("incomplete: %+v", r)
		}
	}
	if rs[0].Artist != "Hngle" || rs[0].Duration != 275 || rs[0].Album == "" {
		t.Errorf("first result: %+v", rs[0])
	}
}

func TestParseYTMVideos(t *testing.T) {
	rs := loadYTM(t, "ytm_videos.json", "videos")
	if len(rs) < 10 {
		t.Fatalf("got %d videos", len(rs))
	}
	for _, r := range rs {
		t.Logf("%s | %s | %s | %.0fs", r.ID, r.Title, r.Artist, r.Duration)
		if r.Title == "" || r.Artist == "" || r.Artist[0] >= '0' && r.Artist[0] <= '9' {
			t.Errorf("incomplete: %+v", r)
		}
	}
}

func TestParseClock(t *testing.T) {
	for in, want := range map[string]float64{"4:35": 275, "1:02:03": 3723, "0:59": 59} {
		if got := parseClock(in); got != want {
			t.Errorf("%s = %v, want %v", in, got, want)
		}
	}
}

func TestParseYTMCollections(t *testing.T) {
	for _, kind := range []string{"albums", "playlists"} {
		b, err := os.ReadFile("testdata/ytm_" + kind + ".json")
		if err != nil {
			t.Fatal(err)
		}
		var raw any
		if err := json.Unmarshal(b, &raw); err != nil {
			t.Fatal(err)
		}
		n := 0
		for _, it := range collectYTMItems(raw) {
			r, ok := parseYTMCollection(it, kind)
			if !ok {
				continue
			}
			n++
			t.Logf("%s | %s | %s | %s | %s", kind, r.ID, r.Title, r.Artist, r.Album)
			if r.Title == "" || r.Artist == "" || !listIDRe.MatchString(r.ID) {
				t.Errorf("incomplete: %+v", r)
			}
			if kind == "albums" && !strings.HasPrefix(r.ID, "OLAK5uy_") {
				t.Errorf("album id %q", r.ID)
			}
		}
		if n < 10 {
			t.Errorf("%s: got %d", kind, n)
		}
	}
}

func TestParseYTMBrowse(t *testing.T) {
	for file, id := range map[string]string{
		"ytm_browse_VLOLAK5uy_nNOucYz21o.json": "OLAK5uy_nNOucYz21oFgUHMu8vBsf7ixUC59BXquo",
		"ytm_browse_VLPLPNeWxUfSDNM9OyoT.json": "PLPNeWxUfSDNM9OyoTY_18h31K112noBNx",
	} {
		b, err := os.ReadFile("testdata/" + file)
		if err != nil {
			t.Fatal(err)
		}
		var raw any
		json.Unmarshal(b, &raw)
		l := parseYTMBrowse(raw, id)
		if len(l.Tracks) < 5 {
			t.Fatalf("%s: %d tracks", file, len(l.Tracks))
		}
		for _, tr := range l.Tracks {
			if tr.Title == "" || tr.Artist == "" || tr.Duration <= 0 || !videoIDRe.MatchString(tr.ID) {
				t.Errorf("%s: incomplete %+v", file, tr)
			}
		}
		t.Logf("%s: %q %q, %d tracks, first %q by %q (%.0fs)", file, l.Title, l.Subtitle, len(l.Tracks), l.Tracks[0].Title, l.Tracks[0].Artist, l.Tracks[0].Duration)
	}
}
