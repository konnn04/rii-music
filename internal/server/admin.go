package server

import (
	"context"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"rii_music/internal/db"
)

// ── users ───────────────────────────────────────────────────────────────

type adminUser struct {
	User
	UsedBytes    int64  `json:"usedBytes"`
	Tracks       int    `json:"tracks"`
	Plays30d     int    `json:"plays30d"`
	LastListenAt int64  `json:"lastListenAt"`
	Online       bool   `json:"online"`
	AutoDownload bool   `json:"autoDownload"`
	ActiveJobs   int    `json:"activeJobs"`
	Note         string `json:"note,omitempty"`
}

func (s *Server) adminUserInfo(u *User, online map[string]bool) adminUser {
	a := adminUser{User: *u, Online: online[u.ID], AutoDownload: s.loadSettings(u.ID).AutoDownload}
	a.UsedBytes, a.Tracks = s.userUsage(u.ID)
	since := time.Now().Add(-30 * 24 * time.Hour).UnixMilli()
	s.db.QueryRow(`SELECT COUNT(*), COALESCE(MAX(started_at), 0) FROM listen_events WHERE user_id = ? AND started_at >= ?`, u.ID, since).Scan(&a.Plays30d, &a.LastListenAt)
	if a.LastListenAt == 0 {
		s.db.QueryRow(`SELECT COALESCE(MAX(started_at), 0) FROM listen_events WHERE user_id = ?`, u.ID).Scan(&a.LastListenAt)
	}
	s.db.QueryRow(`SELECT COUNT(*) FROM download_jobs WHERE user_id = ? AND status IN ('queued','downloading','processing')`, u.ID).Scan(&a.ActiveJobs)
	return a
}

func (s *Server) listUsers() ([]*User, error) {
	rows, err := s.db.Query(`SELECT ` + userCols + ` FROM users ORDER BY created_at`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*User{}
	for rows.Next() {
		u, err := scanUser(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, u)
	}
	return out, rows.Err()
}

func (s *Server) handleAdminListUsers(w http.ResponseWriter, r *http.Request) {
	us, err := s.listUsers()
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	online := s.hub.online()
	out := make([]adminUser, 0, len(us))
	for _, u := range us {
		out = append(out, s.adminUserInfo(u, online))
	}
	writeJSON(w, http.StatusOK, map[string]any{"users": out, "defaultStorageMb": s.cfg.DefaultStorageMB, "mailConfigured": s.cfg.MailConfigured()})
}

func validRole(r string) bool { return r == "admin" || r == "listener" }

func validLimit(mb int) bool { return mb >= 64 && mb <= 1<<22 }

func (s *Server) handleAdminCreateUser(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Email          string `json:"email"`
		Name           string `json:"name"`
		Role           string `json:"role"`
		StorageLimitMB int    `json:"storageLimitMb"`
		Password       string `json:"password"`
		SendInvite     bool   `json:"sendInvite"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	email, ok := normEmail(body.Email)
	if !ok {
		httpError(w, http.StatusBadRequest, "Email không hợp lệ")
		return
	}
	if body.Role == "" {
		body.Role = "listener"
	}
	if !validRole(body.Role) {
		httpError(w, http.StatusBadRequest, "Vai trò không hợp lệ")
		return
	}
	if body.StorageLimitMB == 0 {
		body.StorageLimitMB = s.cfg.DefaultStorageMB
	}
	if !validLimit(body.StorageLimitMB) {
		httpError(w, http.StatusBadRequest, "Giới hạn dung lượng không hợp lệ")
		return
	}
	name := strings.TrimSpace(body.Name)
	if len([]rune(name)) > 80 {
		httpError(w, http.StatusBadRequest, "Tên tối đa 80 ký tự")
		return
	}
	hash := ""
	if body.Password != "" {
		if err := validPassword(body.Password); err != nil {
			httpError(w, http.StatusBadRequest, err.Error())
			return
		}
		h, err := hashPassword(body.Password)
		if err != nil {
			s.internalError(w, r, err)
			return
		}
		hash = h
	} else if !s.cfg.MailConfigured() {
		httpError(w, http.StatusBadRequest, "Máy chủ chưa cấu hình email nên người này không nhận được mã đăng nhập: đặt mật khẩu ban đầu cho họ")
		return
	}
	id := newID()
	_, err := s.db.Exec(`INSERT INTO users(id, email, name, pass_hash, role, storage_limit_mb, created_at) VALUES (?,?,?,?,?,?,?)`,
		id, email, name, hash, body.Role, body.StorageLimitMB, nowMs())
	if err != nil {
		if db.IsUniqueViolation(err) {
			httpError(w, http.StatusConflict, "Email này đã có tài khoản")
			return
		}
		s.internalError(w, r, err)
		return
	}
	u, _ := s.userByID(id)
	info := s.adminUserInfo(u, nil)
	if body.SendInvite && s.cfg.MailConfigured() {
		if err := s.sendMail(email, "Bạn được mời dùng RiiMusic", inviteEmail(email, name, s.cfg.PublicURL)); err != nil {
			s.log.Warn("invite email", "err", err)
			info.Note = "Đã tạo tài khoản nhưng gửi email mời thất bại"
		}
	}
	s.log.Info("admin created user", "admin", userOf(r).ID, "user", id, "role", body.Role)
	writeJSON(w, http.StatusCreated, info)
}

func (s *Server) adminCount() int {
	var n int
	s.db.QueryRow(`SELECT COUNT(*) FROM users WHERE role = 'admin' AND disabled = 0`).Scan(&n)
	return n
}

func (s *Server) targetUser(w http.ResponseWriter, r *http.Request) *User {
	u, err := s.userByID(r.PathValue("id"))
	if err != nil {
		httpError(w, http.StatusNotFound, "Không có người dùng này")
		return nil
	}
	return u
}

func (s *Server) handleAdminPatchUser(w http.ResponseWriter, r *http.Request) {
	me := userOf(r)
	u := s.targetUser(w, r)
	if u == nil {
		return
	}
	var body struct {
		Name           *string `json:"name"`
		Email          *string `json:"email"`
		Role           *string `json:"role"`
		StorageLimitMB *int    `json:"storageLimitMb"`
		Disabled       *bool   `json:"disabled"`
		Password       *string `json:"password"`
		SignOut        bool    `json:"signOut"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	self := u.ID == me.ID
	if body.Role != nil {
		if !validRole(*body.Role) {
			httpError(w, http.StatusBadRequest, "Vai trò không hợp lệ")
			return
		}
		if *body.Role != u.Role && self {
			httpError(w, http.StatusBadRequest, "Không tự đổi vai trò của chính mình")
			return
		}
		if u.Role == "admin" && *body.Role != "admin" && s.adminCount() <= 1 {
			httpError(w, http.StatusBadRequest, "Phải còn ít nhất một admin")
			return
		}
	}
	if body.Disabled != nil && *body.Disabled {
		if self {
			httpError(w, http.StatusBadRequest, "Không tự khoá tài khoản của chính mình")
			return
		}
		if u.Role == "admin" && s.adminCount() <= 1 {
			httpError(w, http.StatusBadRequest, "Phải còn ít nhất một admin")
			return
		}
	}
	if body.StorageLimitMB != nil && !validLimit(*body.StorageLimitMB) {
		httpError(w, http.StatusBadRequest, "Giới hạn dung lượng không hợp lệ")
		return
	}
	if body.Password != nil {
		if err := validPassword(*body.Password); err != nil {
			httpError(w, http.StatusBadRequest, err.Error())
			return
		}
	}
	if body.Email != nil {
		e, ok := normEmail(*body.Email)
		if !ok {
			httpError(w, http.StatusBadRequest, "Email không hợp lệ")
			return
		}
		if _, err := s.db.Exec(`UPDATE users SET email = ? WHERE id = ?`, e, u.ID); err != nil {
			if db.IsUniqueViolation(err) {
				httpError(w, http.StatusConflict, "Email này đã có tài khoản")
				return
			}
			s.internalError(w, r, err)
			return
		}
	}
	if body.Name != nil {
		n := strings.TrimSpace(*body.Name)
		if len([]rune(n)) > 80 {
			httpError(w, http.StatusBadRequest, "Tên tối đa 80 ký tự")
			return
		}
		s.db.Exec(`UPDATE users SET name = ? WHERE id = ?`, n, u.ID)
	}
	if body.Role != nil {
		s.db.Exec(`UPDATE users SET role = ? WHERE id = ?`, *body.Role, u.ID)
	}
	if body.StorageLimitMB != nil {
		s.db.Exec(`UPDATE users SET storage_limit_mb = ? WHERE id = ?`, *body.StorageLimitMB, u.ID)
		go s.enforceBudget(context.Background(), u.ID)
	}
	if body.Disabled != nil {
		s.db.Exec(`UPDATE users SET disabled = ?, session_version = session_version + ? WHERE id = ?`, *body.Disabled, boolInt(*body.Disabled), u.ID)
	}
	if body.Password != nil {
		if err := s.setPassword(u.ID, *body.Password); err != nil {
			s.internalError(w, r, err)
			return
		}
	}
	if body.SignOut && !self {
		s.db.Exec(`UPDATE users SET session_version = session_version + 1 WHERE id = ?`, u.ID)
	}
	s.log.Info("admin updated user", "admin", me.ID, "user", u.ID)
	u, _ = s.userByID(u.ID)
	writeJSON(w, http.StatusOK, s.adminUserInfo(u, s.hub.online()))
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

func (s *Server) handleAdminDeleteUser(w http.ResponseWriter, r *http.Request) {
	me := userOf(r)
	u := s.targetUser(w, r)
	if u == nil {
		return
	}
	if u.ID == me.ID {
		httpError(w, http.StatusBadRequest, "Không tự xoá tài khoản của chính mình")
		return
	}
	if u.Role == "admin" && s.adminCount() <= 1 {
		httpError(w, http.StatusBadRequest, "Phải còn ít nhất một admin")
		return
	}
	if rows, err := s.db.Query(`SELECT id FROM download_jobs WHERE user_id = ? AND status IN ('queued','downloading','processing')`, u.ID); err == nil {
		ids, _ := scanStrings(rows)
		for _, id := range ids {
			s.dl.cancel(id)
		}
	}
	rows, err := s.db.Query(`SELECT track_id FROM user_tracks WHERE user_id = ?`, u.ID)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	trackIDs, _ := scanStrings(rows)
	if _, err := s.db.Exec(`DELETE FROM users WHERE id = ?`, u.ID); err != nil { // cascades to everything personal
		s.internalError(w, r, err)
		return
	}
	freed := 0
	for _, id := range trackIDs {
		if s.gcTrack(id) {
			freed++
		}
	}
	s.log.Warn("admin deleted user", "admin", me.ID, "user", u.ID, "email", u.Email, "files_freed", freed)
	writeJSON(w, http.StatusOK, map[string]int{"filesFreed": freed})
}

func (s *Server) handleAdminUserStats(w http.ResponseWriter, r *http.Request) {
	u := s.targetUser(w, r)
	if u == nil {
		return
	}
	days, _ := strconv.Atoi(r.URL.Query().Get("days"))
	tz, _ := strconv.Atoi(r.URL.Query().Get("tz"))
	st, err := s.statsFor(u.ID, days, tz)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	st["user"] = s.adminUserInfo(u, s.hub.online())
	writeJSON(w, http.StatusOK, st)
}

func (s *Server) handleAdminUserHistory(w http.ResponseWriter, r *http.Request) {
	u := s.targetUser(w, r)
	if u == nil {
		return
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	h, err := s.historyFor(u.ID, limit)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, h)
}

func (s *Server) handleAdminUserTracks(w http.ResponseWriter, r *http.Request) {
	u := s.targetUser(w, r)
	if u == nil {
		return
	}
	ts, err := s.libTracks(u.ID, `ORDER BY ut.added_at DESC`)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, ts)
}

func (s *Server) handleAdminRemoveUserTrack(w http.ResponseWriter, r *http.Request) {
	u := s.targetUser(w, r)
	if u == nil {
		return
	}
	tid := r.PathValue("trackId")
	if _, err := s.getTrack(u.ID, tid); err != nil {
		httpError(w, http.StatusNotFound, "Người này không có bài đó")
		return
	}
	if err := s.removeFromLibrary(u.ID, tid); err != nil {
		s.internalError(w, r, err)
		return
	}
	s.log.Info("admin removed track from user", "admin", userOf(r).ID, "user", u.ID, "track", tid)
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleAdminResetUser(w http.ResponseWriter, r *http.Request) {
	u := s.targetUser(w, r)
	if u == nil {
		return
	}
	var body struct {
		Scope string `json:"scope"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	if body.Scope != "history" && body.Scope != "all" {
		httpError(w, http.StatusBadRequest, "Phạm vi không hợp lệ")
		return
	}
	if err := s.resetUser(u.ID, body.Scope); err != nil {
		s.internalError(w, r, err)
		return
	}
	s.log.Warn("admin reset user data", "admin", userOf(r).ID, "user", u.ID, "scope", body.Scope)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// ── system ──────────────────────────────────────────────────────────────

func dirUsage(dir string) (bytes int64, files int) {
	filepath.WalkDir(dir, func(_ string, d fs.DirEntry, err error) error {
		if err == nil && d.Type().IsRegular() {
			if info, err := d.Info(); err == nil {
				bytes += info.Size()
				files++
			}
		}
		return nil
	})
	return
}

func fileSize(p string) int64 {
	if st, err := os.Stat(p); err == nil {
		return st.Size()
	}
	return 0
}

func (s *Server) handleAdminSystem(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	ready, yerr := s.yt.Status()
	bin, managed, js := s.yt.Info()
	ytErr := ""
	if yerr != nil {
		ytErr = yerr.Error()
	}
	ytVersion := ""
	if ready {
		ytVersion = s.yt.Version(ctx)
	}
	musicBytes, musicFiles := dirUsage(s.cfg.MusicDir())
	coverBytes, _ := dirUsage(s.cfg.CoverDir())
	var dbBytes int64
	s.db.QueryRow(`SELECT pg_database_size(current_database())`).Scan(&dbBytes)

	var tracks, orphans, loudPending, users, admins int
	var storeBytes int64
	s.db.QueryRow(`SELECT COUNT(*), COALESCE(SUM(size_bytes), 0) FROM tracks`).Scan(&tracks, &storeBytes)
	s.db.QueryRow(`SELECT COUNT(*) FROM tracks t WHERE NOT EXISTS (SELECT 1 FROM user_tracks ut WHERE ut.track_id = t.id)`).Scan(&orphans)
	s.db.QueryRow(`SELECT COUNT(*) FROM tracks WHERE loudness_done = 0`).Scan(&loudPending)
	s.db.QueryRow(`SELECT COUNT(*), COUNT(*) FILTER (WHERE role = 'admin') FROM users`).Scan(&users, &admins)
	jobs := map[string]int{}
	if rows, err := s.db.Query(`SELECT status, COUNT(*) FROM download_jobs GROUP BY status`); err == nil {
		for rows.Next() {
			var st string
			var n int
			if rows.Scan(&st, &n) == nil {
				jobs[st] = n
			}
		}
		rows.Close()
	}
	f := s.loadFeatures()
	s.autodl.mu.Lock()
	nextAuto := s.autodl.nextRun
	s.autodl.mu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{
		"ytdlp":  map[string]any{"ready": ready, "error": ytErr, "version": ytVersion, "bin": bin, "managed": managed, "jsRuntime": js},
		"ffmpeg": s.cfg.FFmpeg,
		"storage": map[string]any{
			"musicBytes": musicBytes, "musicFiles": musicFiles, "coverBytes": coverBytes,
			"dbBytes": dbBytes, "tracks": tracks, "trackBytes": storeBytes, "orphanTracks": orphans,
		},
		"analysis":  map[string]any{"loudnessPending": loudPending, "featuresPending": f.pending, "featuresReady": len(f.ids)},
		"jobs":      jobs,
		"users":     map[string]int{"total": users, "admins": admins, "online": len(s.hub.online())},
		"mail":      map[string]any{"configured": s.cfg.MailConfigured(), "host": s.cfg.SMTPHost, "from": s.cfg.SMTPFrom},
		"recs":      map[string]any{"provider": s.ext.provider()},
		"autoNext":  nextAuto,
		"publicUrl": s.cfg.PublicURL,
		"go":        runtime.Version(),
		"dataDir":   s.cfg.DataDir,
	})
}

func (s *Server) handleAdminUpdateYtdlp(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Minute)
	defer cancel()
	if err := s.yt.Update(ctx); err != nil {
		httpError(w, http.StatusBadGateway, "Cập nhật yt-dlp lỗi: "+err.Error())
		return
	}
	s.log.Info("admin updated yt-dlp", "admin", userOf(r).ID)
	writeJSON(w, http.StatusOK, map[string]string{"version": s.yt.Version(ctx)})
}

// handleAdminCleanup: delete songs nobody has, stray files, old finished jobs
// and expired codes.
func (s *Server) handleAdminCleanup(w http.ResponseWriter, r *http.Request) {
	rows, err := s.db.Query(`SELECT id FROM tracks t WHERE NOT EXISTS (SELECT 1 FROM user_tracks ut WHERE ut.track_id = t.id)`)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	orphans, _ := scanStrings(rows)
	removed := 0
	for _, id := range orphans {
		if s.gcTrack(id) {
			removed++
		}
	}
	// Files on disk the database doesn't know (e.g. left by a crash).
	known := map[string]bool{}
	if rows, err := s.db.Query(`SELECT id, file_path FROM tracks`); err == nil {
		for rows.Next() {
			var id, fp string
			if rows.Scan(&id, &fp) == nil {
				known[filepath.Clean(filepath.Join(s.cfg.DataDir, filepath.FromSlash(fp)))] = true
				known[filepath.Clean(filepath.Join(s.cfg.CoverDir(), id+".jpg"))] = true
			}
		}
		rows.Close()
	}
	stray := 0
	var strayBytes int64
	for _, dir := range []string{s.cfg.MusicDir(), s.cfg.CoverDir()} {
		entries, _ := os.ReadDir(dir)
		for _, e := range entries {
			p := filepath.Clean(filepath.Join(dir, e.Name()))
			if !e.Type().IsRegular() || known[p] {
				continue
			}
			if info, err := e.Info(); err == nil && time.Since(info.ModTime()) < time.Hour {
				continue // may belong to a download finishing right now
			}
			strayBytes += fileSize(p)
			if os.Remove(p) == nil {
				stray++
			}
		}
	}
	res, _ := s.db.Exec(`DELETE FROM download_jobs WHERE status IN ('done','skipped') AND updated_at < ?`, time.Now().Add(-30*24*time.Hour).UnixMilli())
	oldJobs, _ := res.RowsAffected()
	s.db.Exec(`DELETE FROM otp_codes WHERE expires_at < ?`, nowMs())
	s.log.Info("admin cleanup", "admin", userOf(r).ID, "orphans", removed, "stray_files", stray)
	writeJSON(w, http.StatusOK, map[string]any{"orphanTracks": removed, "strayFiles": stray, "strayBytes": strayBytes, "oldJobs": oldJobs})
}

func (s *Server) handleAdminClearCache(w http.ResponseWriter, r *http.Request) {
	res, err := s.db.Exec(`DELETE FROM ext_cache`)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	n, _ := res.RowsAffected()
	writeJSON(w, http.StatusOK, map[string]int64{"removed": n})
}

func (s *Server) handleAdminTestMail(w http.ResponseWriter, r *http.Request) {
	me := userOf(r)
	if !s.cfg.MailConfigured() {
		httpError(w, http.StatusBadRequest, "Chưa cấu hình SMTP trong .env")
		return
	}
	err := s.sendMail(me.Email, "Thử gửi email từ RiiMusic", "Email thử từ máy chủ RiiMusic. Nếu bạn đọc được dòng này, cấu hình SMTP đã đúng.\n")
	if err != nil {
		httpError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"to": me.Email})
}

// handleAdminJobs: everyone's running and failed downloads.
func (s *Server) handleAdminJobs(w http.ResponseWriter, r *http.Request) {
	js, err := s.queryJobs(`WHERE status IN ('queued','downloading','processing','error') ORDER BY created_at DESC LIMIT 300`)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	emails := map[string]string{}
	if us, err := s.listUsers(); err == nil {
		for _, u := range us {
			emails[u.ID] = u.Email
		}
	}
	type row struct {
		Job
		Email string `json:"email"`
	}
	out := make([]row, 0, len(js))
	for _, j := range js {
		out = append(out, row{j, emails[j.UserID]})
	}
	writeJSON(w, http.StatusOK, map[string]any{"jobs": out})
}
