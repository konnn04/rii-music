package server

import (
	"encoding/json"
	"net/http"
	"testing"
)

func TestFollowArtists(t *testing.T) {
	s, ts := newTestServer(t)
	admin, uid := loginAdmin(t, ts.URL)
	seedTrack(t, s, uid, hexID(1), "Lạc Trôi", "Sơn Tùng M-TP", "vi")
	seedTrack(t, s, uid, hexID(2), "Bài khác", "Ca Sĩ Khác, SƠN TÙNG M-TP", "vi")

	list := func() []FollowedArtist {
		t.Helper()
		res, err := admin.hc.Get(ts.URL + "/api/follows")
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		var out []FollowedArtist
		json.NewDecoder(res.Body).Decode(&out)
		return out
	}

	if code, _ := admin.do("PUT", "/api/follows", map[string]string{"name": "Sơn Tùng M-TP", "image": "javascript:alert(1)"}); code != http.StatusOK {
		t.Fatal("follow", code)
	}
	// Same artist written differently: still one follow.
	admin.do("PUT", "/api/follows", map[string]string{"name": "son tung mtp"})
	admin.do("PUT", "/api/follows", map[string]string{"name": "아이유"})
	if code, _ := admin.do("PUT", "/api/follows", map[string]string{"name": "  "}); code != http.StatusBadRequest {
		t.Error("empty name should be refused", code)
	}

	got := list()
	if len(got) != 2 {
		t.Fatalf("follows = %+v", got)
	}
	var st FollowedArtist
	for _, f := range got {
		if f.Key == "sontungmtp" {
			st = f
		}
	}
	if st.Name != "Sơn Tùng M-TP" || st.TrackCount != 2 || st.Image != "" {
		t.Errorf("followed artist = %+v (want the first spelling, 2 songs incl. featured, no unsafe image)", st)
	}

	// The follow lifts the artist in the taste profile.
	all, _ := s.libTracks(uid, "")
	tp, err := s.buildTaste(uid, all)
	if err != nil {
		t.Fatal(err)
	}
	if tp.artist["sontungmtp"] < followWeight {
		t.Errorf("taste affinity = %.2f", tp.artist["sontungmtp"])
	}

	if code, _ := admin.do("DELETE", "/api/follows?name=SON+TUNG+M-TP", nil); code != http.StatusOK {
		t.Fatal("unfollow", code)
	}
	admin.do("DELETE", "/api/follows?name=%EC%95%84%EC%9D%B4%EC%9C%A0", nil)
	if got := list(); len(got) != 0 {
		t.Errorf("after unfollow: %+v", got)
	}

	// Another user sees none of it.
	other := newClient(t, ts.URL)
	if code, _ := other.do("GET", "/api/follows", nil); code != http.StatusUnauthorized {
		t.Error("signed-out list", code)
	}
}
