package server

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// ── background warm-up of external recommendation data ─────────────────

var warm struct {
	sync.Mutex
	last    map[string]time.Time
	running map[string]bool
}

// warmRecs fetches similar-artist data for a user's taste seeds so their next
// home page load has it. At most once every 10 minutes per user.
func (s *Server) warmRecs(uid string) {
	warm.Lock()
	if warm.last == nil {
		warm.last, warm.running = map[string]time.Time{}, map[string]bool{}
	}
	if time.Since(warm.last[uid]) < 10*time.Minute || warm.running[uid] {
		warm.Unlock()
		return
	}
	warm.last[uid], warm.running[uid] = time.Now(), true
	warm.Unlock()
	defer func() {
		warm.Lock()
		delete(warm.running, uid)
		warm.Unlock()
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	if _, err := s.newRecCtx(ctx, uid, true); err != nil {
		s.log.Warn("warm recs", "err", err)
		return
	}
	s.hub.Publish(uid, "recs", map[string]bool{"ready": true})
}

// ── reset (own data) ───────────────────────────────────────────────────

// handleReset wipes the signed-in user's data. scope=history clears listening
// history and recommendation signals; scope=all also empties their library,
// playlists, likes and downloads. Shared files go once nobody has them.
func (s *Server) handleReset(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Scope   string `json:"scope"`
		Confirm string `json:"confirm"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	if body.Confirm != "XOA" {
		httpError(w, http.StatusBadRequest, "Thiếu xác nhận")
		return
	}
	if body.Scope != "history" && body.Scope != "all" {
		httpError(w, http.StatusBadRequest, "Phạm vi không hợp lệ")
		return
	}
	u := userOf(r)
	if err := s.resetUser(u.ID, body.Scope); err != nil {
		s.internalError(w, r, err)
		return
	}
	s.log.Warn("user data reset", "user", u.ID, "scope", body.Scope)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// resetUser is shared with the admin page.
func (s *Server) resetUser(uid, scope string) error {
	var trackIDs []string
	if scope == "all" {
		// Stop this user's downloads so nothing is written back after the wipe.
		if rows, err := s.db.Query(`SELECT id FROM download_jobs WHERE user_id = ? AND status IN ('queued','downloading','processing')`, uid); err == nil {
			ids, _ := scanStrings(rows)
			for _, id := range ids {
				s.dl.cancel(id)
			}
		}
		rows, err := s.db.Query(`SELECT track_id FROM user_tracks WHERE user_id = ?`, uid)
		if err != nil {
			return err
		}
		trackIDs, _ = scanStrings(rows)
	}
	err := s.tx(func(exec func(string, ...any) error) error {
		qs := []string{
			`DELETE FROM listen_events WHERE user_id = ?`,
			`DELETE FROM feedback WHERE user_id = ?`,
			`UPDATE user_tracks SET play_count = 0, last_played_at = NULL WHERE user_id = ?`,
		}
		if scope == "all" {
			qs = append(qs,
				`DELETE FROM download_jobs WHERE user_id = ?`,
				`DELETE FROM playlists WHERE user_id = ?`,
				`DELETE FROM likes WHERE user_id = ?`,
				`DELETE FROM removed_tracks WHERE user_id = ?`,
				`DELETE FROM user_tracks WHERE user_id = ?`,
			)
		}
		for _, q := range qs {
			if err := exec(q, uid); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return err
	}
	for _, id := range trackIDs {
		s.gcTrack(id)
	}
	s.co.mu.Lock()
	delete(s.co.m, uid)
	s.co.mu.Unlock()
	s.hub.Publish(uid, "reset", map[string]string{"scope": scope})
	return nil
}

func (s *Server) tx(fn func(exec func(string, ...any) error) error) error {
	t, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer t.Rollback()
	if err := fn(func(q string, args ...any) error { _, err := t.Exec(q, args...); return err }); err != nil {
		return err
	}
	return t.Commit()
}

// emptyDir deletes the files directly inside dir (only regular files we wrote).
func emptyDir(dir string) error {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	for _, e := range entries {
		if e.Type().IsRegular() {
			if err := os.Remove(filepath.Join(dir, e.Name())); err != nil {
				return err
			}
		}
	}
	return nil
}
