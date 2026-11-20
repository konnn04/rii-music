package server

import (
	"net/http"
	"testing"
	"time"
)

func TestListenTogetherRoom(t *testing.T) {
	s, ts := newTestServer(t)
	host, hostID := loginAdmin(t, ts.URL)
	seedTrack(t, s, hostID, hexID(1), "Bài Một", "Ca Sĩ", "vi")
	seedTrack(t, s, hostID, hexID(2), "Bài Hai", "Ca Sĩ", "vi")
	if code, _ := host.do("POST", "/api/admin/users", map[string]any{"email": "ban@example.com", "name": "Bạn", "password": "friend-pass-1", "storageLimitMb": 512}); code != 201 {
		t.Fatal("create friend", code)
	}
	friend := newClient(t, ts.URL)
	if code, _ := friend.do("POST", "/api/auth/login", map[string]string{"email": "ban@example.com", "password": "friend-pass-1"}); code != 200 {
		t.Fatal("friend login", code)
	}
	_, me := friend.do("GET", "/api/me", nil)
	friendID := me["user"].(map[string]any)["id"].(string)

	// The friend can't play the host's song before joining.
	if code, _ := friend.do("GET", "/api/tracks/"+hexID(1)+"/stream", nil); code != 404 {
		t.Fatalf("stream before joining: %d", code)
	}
	// A queue with a song the host doesn't have is refused.
	if code, _ := host.do("POST", "/api/rooms", map[string]any{"queue": []string{hexID(9)}, "index": 0}); code != 404 {
		t.Fatalf("room with a foreign song: %d", code)
	}
	code, created := host.do("POST", "/api/rooms", map[string]any{"queue": []string{hexID(1), hexID(2)}, "index": 0, "positionMs": 1000, "playing": true})
	if code != 200 {
		t.Fatalf("create room: %d %v", code, created)
	}
	room := created["room"].(map[string]any)
	roomCode := room["code"].(string)
	if len(roomCode) != 6 {
		t.Fatalf("code %q", roomCode)
	}

	if code, _ := friend.do("POST", "/api/rooms/ZZZZZZ/join", nil); code != 404 {
		t.Fatalf("wrong code: %d", code)
	}
	code, joined := friend.do("POST", "/api/rooms/"+roomCode+"/join", nil)
	if code != 200 || len(joined["tracks"].([]any)) != 2 {
		t.Fatalf("join: %d %v", code, joined)
	}
	// Joining twice keeps one slot.
	friend.do("POST", "/api/rooms/"+roomCode+"/join", nil)
	_, got := friend.do("GET", "/api/rooms/"+roomCode, nil)
	if n := len(got["room"].(map[string]any)["members"].([]any)); n != 2 {
		t.Fatalf("members = %d", n)
	}
	// Members can stream the room's songs.
	if code, _ := friend.do("GET", "/api/tracks/"+hexID(1)+"/stream", nil); code == 404 {
		t.Fatal("member can't stream the room's song")
	}
	// Listeners can't change what plays; controllers can.
	if code, _ := friend.do("POST", "/api/rooms/"+roomCode+"/state", map[string]any{"queue": []string{hexID(2)}, "index": 0, "playing": true}); code != 403 {
		t.Fatalf("listener changes state: %d", code)
	}
	if code, _ := friend.do("POST", "/api/rooms/"+roomCode+"/role", map[string]any{"userId": hostID, "role": "listener"}); code != 403 {
		t.Fatalf("listener sets roles: %d", code)
	}
	if code, _ := host.do("POST", "/api/rooms/"+roomCode+"/role", map[string]any{"userId": friendID, "role": "controller"}); code != 204 {
		t.Fatalf("host sets role: %d", code)
	}
	code, st := friend.do("POST", "/api/rooms/"+roomCode+"/state", map[string]any{"queue": []string{hexID(2), hexID(1)}, "index": 0, "positionMs": 5000, "playing": false})
	if code != 200 || st["rev"].(float64) != 2 {
		t.Fatalf("controller changes state: %d %v", code, st)
	}
	// Back in the room after a reload.
	_, mine := friend.do("GET", "/api/rooms/mine", nil)
	if mine["room"] == nil {
		t.Fatal("rooms/mine is empty")
	}

	// Silent members show as disconnected; an idle room closes.
	s.rooms.mu.Lock()
	r := s.rooms.rooms[roomCode]
	for _, m := range r.members {
		m.lastSeen = time.Now().Add(-2 * time.Minute)
	}
	s.rooms.mu.Unlock()
	s.roomSweep()
	_, got = host.do("GET", "/api/rooms/"+roomCode, nil) // this request counts as the host being back
	for _, m := range got["room"].(map[string]any)["members"].([]any) {
		mm := m.(map[string]any)
		if mm["userId"] == friendID && mm["connected"] != false {
			t.Error("silent friend still connected")
		}
	}

	// The host closes the room: nobody is in it, and the songs are private again.
	if code, _ := friend.do("DELETE", "/api/rooms/"+roomCode, nil); code != 403 {
		t.Fatalf("member closes room: %d", code)
	}
	if code, _ := host.do("DELETE", "/api/rooms/"+roomCode, nil); code != 204 {
		t.Fatalf("close: %d", code)
	}
	if code, _ := friend.do("GET", "/api/rooms/"+roomCode, nil); code != 404 {
		t.Fatalf("closed room: %d", code)
	}
	if code, _ := friend.do("GET", "/api/tracks/"+hexID(1)+"/stream", nil); code != 404 {
		t.Fatalf("stream after close: %d", code)
	}
	if code, _ := friend.do("POST", "/api/playback/command", map[string]any{"target": "dev1", "cmd": "explode"}); code != http.StatusBadRequest {
		t.Fatalf("bad remote command: %d", code)
	}
	if code, _ := host.do("POST", "/api/playback/command", map[string]any{"target": "dev1", "cmd": "seek", "positionMs": 3000}); code != http.StatusNoContent {
		t.Fatalf("remote seek: %d", code)
	}
}
