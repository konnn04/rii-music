package server

import (
	"net/http"
	"strconv"
	"sync"
	"time"
)

// Discord presence, per user: the web player reports what is playing (when
// the user turned "Trạng thái Discord" on); the desktop agent on their
// computer reads it with their agent token and shows it in Discord. The
// Discord Application ID is the admin's (server settings), so every user
// only runs the agent.

type NowPlaying struct {
	Playing    bool   `json:"playing"`
	TrackID    string `json:"trackId"`
	Title      string `json:"title"`
	Artist     string `json:"artist"`
	Album      string `json:"album"`
	DurationMs int64  `json:"durationMs"`
	PositionMs int64  `json:"positionMs"`
	UpdatedAt  int64  `json:"updatedAt"`
	CoverURL   string `json:"coverUrl,omitempty"`
}

type nowPlayingState struct {
	mu sync.Mutex
	m  map[string]NowPlaying // user id →
}

func (n *nowPlayingState) set(uid string, v *NowPlaying) {
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.m == nil {
		n.m = map[string]NowPlaying{}
	}
	if v == nil {
		delete(n.m, uid)
	} else {
		n.m[uid] = *v
	}
}

// get extrapolates the position; a playing state without a heartbeat for
// 2 minutes counts as stopped (the tab was closed).
func (n *nowPlayingState) get(uid string) *NowPlaying {
	n.mu.Lock()
	defer n.mu.Unlock()
	v, ok := n.m[uid]
	if !ok {
		return nil
	}
	now := time.Now().UnixMilli()
	if v.Playing {
		if now-v.UpdatedAt > 2*60*1000 {
			return nil
		}
		v.PositionMs += now - v.UpdatedAt
	}
	return &v
}

func (s *Server) handlePostNowPlaying(w http.ResponseWriter, r *http.Request) {
	u := userOf(r)
	var body struct {
		TrackID    string `json:"trackId"`
		PositionMs int64  `json:"positionMs"`
		Playing    bool   `json:"playing"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	if body.TrackID == "" || !s.loadSettings(u.ID).DiscordPresence {
		s.np.set(u.ID, nil)
		w.WriteHeader(http.StatusNoContent)
		return
	}
	t, err := s.getTrack(u.ID, body.TrackID)
	if err != nil {
		httpError(w, http.StatusNotFound, "Không có bài này")
		return
	}
	s.np.set(u.ID, &NowPlaying{Playing: body.Playing, TrackID: t.ID, Title: t.Title, Artist: t.Artist, Album: t.Album,
		DurationMs: t.DurationMs, PositionMs: max(0, body.PositionMs), UpdatedAt: nowMs()})
	w.WriteHeader(http.StatusNoContent)
}

// handleAgentNowPlaying serves the Discord agent (Authorization: Bearer <agent token>).
func (s *Server) handleAgentNowPlaying(w http.ResponseWriter, r *http.Request) {
	u := s.tokenUser(r, "agent")
	if u == nil {
		httpError(w, http.StatusUnauthorized, "Sai token agent")
		return
	}
	np := s.np.get(u.ID)
	if np != nil && !s.loadSettings(u.ID).DiscordPresence {
		np = nil
	}
	if np != nil {
		np.CoverURL = s.publicCoverURL(np.TrackID)
	}
	writeJSON(w, http.StatusOK, map[string]any{"nowPlaying": np, "discordClientId": s.serverSettings().DiscordAppID})
}

func strconvF(f float64) string { return strconv.FormatFloat(f, 'f', 3, 64) }
