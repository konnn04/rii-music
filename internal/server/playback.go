package server

import (
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"
)

// Playback sync across a user's devices: each device reports what it plays;
// the others hear it over SSE ("playback"), pause if they were playing, and
// can take the session over ("Phát ở đây") with the same song, position and
// queue. They can also control it from afar (POST /api/playback/command →
// SSE "remote-cmd" to the playing device), like Spotify Connect. Kept in
// memory: a restart only forgets the last session.

type Playback struct {
	DeviceID   string   `json:"deviceId"`
	DeviceName string   `json:"deviceName"`
	TrackID    string   `json:"trackId"`
	PositionMs int64    `json:"positionMs"`
	Playing    bool     `json:"playing"`
	Upcoming   []string `json:"upcoming"` // next track ids, in order
	SourceName string   `json:"sourceName"`
	DurationMs int64    `json:"durationMs"`
	Volume     float64  `json:"volume"` // 0–1
	Shuffle    bool     `json:"shuffle"`
	Repeat     string   `json:"repeat"` // off | all | one
	UpdatedAt  int64    `json:"updatedAt"`
}

// sameShape: nothing a remote would show changed but the position drifting.
func (a Playback) sameShape(b Playback) bool {
	if a.DeviceID != b.DeviceID || a.TrackID != b.TrackID || a.Playing != b.Playing || a.Volume != b.Volume ||
		a.Shuffle != b.Shuffle || a.Repeat != b.Repeat || a.SourceName != b.SourceName || len(a.Upcoming) != len(b.Upcoming) {
		return false
	}
	for i := range a.Upcoming {
		if a.Upcoming[i] != b.Upcoming[i] {
			return false
		}
	}
	return abs64(a.PositionMs-b.PositionMs) <= 5000
}

type playbackState struct {
	mu      sync.Mutex
	m       map[string]Playback              // user id →
	devices map[string]map[string]deviceSeen // user id → device id →
}

type deviceSeen struct {
	Name string
	At   time.Time
}

// Device is one of the user's open apps, for "chọn thiết bị phát".
type Device struct {
	DeviceID   string `json:"deviceId"`
	DeviceName string `json:"deviceName"`
	Active     bool   `json:"active"`  // holds the session
	Playing    bool   `json:"playing"` // and plays right now
	LastSeen   int64  `json:"lastSeen"`
}

const deviceStale = 90 * time.Second

func (p *playbackState) seen(uid, id, name string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.devices == nil {
		p.devices = map[string]map[string]deviceSeen{}
	}
	if p.devices[uid] == nil {
		p.devices[uid] = map[string]deviceSeen{}
	}
	now := time.Now()
	for k, d := range p.devices[uid] {
		if now.Sub(d.At) > deviceStale {
			delete(p.devices[uid], k)
		}
	}
	p.devices[uid][id] = deviceSeen{Name: name, At: now}
}

func (p *playbackState) list(uid string) []Device {
	p.mu.Lock()
	defer p.mu.Unlock()
	sess := p.m[uid]
	out := []Device{}
	now := time.Now()
	for id, d := range p.devices[uid] {
		if now.Sub(d.At) > deviceStale {
			continue
		}
		active := id == sess.DeviceID && sess.TrackID != ""
		out = append(out, Device{DeviceID: id, DeviceName: d.Name, Active: active,
			Playing: active && sess.Playing && time.Now().UnixMilli()-sess.UpdatedAt < 2*60*1000, LastSeen: d.At.UnixMilli()})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].LastSeen > out[j].LastSeen })
	return out
}

// POST /api/devices: this app is open (every 30 s), so it can be picked as the player.
func (s *Server) handleDeviceSeen(w http.ResponseWriter, r *http.Request) {
	var b struct {
		DeviceID   string `json:"deviceId"`
		DeviceName string `json:"deviceName"`
	}
	if !readJSON(w, r, &b) {
		return
	}
	b.DeviceID = strings.TrimSpace(b.DeviceID)
	if b.DeviceID == "" || len(b.DeviceID) > 64 {
		httpError(w, http.StatusBadRequest, "Thiếu mã thiết bị")
		return
	}
	if len(b.DeviceName) > 80 {
		b.DeviceName = b.DeviceName[:80]
	}
	s.playback.seen(userOf(r).ID, b.DeviceID, b.DeviceName)
	w.WriteHeader(http.StatusNoContent)
}

// GET /api/devices: the user's open apps, the one playing first.
func (s *Server) handleListDevices(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.playback.list(userOf(r).ID))
}

func (p *playbackState) set(uid string, v Playback) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.m == nil {
		p.m = map[string]Playback{}
	}
	p.m[uid] = v
}

// get extrapolates the position of a playing session; one without a heartbeat
// for 2 minutes counts as paused (the tab was closed).
func (p *playbackState) get(uid string) (Playback, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	v, ok := p.m[uid]
	if !ok {
		return v, false
	}
	now := time.Now().UnixMilli()
	if v.Playing {
		if now-v.UpdatedAt > 2*60*1000 {
			v.Playing = false
		} else {
			v.PositionMs += now - v.UpdatedAt
		}
	}
	return v, true
}

func (s *Server) handlePostPlayback(w http.ResponseWriter, r *http.Request) {
	u := userOf(r)
	var b Playback
	if !readJSON(w, r, &b) {
		return
	}
	b.DeviceID = strings.TrimSpace(b.DeviceID)
	if b.DeviceID == "" || len(b.DeviceID) > 64 {
		httpError(w, http.StatusBadRequest, "Thiếu mã thiết bị")
		return
	}
	if len(b.DeviceName) > 80 {
		b.DeviceName = b.DeviceName[:80]
	}
	if len(b.SourceName) > 200 {
		b.SourceName = b.SourceName[:200]
	}
	if len(b.Upcoming) > 100 {
		b.Upcoming = b.Upcoming[:100]
	}
	b.PositionMs = max(0, b.PositionMs)
	b.Volume = min(1, max(0, b.Volume))
	if b.Repeat != "all" && b.Repeat != "one" {
		b.Repeat = "off"
	}
	b.UpdatedAt = nowMs()
	s.playback.seen(u.ID, b.DeviceID, b.DeviceName)
	prev, had := s.playback.get(u.ID)
	// A device that stopped (e.g. paused because another one took over) must
	// not replace the session of the device that is playing now.
	if had && prev.DeviceID != b.DeviceID && prev.Playing && !b.Playing {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	s.playback.set(u.ID, b)
	// Tell the user's other devices when something they'd notice changed
	// (heartbeats of the same song on the same device stay quiet).
	if !had || !prev.sameShape(b) {
		s.hub.Publish(u.ID, "playback", b)
	}

	// Discord presence reads the same report.
	if s.loadSettings(u.ID).DiscordPresence {
		if b.TrackID == "" {
			s.np.set(u.ID, nil)
		} else if t, err := s.getTrack(u.ID, b.TrackID); err == nil {
			s.np.set(u.ID, &NowPlaying{Playing: b.Playing, TrackID: t.ID, Title: t.Title, Artist: t.Artist, Album: t.Album,
				DurationMs: t.DurationMs, PositionMs: b.PositionMs, UpdatedAt: b.UpdatedAt})
		}
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleGetPlayback returns the last session with its tracks, to take it over.
func (s *Server) handleGetPlayback(w http.ResponseWriter, r *http.Request) {
	u := userOf(r)
	b, ok := s.playback.get(u.ID)
	if !ok || b.TrackID == "" {
		writeJSON(w, http.StatusOK, map[string]any{"session": nil})
		return
	}
	ids := append([]string{b.TrackID}, b.Upcoming...)
	byID := map[string]Track{}
	if all, err := s.libTracks(u.ID, ``); err == nil {
		for _, t := range all {
			byID[t.ID] = t
		}
	}
	tracks := []Track{}
	for _, id := range ids {
		if t, ok := byID[id]; ok {
			tracks = append(tracks, t)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"session": b, "tracks": tracks})
}

// RemoteCommand: what another of the user's devices asks the playing one to do.
type RemoteCommand struct {
	Target     string   `json:"target"` // device id of the playing device
	From       string   `json:"from"`
	Cmd        string   `json:"cmd"`
	PositionMs int64    `json:"positionMs"`         // seek
	Volume     float64  `json:"volume"`             // volume
	Index      int      `json:"index"`              // jump / remove / move: position in "upcoming"
	To         int      `json:"to"`                 // move
	TrackID    string   `json:"trackId,omitempty"`  // jump / remove: the track expected at Index
	TrackIDs   []string `json:"trackIds,omitempty"` // playNow / queue
}

var remoteCmds = map[string]bool{
	"play": true, "pause": true, "toggle": true, "next": true, "prev": true, "seek": true, "volume": true,
	"jump": true, "remove": true, "move": true, "playNow": true, "queue": true, "playNext": true, "shuffle": true, "repeat": true,
	"takeOver": true, // "play here": the target continues the session
}

// handlePlaybackCommand relays a remote control command to the playing device.
func (s *Server) handlePlaybackCommand(w http.ResponseWriter, r *http.Request) {
	u := userOf(r)
	var c RemoteCommand
	if !readJSON(w, r, &c) {
		return
	}
	if !remoteCmds[c.Cmd] || c.Target == "" || len(c.Target) > 64 || len(c.From) > 64 || len(c.TrackIDs) > 200 {
		httpError(w, http.StatusBadRequest, "Lệnh không hợp lệ")
		return
	}
	for _, id := range append(c.TrackIDs, c.TrackID) {
		if id != "" && !s.canAccess(u, id) {
			httpError(w, http.StatusNotFound, "Không có bài này")
			return
		}
	}
	c.Volume = min(1, max(0, c.Volume))
	c.PositionMs = max(0, c.PositionMs)
	s.hub.Publish(u.ID, "remote-cmd", c)
	w.WriteHeader(http.StatusNoContent)
}

func abs64(x int64) int64 {
	if x < 0 {
		return -x
	}
	return x
}
