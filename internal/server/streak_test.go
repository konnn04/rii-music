package server

import (
	"testing"
	"time"
)

func TestStreak(t *testing.T) {
	s, ts := newTestServer(t)
	_, uid := loginAdmin(t, ts.URL)
	seedTrack(t, s, uid, hexID(1), "Bài", "Ca Sĩ", "vi")
	listen := func(daysAgo int, minutes int) {
		at := time.Now().AddDate(0, 0, -daysAgo).Add(-time.Minute)
		s.db.Exec(`INSERT INTO listen_events(user_id, track_id, started_at, played_ms, action, hour, source) VALUES (?,?,?,?,?,?,?)`,
			uid, hexID(1), at.UnixMilli(), int64(minutes)*60_000, "finish", at.Hour(), "")
	}
	// A 4-day run that ended yesterday (today not yet), and an older 8-day run.
	for d := 1; d <= 4; d++ {
		listen(d, 12)
	}
	listen(0, 3) // today: 3 minutes, not enough yet
	for d := 10; d < 18; d++ {
		listen(d, 30)
	}
	listen(6, 5) // too short to count

	st, err := s.streakFor(uid, 0)
	if err != nil {
		t.Fatal(err)
	}
	if st.Current != 4 || !st.AtRisk || st.TodayDone {
		t.Errorf("current = %d, atRisk = %v, todayDone = %v; want 4, true, false", st.Current, st.AtRisk, st.TodayDone)
	}
	if st.Best != 8 || st.Stage != 2 || st.NextStageAt != 14 {
		t.Errorf("best = %d, stage = %d, next = %d; want 8, 2, 14", st.Best, st.Stage, st.NextStageAt)
	}
	if st.TodayMinutes != 3 || len(st.Week) != 7 || st.Week[6] != 3 {
		t.Errorf("today = %d, week = %v", st.TodayMinutes, st.Week)
	}
	listen(0, 10) // today done now
	st, _ = s.streakFor(uid, 0)
	if st.Current != 5 || !st.TodayDone || st.AtRisk {
		t.Errorf("after today: current = %d, todayDone = %v", st.Current, st.TodayDone)
	}
}

func TestServerLimits(t *testing.T) {
	s, ts := newTestServer(t)
	admin, _ := loginAdmin(t, ts.URL)
	_, st := admin.do("GET", "/api/settings", nil)
	lim, _ := st["limits"].(map[string]any)
	if lim == nil || lim["autoplayTarget"].(float64) != 10 || lim["autoplayDownloads"].(float64) != 6 {
		t.Fatalf("default limits = %v", st["limits"])
	}
	if code, _ := admin.do("PUT", "/api/admin/settings", map[string]any{"audioFormat": "m4a", "bitrate": 192, "autoplayTarget": 25, "autoplayDownloads": 0, "autoDlPerRun": 99, "playlistMax": 30}); code != 200 {
		t.Fatal("save limits", code)
	}
	srv := s.serverSettings()
	if srv.AutoplayTarget != 25 || srv.AutoplayDownloads != 0 || srv.AutoDLPerRun != 50 || srv.PlaylistMax != 30 {
		t.Errorf("server settings = %+v", srv)
	}
	// The user's settings carry the limits but never store them.
	_, st = admin.do("GET", "/api/settings", nil)
	if code, _ := admin.do("PUT", "/api/settings", st); code != 200 && code != 204 {
		t.Fatalf("save user settings with limits: %d", code)
	}
	var raw string
	s.db.QueryRow(`SELECT settings_json FROM users WHERE email = 'admin@example.com'`).Scan(&raw)
	if raw == "" || contains(raw, "autoplayTarget") {
		t.Errorf("limits stored per user: %s", raw)
	}
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
