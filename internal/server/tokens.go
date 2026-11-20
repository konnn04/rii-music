package server

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Personal tokens. "api" tokens let a user's own scripts call the API
// (Authorization: Bearer vang_…), "agent" tokens only let the Discord agent
// read what they are playing. Tokens are shown once; only a hash is stored.

type APIToken struct {
	ID         string `json:"id"`
	Kind       string `json:"kind"`
	Name       string `json:"name"`
	Prefix     string `json:"prefix"` // first characters, to recognise it
	CreatedAt  int64  `json:"createdAt"`
	LastUsedAt int64  `json:"lastUsedAt"`
}

func hashToken(tok string) string {
	h := sha256.Sum256([]byte(tok))
	return hex.EncodeToString(h[:])
}

// tokenUser resolves "Authorization: Bearer <token>" of the given kind.
func (s *Server) tokenUser(r *http.Request, kind string) *User {
	h := r.Header.Get("Authorization")
	if !strings.HasPrefix(h, "Bearer ") {
		return nil
	}
	tok := strings.TrimSpace(strings.TrimPrefix(h, "Bearer "))
	if !strings.HasPrefix(tok, "vang_") || len(tok) > 100 {
		return nil
	}
	var id, uid string
	if s.db.QueryRow(`SELECT id, user_id FROM api_tokens WHERE token_hash = ? AND kind = ?`, hashToken(tok), kind).Scan(&id, &uid) != nil {
		return nil
	}
	u, err := s.userByID(uid)
	if err != nil || u.Disabled {
		return nil
	}
	tokenSeen(s, id)
	return u
}

// tokenSeen records last use at most once a minute per token.
var tokenSeenAt sync.Map

func tokenSeen(s *Server, id string) {
	now := time.Now()
	if v, ok := tokenSeenAt.Load(id); ok && now.Sub(v.(time.Time)) < time.Minute {
		return
	}
	tokenSeenAt.Store(id, now)
	s.db.Exec(`UPDATE api_tokens SET last_used_at = ? WHERE id = ?`, now.UnixMilli(), id)
}

func (s *Server) handleListTokens(w http.ResponseWriter, r *http.Request) {
	rows, err := s.db.Query(`SELECT id, kind, name, prefix, created_at, COALESCE(last_used_at, 0) FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC`, userOf(r).ID)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	defer rows.Close()
	out := []APIToken{}
	for rows.Next() {
		var t APIToken
		if rows.Scan(&t.ID, &t.Kind, &t.Name, &t.Prefix, &t.CreatedAt, &t.LastUsedAt) == nil {
			out = append(out, t)
		}
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleCreateToken(w http.ResponseWriter, r *http.Request) {
	uid := userOf(r).ID
	var body struct {
		Kind string `json:"kind"`
		Name string `json:"name"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	if body.Kind != "api" && body.Kind != "agent" {
		httpError(w, http.StatusBadRequest, "Loại token không hợp lệ")
		return
	}
	name := strings.TrimSpace(body.Name)
	if len([]rune(name)) > 60 {
		httpError(w, http.StatusBadRequest, "Tên tối đa 60 ký tự")
		return
	}
	var n int
	s.db.QueryRow(`SELECT COUNT(*) FROM api_tokens WHERE user_id = ?`, uid).Scan(&n)
	if n >= 20 {
		httpError(w, http.StatusBadRequest, "Tối đa 20 token, xoá bớt token cũ")
		return
	}
	if body.Kind == "agent" {
		// one agent token per user: a new one replaces the old
		s.db.Exec(`DELETE FROM api_tokens WHERE user_id = ? AND kind = 'agent'`, uid)
		if name == "" {
			name = "Discord agent"
		}
	}
	b := make([]byte, 24)
	rand.Read(b)
	tok := "vang_" + hex.EncodeToString(b)
	t := APIToken{ID: newID(), Kind: body.Kind, Name: name, Prefix: tok[:12], CreatedAt: nowMs()}
	if _, err := s.db.Exec(`INSERT INTO api_tokens(id, user_id, kind, name, token_hash, prefix, created_at) VALUES (?,?,?,?,?,?,?)`,
		t.ID, uid, t.Kind, t.Name, hashToken(tok), t.Prefix, t.CreatedAt); err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"token": tok, "info": t})
}

func (s *Server) handleDeleteToken(w http.ResponseWriter, r *http.Request) {
	if _, err := s.db.Exec(`DELETE FROM api_tokens WHERE id = ? AND user_id = ?`, r.PathValue("id"), userOf(r).ID); err != nil {
		s.internalError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
