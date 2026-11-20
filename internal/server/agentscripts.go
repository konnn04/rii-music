package server

import (
	_ "embed"
	"net/http"
	"regexp"
	"strings"
)

// Discord agent as a script served by this server, so users don't download
// an executable: PowerShell on Windows, sh + python3 on macOS / Linux.
// The server's address is filled in; the token is asked for on first run
// (never part of the URL, so it stays out of logs and shell history).

//go:embed agent/agent.ps1
var agentPS1 string

//go:embed agent/agent.sh
var agentSH string

// safeBase: the address goes inside a quoted string of the script, so only
// plain URL characters are allowed (no quotes, spaces, $ or backticks).
var safeBase = regexp.MustCompile(`^https?://[A-Za-z0-9.\-:\[\]]+(/[A-Za-z0-9._~\-/]*)?$`)

func (s *Server) serveAgentScript(body string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		base := strings.TrimRight(s.baseURL(r), "/")
		if !safeBase.MatchString(base) {
			httpError(w, http.StatusBadRequest, "Địa chỉ máy chủ không hợp lệ")
			return
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Write([]byte(strings.ReplaceAll(body, "__SERVER__", base)))
	}
}
