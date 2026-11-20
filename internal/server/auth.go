package server

import (
	"context"
	"crypto/hmac"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/mail"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	sessionCookie = "vang_session"
	sessionTTL    = 30 * 24 * time.Hour
	csrfHeader    = "X-Vang"

	otpTTL      = 10 * time.Minute
	otpCooldown = 60 * time.Second
	otpMaxTries = 5

	pbkdf2Iter = 600_000 // OWASP 2023 for PBKDF2-HMAC-SHA256
	minPassLen = 8
)

// ── users ───────────────────────────────────────────────────────────────

type User struct {
	ID             string `json:"id"`
	Email          string `json:"email"`
	Name           string `json:"name"`
	Role           string `json:"role"` // admin | listener (admin can do everything a listener can)
	StorageLimitMB int    `json:"storageLimitMb"`
	Disabled       bool   `json:"disabled"`
	HasPassword    bool   `json:"hasPassword"`
	CreatedAt      int64  `json:"createdAt"`
	LastLoginAt    int64  `json:"lastLoginAt"`
	sessionVersion int64
}

func (u *User) IsAdmin() bool { return u.Role == "admin" }

const userCols = `id, email, name, role, storage_limit_mb, disabled, pass_hash != '', created_at, COALESCE(last_login_at, 0), session_version`

func scanUser(sc interface{ Scan(...any) error }) (*User, error) {
	var u User
	err := sc.Scan(&u.ID, &u.Email, &u.Name, &u.Role, &u.StorageLimitMB, &u.Disabled, &u.HasPassword, &u.CreatedAt, &u.LastLoginAt, &u.sessionVersion)
	if err != nil {
		return nil, err
	}
	return &u, nil
}

func (s *Server) userByID(id string) (*User, error) {
	u, err := scanUser(s.db.QueryRow(`SELECT `+userCols+` FROM users WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, errNotFound
	}
	return u, err
}

func (s *Server) userByEmail(email string) (*User, error) {
	u, err := scanUser(s.db.QueryRow(`SELECT `+userCols+` FROM users WHERE email = ?`, email))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, errNotFound
	}
	return u, err
}

func normEmail(e string) (string, bool) {
	e = strings.ToLower(strings.TrimSpace(e))
	a, err := mail.ParseAddress(e)
	if err != nil || a.Address != e || len(e) > 254 {
		return "", false
	}
	return e, true
}

type ctxKey struct{}

// userOf returns the signed-in user (set by requireAuth).
func userOf(r *http.Request) *User { return r.Context().Value(ctxKey{}).(*User) }

// ── passwords ───────────────────────────────────────────────────────────

func hashPassword(pw string) (string, error) {
	salt := make([]byte, 16)
	rand.Read(salt)
	key, err := pbkdf2.Key(sha256.New, pw, salt, pbkdf2Iter, 32)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("pbkdf2-sha256$%d$%s$%s", pbkdf2Iter, base64.RawStdEncoding.EncodeToString(salt), base64.RawStdEncoding.EncodeToString(key)), nil
}

func checkPassword(stored, pw string) bool {
	parts := strings.Split(stored, "$")
	if len(parts) != 4 || parts[0] != "pbkdf2-sha256" {
		return false
	}
	iter, err := strconv.Atoi(parts[1])
	if err != nil || iter < 1 {
		return false
	}
	salt, err1 := base64.RawStdEncoding.DecodeString(parts[2])
	want, err2 := base64.RawStdEncoding.DecodeString(parts[3])
	if err1 != nil || err2 != nil {
		return false
	}
	got, err := pbkdf2.Key(sha256.New, pw, salt, iter, len(want))
	return err == nil && subtle.ConstantTimeCompare(got, want) == 1
}

// dummyHash keeps "no such user" as slow as "wrong password".
var dummyHash, _ = hashPassword("vang-dummy-password")

func validPassword(pw string) error {
	if len([]rune(pw)) < minPassLen {
		return fmt.Errorf("Mật khẩu cần ít nhất %d ký tự", minPassLen)
	}
	if len(pw) > 200 {
		return errors.New("Mật khẩu quá dài")
	}
	return nil
}

// ── sessions ────────────────────────────────────────────────────────────

// Auth signs session cookies and OTP hashes with a key persisted in DATA_DIR.
type Auth struct {
	key      []byte
	trustXFF bool
}

func NewAuth(cfg Config) (*Auth, error) {
	secretPath := filepath.Join(cfg.DataDir, "secret.key")
	secret, err := os.ReadFile(secretPath)
	if err != nil || len(secret) < 32 {
		secret = make([]byte, 32)
		if _, err := rand.Read(secret); err != nil {
			return nil, err
		}
		if err := os.WriteFile(secretPath, secret, 0o600); err != nil {
			return nil, fmt.Errorf("write session secret: %w", err)
		}
	}
	return &Auth{key: secret, trustXFF: cfg.TrustProxy}, nil
}

func (a *Auth) mac(parts ...string) string {
	m := hmac.New(sha256.New, a.key)
	for _, p := range parts {
		m.Write([]byte(p))
		m.Write([]byte{0})
	}
	return hex.EncodeToString(m.Sum(nil))
}

// session token: userID.version.expiry.signature
func (a *Auth) sign(uid string, ver int64, exp int64) string {
	v, e := strconv.FormatInt(ver, 10), strconv.FormatInt(exp, 10)
	return uid + "." + v + "." + e + "." + a.mac("session", uid, v, e)
}

func (a *Auth) parse(tok string) (uid string, ver int64, ok bool) {
	p := strings.Split(tok, ".")
	if len(p) != 4 {
		return "", 0, false
	}
	exp, err := strconv.ParseInt(p[2], 10, 64)
	if err != nil || time.Now().Unix() > exp {
		return "", 0, false
	}
	if !hmac.Equal([]byte(a.mac("session", p[0], p[1], p[2])), []byte(p[3])) {
		return "", 0, false
	}
	ver, err = strconv.ParseInt(p[1], 10, 64)
	return p[0], ver, err == nil
}

func (s *Server) setSession(w http.ResponseWriter, r *http.Request, u *User) {
	exp := time.Now().Add(sessionTTL)
	http.SetCookie(w, &http.Cookie{
		Name: sessionCookie, Value: s.auth.sign(u.ID, u.sessionVersion, exp.Unix()), Path: "/",
		Expires: exp, HttpOnly: true, Secure: isHTTPS(r), SameSite: http.SameSiteLaxMode,
	})
	s.db.Exec(`UPDATE users SET last_login_at = ? WHERE id = ?`, nowMs(), u.ID)
}

func (s *Server) clientIP(r *http.Request) string {
	if s.auth.trustXFF {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			ip, _, _ := strings.Cut(xff, ",")
			return strings.TrimSpace(ip)
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func isHTTPS(r *http.Request) bool {
	return r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https")
}

// sessionUser returns the user behind the session cookie, if it is valid.
func (s *Server) sessionUser(r *http.Request) *User {
	c, err := r.Cookie(sessionCookie)
	if err != nil {
		return nil
	}
	uid, ver, ok := s.auth.parse(c.Value)
	if !ok {
		return nil
	}
	u, err := s.userByID(uid)
	if err != nil || u.Disabled || u.sessionVersion != ver {
		return nil
	}
	return u
}

// requireAuth rejects requests without a valid session. State-changing requests
// must also carry the X-Vang header, which a cross-site form cannot set.
func (s *Server) requireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// A personal API token (scripts) needs no CSRF header: browsers never
		// send it on their own.
		if u := s.tokenUser(r, "api"); u != nil {
			next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), ctxKey{}, u)))
			return
		}
		u := s.sessionUser(r)
		if u == nil {
			httpError(w, http.StatusUnauthorized, "Cần đăng nhập")
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead && r.Header.Get(csrfHeader) == "" {
			httpError(w, http.StatusForbidden, "Thiếu header X-Vang")
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), ctxKey{}, u)))
	})
}

func (s *Server) requireAdmin(next http.Handler) http.Handler {
	return s.requireAuth(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !userOf(r).IsAdmin() {
			httpError(w, http.StatusForbidden, "Chỉ admin mới làm được việc này")
			return
		}
		next.ServeHTTP(w, r)
	}))
}

// publicPost guards the unauthenticated auth endpoints: CSRF header + rate limit.
func (s *Server) publicPost(w http.ResponseWriter, r *http.Request, rl *RateLimiter) bool {
	if r.Header.Get(csrfHeader) == "" {
		httpError(w, http.StatusForbidden, "Thiếu header X-Vang")
		return false
	}
	if !rl.Allow(s.clientIP(r)) {
		httpError(w, http.StatusTooManyRequests, "Thử quá nhiều lần, đợi một lát rồi thử lại")
		return false
	}
	return true
}

// ── login with password ────────────────────────────────────────────────

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	if !s.publicPost(w, r, s.login) {
		return
	}
	var body struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	email, _ := normEmail(body.Email)
	u, err := s.userByEmail(email)
	var stored string
	if err == nil {
		s.db.QueryRow(`SELECT pass_hash FROM users WHERE id = ?`, u.ID).Scan(&stored)
	}
	if err != nil || stored == "" {
		checkPassword(dummyHash, body.Password) // same timing as a real check
		s.log.Warn("login failed", "ip", s.clientIP(r))
		httpError(w, http.StatusUnauthorized, "Email hoặc mật khẩu không đúng")
		return
	}
	if !checkPassword(stored, body.Password) {
		s.log.Warn("login failed", "ip", s.clientIP(r), "user", u.ID)
		httpError(w, http.StatusUnauthorized, "Email hoặc mật khẩu không đúng")
		return
	}
	if u.Disabled {
		httpError(w, http.StatusForbidden, "Tài khoản đã bị khoá. Liên hệ admin.")
		return
	}
	s.setSession(w, r, u)
	s.writeMe(w, u)
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{
		Name: sessionCookie, Value: "", Path: "/", MaxAge: -1,
		HttpOnly: true, Secure: isHTTPS(r), SameSite: http.SameSiteLaxMode,
	})
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// ── one-time codes ─────────────────────────────────────────────────────

func otpCode() string {
	var b [4]byte
	rand.Read(b[:])
	return fmt.Sprintf("%06d", binary.BigEndian.Uint32(b[:])%1_000_000)
}

// handleRequestOTP emails a code for login or password reset. The answer is
// the same whether or not the email has an account.
func (s *Server) handleRequestOTP(w http.ResponseWriter, r *http.Request) {
	if !s.publicPost(w, r, s.otpRL) {
		return
	}
	var body struct {
		Email   string `json:"email"`
		Purpose string `json:"purpose"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	email, ok := normEmail(body.Email)
	if !ok {
		httpError(w, http.StatusBadRequest, "Email không hợp lệ")
		return
	}
	if body.Purpose != "login" && body.Purpose != "reset" {
		httpError(w, http.StatusBadRequest, "Mục đích không hợp lệ")
		return
	}
	if !s.cfg.MailConfigured() {
		httpError(w, http.StatusServiceUnavailable, "Máy chủ chưa cấu hình gửi email (SMTP). Đăng nhập bằng mật khẩu hoặc nhờ admin.")
		return
	}
	var sentAt int64
	if s.db.QueryRow(`SELECT sent_at FROM otp_codes WHERE email = ? AND purpose = ?`, email, body.Purpose).Scan(&sentAt) == nil {
		if wait := otpCooldown - time.Since(time.UnixMilli(sentAt)); wait > 0 {
			httpError(w, http.StatusTooManyRequests, fmt.Sprintf("Đợi %d giây rồi gửi lại mã", int(wait.Seconds())+1))
			return
		}
	}
	ok200 := map[string]any{"ok": true, "ttlSec": int(otpTTL.Seconds())}
	u, err := s.userByEmail(email)
	if err != nil || u.Disabled {
		writeJSON(w, http.StatusOK, ok200) // don't reveal which emails have accounts
		return
	}
	code := otpCode()
	now := time.Now()
	s.db.Exec(`INSERT INTO otp_codes(email, purpose, code_hash, expires_at, attempts, sent_at) VALUES (?,?,?,?,0,?)
		ON CONFLICT(email, purpose) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0, sent_at = excluded.sent_at`,
		email, body.Purpose, s.auth.mac("otp", email, body.Purpose, code), now.Add(otpTTL).UnixMilli(), now.UnixMilli())
	subject, what := "Mã đăng nhập Vang", "đăng nhập"
	if body.Purpose == "reset" {
		subject, what = "Mã đặt lại mật khẩu Vang", "đặt lại mật khẩu"
	}
	if err := s.sendMail(email, subject, otpEmail(code, what, s.cfg.PublicURL)); err != nil {
		s.log.Error("send otp email", "err", err)
		s.db.Exec(`DELETE FROM otp_codes WHERE email = ? AND purpose = ?`, email, body.Purpose)
		httpError(w, http.StatusBadGateway, "Không gửi được email, thử lại sau")
		return
	}
	writeJSON(w, http.StatusOK, ok200)
}

// consumeOTP checks a code; a code works once and allows 5 tries.
func (s *Server) consumeOTP(email, purpose, code string) error {
	var hash string
	var exp int64
	var tries int
	err := s.db.QueryRow(`SELECT code_hash, expires_at, attempts FROM otp_codes WHERE email = ? AND purpose = ?`, email, purpose).Scan(&hash, &exp, &tries)
	if err != nil {
		return errors.New("Mã không đúng hoặc đã hết hạn")
	}
	if time.Now().UnixMilli() > exp || tries >= otpMaxTries {
		s.db.Exec(`DELETE FROM otp_codes WHERE email = ? AND purpose = ?`, email, purpose)
		return errors.New("Mã đã hết hạn, hãy gửi mã mới")
	}
	code = strings.TrimSpace(code)
	if !hmac.Equal([]byte(s.auth.mac("otp", email, purpose, code)), []byte(hash)) {
		s.db.Exec(`UPDATE otp_codes SET attempts = attempts + 1 WHERE email = ? AND purpose = ?`, email, purpose)
		left := otpMaxTries - tries - 1
		if left <= 0 {
			return errors.New("Sai quá nhiều lần, hãy gửi mã mới")
		}
		return fmt.Errorf("Mã không đúng (còn %d lần thử)", left)
	}
	s.db.Exec(`DELETE FROM otp_codes WHERE email = ? AND purpose = ?`, email, purpose)
	return nil
}

func (s *Server) handleVerifyOTP(w http.ResponseWriter, r *http.Request) {
	if !s.publicPost(w, r, s.login) {
		return
	}
	var body struct {
		Email string `json:"email"`
		Code  string `json:"code"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	email, _ := normEmail(body.Email)
	if err := s.consumeOTP(email, "login", body.Code); err != nil {
		httpError(w, http.StatusUnauthorized, err.Error())
		return
	}
	u, err := s.userByEmail(email)
	if err != nil || u.Disabled {
		httpError(w, http.StatusUnauthorized, "Mã không đúng hoặc đã hết hạn")
		return
	}
	s.setSession(w, r, u)
	s.writeMe(w, u)
}

// handleResetPassword: forgot password → code by email → code + new password.
func (s *Server) handleResetPassword(w http.ResponseWriter, r *http.Request) {
	if !s.publicPost(w, r, s.login) {
		return
	}
	var body struct {
		Email    string `json:"email"`
		Code     string `json:"code"`
		Password string `json:"password"`
		Confirm  string `json:"confirm"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	if body.Password != body.Confirm {
		httpError(w, http.StatusBadRequest, "Hai lần nhập mật khẩu mới không khớp")
		return
	}
	if err := validPassword(body.Password); err != nil {
		httpError(w, http.StatusBadRequest, err.Error())
		return
	}
	email, _ := normEmail(body.Email)
	if err := s.consumeOTP(email, "reset", body.Code); err != nil {
		httpError(w, http.StatusUnauthorized, err.Error())
		return
	}
	u, err := s.userByEmail(email)
	if err != nil || u.Disabled {
		httpError(w, http.StatusUnauthorized, "Mã không đúng hoặc đã hết hạn")
		return
	}
	if err := s.setPassword(u.ID, body.Password); err != nil {
		s.internalError(w, r, err)
		return
	}
	u, _ = s.userByID(u.ID)
	s.setSession(w, r, u)
	s.writeMe(w, u)
}

// setPassword stores a new password and signs out every existing session.
func (s *Server) setPassword(uid, pw string) error {
	h, err := hashPassword(pw)
	if err != nil {
		return err
	}
	_, err = s.db.Exec(`UPDATE users SET pass_hash = ?, session_version = session_version + 1 WHERE id = ?`, h, uid)
	return err
}

// ── me ──────────────────────────────────────────────────────────────────

func (s *Server) userUsage(uid string) (bytes int64, tracks int) {
	s.db.QueryRow(`SELECT COALESCE(SUM(t.size_bytes), 0), COUNT(*) FROM user_tracks ut JOIN tracks t ON t.id = ut.track_id WHERE ut.user_id = ?`, uid).Scan(&bytes, &tracks)
	return
}

func (s *Server) writeMe(w http.ResponseWriter, u *User) {
	used, n := s.userUsage(u.ID)
	writeJSON(w, http.StatusOK, map[string]any{
		"user": u, "usedBytes": used, "tracks": n, "limitBytes": int64(u.StorageLimitMB) << 20,
		"mailConfigured": s.cfg.MailConfigured(),
	})
}

func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) { s.writeMe(w, userOf(r)) }

func (s *Server) handlePatchMe(w http.ResponseWriter, r *http.Request) {
	u := userOf(r)
	var body struct {
		Name string `json:"name"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	name := strings.TrimSpace(body.Name)
	if len([]rune(name)) > 80 {
		httpError(w, http.StatusBadRequest, "Tên tối đa 80 ký tự")
		return
	}
	s.db.Exec(`UPDATE users SET name = ? WHERE id = ?`, name, u.ID)
	u.Name = name
	s.writeMe(w, u)
}

// handleChangePassword: current password + new password twice. Accounts that
// only used OTP so far set their first password without a current one.
func (s *Server) handleChangePassword(w http.ResponseWriter, r *http.Request) {
	u := userOf(r)
	var body struct {
		Current  string `json:"current"`
		Password string `json:"password"`
		Confirm  string `json:"confirm"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	if !s.login.Allow("pw:" + u.ID) {
		httpError(w, http.StatusTooManyRequests, "Thử quá nhiều lần, đợi một lát")
		return
	}
	var stored string
	s.db.QueryRow(`SELECT pass_hash FROM users WHERE id = ?`, u.ID).Scan(&stored)
	if stored != "" && !checkPassword(stored, body.Current) {
		httpError(w, http.StatusBadRequest, "Mật khẩu hiện tại không đúng")
		return
	}
	if body.Password != body.Confirm {
		httpError(w, http.StatusBadRequest, "Hai lần nhập mật khẩu mới không khớp")
		return
	}
	if err := validPassword(body.Password); err != nil {
		httpError(w, http.StatusBadRequest, err.Error())
		return
	}
	if stored != "" && body.Current == body.Password {
		httpError(w, http.StatusBadRequest, "Mật khẩu mới phải khác mật khẩu cũ")
		return
	}
	if err := s.setPassword(u.ID, body.Password); err != nil {
		s.internalError(w, r, err)
		return
	}
	u, _ = s.userByID(u.ID)
	s.setSession(w, r, u) // keep this device signed in; others are signed out
	s.writeMe(w, u)
}

// ── bootstrap ───────────────────────────────────────────────────────────

// EnsureAdmin creates the first admin from ADMIN_EMAIL / ADMIN_PASSWORD when
// there are no users yet.
func (s *Server) EnsureAdmin() error {
	var n int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&n); err != nil {
		return err
	}
	if n > 0 {
		return nil
	}
	email, ok := normEmail(s.cfg.AdminEmail)
	if !ok {
		email = "admin@vang.local"
		slog.Warn("ADMIN_EMAIL chưa đặt hoặc không hợp lệ, dùng email mặc định", "email", email)
	}
	pw := s.cfg.AdminPassword
	if validPassword(pw) != nil {
		b := make([]byte, 9)
		rand.Read(b)
		pw = hex.EncodeToString(b)
		// Straight to the console, once: not into the admin page's log buffer.
		fmt.Fprintf(os.Stderr, "\n  ADMIN_PASSWORD chưa đặt hoặc ngắn hơn 8 ký tự.\n  Tài khoản admin: %s\n  Mật khẩu tạm:   %s\n  Đổi ngay sau khi đăng nhập.\n\n", email, pw)
	}
	h, err := hashPassword(pw)
	if err != nil {
		return err
	}
	_, err = s.db.Exec(`INSERT INTO users(id, email, name, pass_hash, role, storage_limit_mb, created_at) VALUES (?,?,?,?,?,?,?)`,
		newID(), email, "Admin", h, "admin", s.cfg.DefaultStorageMB*4, nowMs())
	if err == nil {
		slog.Info("đã tạo tài khoản admin đầu tiên", "email", email)
	}
	return err
}

// ── rate limiting ──────────────────────────────────────────────────────

// RateLimiter is a fixed-window counter per key.
type RateLimiter struct {
	mu     sync.Mutex
	limit  int
	window time.Duration
	hits   map[string]*window
}

type window struct {
	start time.Time
	n     int
}

func NewRateLimiter(limit int, per time.Duration) *RateLimiter {
	return &RateLimiter{limit: limit, window: per, hits: map[string]*window{}}
}

func (l *RateLimiter) Allow(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	if len(l.hits) > 10000 {
		l.hits = map[string]*window{}
	}
	w := l.hits[key]
	if w == nil || now.Sub(w.start) > l.window {
		l.hits[key] = &window{start: now, n: 1}
		return true
	}
	if w.n >= l.limit {
		return false
	}
	w.n++
	return true
}
