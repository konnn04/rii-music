package server

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// Settings are one user's preferences.
type Settings struct {
	// Limits set by the admin, filled in on read (never stored here).
	Limits       *PlayLimits `json:"limits,omitempty"`
	CrossfadeSec float64     `json:"crossfadeSec"` // 0–12
	GaplessAlbum bool        `json:"gaplessAlbum"` // no crossfade between consecutive tracks of one album
	Normalize    bool        `json:"normalize"`    // apply per-track gain
	Theme        string      `json:"theme"`        // dark | light | system
	// Accent colour: one of 12 hues (accentNames) or "song" (taken from the cover).
	Accent string `json:"accent"`
	// Music effect: Now Playing / lyrics background pulses with the bass.
	Visualizer bool `json:"visualizer"`
	// Tự động tải nhạc: pre-download songs that fit the listening habits within
	// the storage limit the admin set, removing the least likely to be played.
	AutoDownload bool `json:"autoDownload"`
	// Tự động gợi ý phát: off | lib (library only) | free (also new songs)
	AutoplayMode string `json:"autoplayMode"`
	// Onboarding answers: a starting point before there is listening history.
	Onboarded   bool     `json:"onboarded"`
	PrefLangs   []string `json:"prefLangs"`
	PrefGenres  []string `json:"prefGenres"`
	PrefArtists []string `json:"prefArtists"`
	// Discord presence through the desktop agent.
	DiscordPresence bool   `json:"discordPresence"`
	Language        string `json:"language"` // UI: vi | en
}

var accentNames = map[string]bool{
	"red": true, "orange": true, "amber": true, "yellow": true, "lime": true, "green": true,
	"teal": true, "cyan": true, "blue": true, "indigo": true, "violet": true, "pink": true, "song": true,
}

func defaultSettings() Settings {
	return Settings{CrossfadeSec: 4, GaplessAlbum: true, Normalize: true, Theme: "dark", Accent: "indigo", Visualizer: true, AutoplayMode: "free", PrefLangs: []string{}, PrefGenres: []string{}, PrefArtists: []string{}}
}

func (st *Settings) sanitize() {
	st.CrossfadeSec = max(0, min(st.CrossfadeSec, 12))
	switch st.Theme {
	case "dark", "light", "system":
	default:
		st.Theme = "dark"
	}
	if !accentNames[st.Accent] {
		st.Accent = "indigo"
	}
	switch st.AutoplayMode {
	case "off", "lib", "free":
	default:
		st.AutoplayMode = "free"
	}
	if st.Language != "en" {
		st.Language = "vi"
	}
	clip := func(xs []string, n, each int) []string {
		out := []string{}
		for _, x := range xs {
			x = strings.TrimSpace(x)
			if x != "" && len(x) <= each && len(out) < n {
				out = append(out, x)
			}
		}
		return out
	}
	st.PrefLangs = clip(st.PrefLangs, 6, 4)
	st.PrefGenres = clip(st.PrefGenres, 12, 20)
	st.PrefArtists = clip(st.PrefArtists, 30, 100)
}

func (s *Server) loadSettings(uid string) Settings {
	st := defaultSettings()
	var raw string
	if err := s.db.QueryRow(`SELECT settings_json FROM users WHERE id = ?`, uid).Scan(&raw); err == nil {
		json.Unmarshal([]byte(raw), &st)
	}
	st.sanitize()
	return st
}

func (s *Server) handleGetSettings(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.settingsView(userOf(r).ID))
}

// settingsView: the user's settings plus the admin's limits (read-only).
func (s *Server) settingsView(uid string) Settings {
	st := s.loadSettings(uid)
	srv := s.serverSettings()
	st.Limits = &PlayLimits{AutoplayTarget: srv.AutoplayTarget, AutoplayDownloads: srv.AutoplayDownloads}
	return st
}

func (s *Server) handlePutSettings(w http.ResponseWriter, r *http.Request) {
	uid := userOf(r).ID
	st := s.loadSettings(uid)
	prev := st
	if !readJSON(w, r, &st) {
		return
	}
	st.sanitize()
	st.Limits = nil // admin's, not stored per user
	b, _ := json.Marshal(st)
	if _, err := s.db.Exec(`UPDATE users SET settings_json = ? WHERE id = ?`, string(b), uid); err != nil {
		s.internalError(w, r, err)
		return
	}
	st = s.settingsView(uid)
	s.hub.Publish(uid, "settings", st)
	if st.AutoDownload && !prev.AutoDownload {
		s.autodl.kickNow(uid) // start right away when switched on
	}
	writeJSON(w, http.StatusOK, st)
}

// ServerSettings apply to the shared music store; admins edit them.
type ServerSettings struct {
	AudioFormat string `json:"audioFormat"` // m4a | opus
	Bitrate     int    `json:"bitrate"`     // kbps when transcoding
	// Discord presence: the server's Discord Application ID (its name shows
	// after "Listening to") and where users download the desktop agent.
	DiscordAppID string `json:"discordAppId"`
	AgentURL     string `json:"agentUrl"`
	// Suggestions and downloads (admin → "Gợi ý và tải").
	AutoplayTarget    int `json:"autoplayTarget"`    // songs autoplay keeps queued (5–50, 10)
	AutoplayDownloads int `json:"autoplayDownloads"` // new songs autoplay downloads per top-up (0–20, 6)
	AutoDLPerRun      int `json:"autoDlPerRun"`      // songs auto-download fetches per run (1–50, 10)
	PlaylistMax       int `json:"playlistMax"`       // songs taken from one playlist / album link (1–1000, 200)
}

// PlayLimits: the admin's limits the player needs, sent with the user's settings.
type PlayLimits struct {
	AutoplayTarget    int `json:"autoplayTarget"`
	AutoplayDownloads int `json:"autoplayDownloads"`
}

func clampDefault(v, lo, hi, def int) int {
	if v == 0 && lo > 0 {
		return def
	}
	return min(hi, max(lo, v))
}

func (st *ServerSettings) sanitize() {
	if st.AudioFormat != "m4a" && st.AudioFormat != "opus" {
		st.AudioFormat = "m4a"
	}
	switch st.Bitrate {
	case 128, 160, 192, 256, 320:
	default:
		st.Bitrate = 192
	}
	st.DiscordAppID = strings.TrimSpace(st.DiscordAppID)
	if st.DiscordAppID != "" && !isDigits(st.DiscordAppID) {
		st.DiscordAppID = ""
	}
	st.AgentURL = strings.TrimSpace(st.AgentURL)
	st.AutoplayTarget = clampDefault(st.AutoplayTarget, 5, 50, 10)
	if st.AutoplayDownloads < 0 || st.AutoplayDownloads > 20 {
		st.AutoplayDownloads = 6
	}
	st.AutoDLPerRun = clampDefault(st.AutoDLPerRun, 1, 50, 10)
	st.PlaylistMax = clampDefault(st.PlaylistMax, 1, 1000, 200)
	if st.AgentURL != "" && !strings.HasPrefix(st.AgentURL, "https://") && !strings.HasPrefix(st.AgentURL, "http://") {
		st.AgentURL = ""
	}
}

func isDigits(s string) bool {
	if len(s) < 5 || len(s) > 25 {
		return false
	}
	for _, c := range s {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

// handleDiscordInfo: what a user needs to set up presence.
func (s *Server) handleDiscordInfo(w http.ResponseWriter, r *http.Request) {
	st := s.serverSettings()
	writeJSON(w, http.StatusOK, map[string]any{"configured": st.DiscordAppID != "", "appId": st.DiscordAppID, "agentUrl": st.AgentURL, "server": s.baseURL(r), "downloads": s.agentDownloads()})
}

type agentDownload struct {
	OS   string `json:"os"` // windows | macos-arm64 | macos-amd64 | linux
	File string `json:"file"`
	URL  string `json:"url"`
	Size int64  `json:"size"`
}

// agentDownloads lists the agent builds found in AGENT_DIR.
func (s *Server) agentDownloads() []agentDownload {
	out := []agentDownload{}
	if s.cfg.AgentDir == "" {
		return out
	}
	for _, d := range []struct{ os, file string }{
		{"windows", "rii_music-windows-amd64.exe"}, {"macos-arm64", "rii_music-macos-arm64"}, {"macos-amd64", "rii_music-macos-amd64"}, {"linux", "rii_music-linux-amd64"},
	} {
		if st, err := os.Stat(filepath.Join(s.cfg.AgentDir, d.file)); err == nil && st.Mode().IsRegular() {
			out = append(out, agentDownload{OS: d.os, File: d.file, URL: "/download/agent/" + d.file, Size: st.Size()})
		}
	}
	return out
}

// handleAgentFile serves an agent build (public: it is the open-source app itself).
func (s *Server) handleAgentFile(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("file")
	for _, d := range s.agentDownloads() {
		if d.File == name {
			w.Header().Set("Content-Disposition", `attachment; filename="`+name+`"`)
			w.Header().Set("Content-Type", "application/octet-stream")
			http.ServeFile(w, r, filepath.Join(s.cfg.AgentDir, name))
			return
		}
	}
	http.NotFound(w, r)
}

func (s *Server) serverSettings() ServerSettings {
	st := ServerSettings{AudioFormat: "m4a", Bitrate: 192, AutoplayDownloads: 6}
	var raw string
	if err := s.db.QueryRow(`SELECT value_json FROM settings WHERE key = 'server'`).Scan(&raw); err == nil {
		json.Unmarshal([]byte(raw), &st)
	}
	st.sanitize()
	return st
}

func (s *Server) handleGetServerSettings(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.serverSettings())
}

func (s *Server) handlePutServerSettings(w http.ResponseWriter, r *http.Request) {
	st := s.serverSettings()
	if !readJSON(w, r, &st) {
		return
	}
	st.sanitize()
	b, _ := json.Marshal(st)
	if _, err := s.db.Exec(`INSERT INTO settings(key, value_json) VALUES ('server', ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`, string(b)); err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, st)
}
