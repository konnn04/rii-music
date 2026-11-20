package server

import (
	"crypto/rand"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"
)

// Nghe chung (listen together): a room with a 6-character code. Members
// (one slot per account) play the same queue in sync. The host made the room;
// "controller" members may change what plays, "listener" members only
// listen (the default when joining). Kept in memory: a restart closes rooms.
//
// Clients send a heartbeat every 20 s; a member without one for 60 s shows as
// disconnected and comes back by rejoining (same slot, same role). A room
// closes when nobody has been connected for 5 minutes, or when the host
// closes it.

const (
	roomCodeChars   = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789" // no 0/O, 1/I
	roomMemberStale = 60 * time.Second
	roomIdleClose   = 5 * time.Minute
	roomMaxQueue    = 200
)

type RoomMember struct {
	UserID    string `json:"userId"`
	Name      string `json:"name"`
	Role      string `json:"role"` // host | controller | listener
	Connected bool   `json:"connected"`
	JoinedAt  int64  `json:"joinedAt"`
	lastSeen  time.Time
}

// RoomState is what plays: the queue, the index of the current song, where it
// was at UpdatedAt and whether it plays. Rev grows with every change.
type RoomState struct {
	Queue      []string `json:"queue"`
	Index      int      `json:"index"`
	PositionMs int64    `json:"positionMs"`
	Playing    bool     `json:"playing"`
	UpdatedAt  int64    `json:"updatedAt"`
	Rev        int64    `json:"rev"`
	By         string   `json:"by"` // user id of who changed it
}

type Room struct {
	Code      string                 `json:"code"`
	HostID    string                 `json:"hostId"`
	CreatedAt int64                  `json:"createdAt"`
	State     RoomState              `json:"state"`
	members   map[string]*RoomMember // user id →
	idleSince time.Time              // zero while someone is connected
}

type roomHub struct {
	mu      sync.Mutex
	rooms   map[string]*Room  // code →
	byUser  map[string]string // user id → code (one room at a time)
	janitor sync.Once
}

func (h *roomHub) init() {
	if h.rooms == nil {
		h.rooms = map[string]*Room{}
		h.byUser = map[string]string{}
	}
}

func newRoomCode() string {
	b := make([]byte, 6)
	rand.Read(b)
	for i := range b {
		b[i] = roomCodeChars[int(b[i])%len(roomCodeChars)]
	}
	return string(b)
}

// view is a room as members see it (members sorted: host, then by join time).
func (r *Room) view() map[string]any {
	ms := make([]RoomMember, 0, len(r.members))
	for _, m := range r.members {
		ms = append(ms, *m)
	}
	sort.Slice(ms, func(i, j int) bool {
		if (ms[i].Role == "host") != (ms[j].Role == "host") {
			return ms[i].Role == "host"
		}
		return ms[i].JoinedAt < ms[j].JoinedAt
	})
	return map[string]any{"code": r.Code, "hostId": r.HostID, "createdAt": r.CreatedAt, "state": r.State, "members": ms}
}

// broadcast sends an event to every member of the room (call with h.mu held).
func (s *Server) roomBroadcast(r *Room, kind string, extra map[string]any) {
	ev := map[string]any{"type": kind, "room": r.view(), "now": nowMs()} // now: clients correct their clock
	for k, v := range extra {
		ev[k] = v
	}
	for uid := range r.members {
		s.hub.Publish(uid, "room", ev)
	}
}

// leaveLocked takes a user out of their room; closes it when the host leaves
// or nobody is left.
func (s *Server) roomLeaveLocked(uid string) {
	h := &s.rooms
	code, ok := h.byUser[uid]
	if !ok {
		return
	}
	delete(h.byUser, uid)
	r := h.rooms[code]
	if r == nil {
		return
	}
	delete(r.members, uid)
	if uid == r.HostID || len(r.members) == 0 {
		s.roomCloseLocked(r, "host-left")
		return
	}
	s.roomBroadcast(r, "members", nil)
}

func (s *Server) roomCloseLocked(r *Room, reason string) {
	h := &s.rooms
	ev := map[string]any{"type": "closed", "code": r.Code, "reason": reason}
	for uid := range r.members {
		s.hub.Publish(uid, "room", ev)
		if h.byUser[uid] == r.Code {
			delete(h.byUser, uid)
		}
	}
	delete(h.rooms, r.Code)
}

// sweep marks silent members disconnected and closes idle rooms.
func (s *Server) roomSweep() {
	h := &s.rooms
	h.mu.Lock()
	defer h.mu.Unlock()
	now := time.Now()
	for _, r := range h.rooms {
		changed, anyone := false, false
		for _, m := range r.members {
			on := now.Sub(m.lastSeen) < roomMemberStale
			if on != m.Connected {
				m.Connected, changed = on, true
			}
			anyone = anyone || on
		}
		if anyone {
			r.idleSince = time.Time{}
		} else if r.idleSince.IsZero() {
			r.idleSince = now
		} else if now.Sub(r.idleSince) > roomIdleClose {
			s.roomCloseLocked(r, "idle")
			continue
		}
		if changed {
			s.roomBroadcast(r, "members", nil)
		}
	}
}

func (s *Server) startRoomJanitor() {
	s.rooms.janitor.Do(func() {
		go func() {
			t := time.NewTicker(15 * time.Second)
			defer t.Stop()
			for range t.C {
				s.roomSweep()
			}
		}()
	})
}

func displayName(u *User) string {
	if strings.TrimSpace(u.Name) != "" {
		return u.Name
	}
	if i := strings.Index(u.Email, "@"); i > 0 {
		return u.Email[:i]
	}
	return u.Email
}

// roomOf finds the room in the path and the caller's membership.
func (s *Server) roomOf(w http.ResponseWriter, r *http.Request) (*Room, *RoomMember) {
	code := strings.ToUpper(strings.TrimSpace(r.PathValue("code")))
	room := s.rooms.rooms[code]
	if room == nil {
		httpError(w, http.StatusNotFound, "Phòng không tồn tại hoặc đã đóng")
		return nil, nil
	}
	m := room.members[userOf(r).ID]
	if m == nil {
		httpError(w, http.StatusForbidden, "Bạn chưa vào phòng này")
		return nil, nil
	}
	m.lastSeen, m.Connected = time.Now(), true
	room.idleSince = time.Time{}
	return room, m
}

// roomTracks returns the queue's songs (members may not have them in their library).
func (s *Server) roomTracks(r *Room) []Track {
	out := make([]Track, 0, len(r.State.Queue))
	for _, id := range r.State.Queue {
		if t, err := s.sharedTrack(id); err == nil {
			out = append(out, *t)
		}
	}
	return out
}

// roomCanAccess: songs of a room the user is in can be streamed by them.
func (s *Server) roomCanAccess(uid, trackID string) bool {
	h := &s.rooms
	h.mu.Lock()
	defer h.mu.Unlock()
	r := h.rooms[h.byUser[uid]]
	if r == nil {
		return false
	}
	for _, id := range r.State.Queue {
		if id == trackID {
			return true
		}
	}
	return false
}

// ── handlers ────────────────────────────────────────────────────────────

// POST /api/rooms: create a room (leaving any other one) with the caller's queue.
func (s *Server) handleCreateRoom(w http.ResponseWriter, r *http.Request) {
	u := userOf(r)
	var body RoomState
	if !readJSON(w, r, &body) {
		return
	}
	if !s.validRoomState(w, u, &body) {
		return
	}
	s.startRoomJanitor()
	h := &s.rooms
	h.mu.Lock()
	defer h.mu.Unlock()
	h.init()
	s.roomLeaveLocked(u.ID)
	code := newRoomCode()
	for h.rooms[code] != nil {
		code = newRoomCode()
	}
	now := time.Now()
	body.UpdatedAt, body.Rev, body.By = now.UnixMilli(), 1, u.ID
	room := &Room{Code: code, HostID: u.ID, CreatedAt: now.UnixMilli(), State: body,
		members: map[string]*RoomMember{u.ID: {UserID: u.ID, Name: displayName(u), Role: "host", Connected: true, JoinedAt: now.UnixMilli(), lastSeen: now}}}
	h.rooms[code] = room
	h.byUser[u.ID] = code
	writeJSON(w, http.StatusOK, map[string]any{"room": room.view(), "tracks": s.roomTracks(room), "now": nowMs()})
}

// POST /api/rooms/{code}/join: join (or rejoin: same slot, same role).
func (s *Server) handleJoinRoom(w http.ResponseWriter, r *http.Request) {
	u := userOf(r)
	code := strings.ToUpper(strings.TrimSpace(r.PathValue("code")))
	h := &s.rooms
	h.mu.Lock()
	defer h.mu.Unlock()
	h.init()
	room := h.rooms[code]
	if room == nil {
		httpError(w, http.StatusNotFound, "Sai mã phòng hoặc phòng đã đóng")
		return
	}
	if h.byUser[u.ID] != code {
		s.roomLeaveLocked(u.ID)
	}
	now := time.Now()
	m := room.members[u.ID]
	if m == nil {
		m = &RoomMember{UserID: u.ID, Name: displayName(u), Role: "listener", JoinedAt: now.UnixMilli()}
		room.members[u.ID] = m
	}
	m.Connected, m.lastSeen = true, now
	room.idleSince = time.Time{}
	h.byUser[u.ID] = code
	s.roomBroadcast(room, "members", nil)
	writeJSON(w, http.StatusOK, map[string]any{"room": room.view(), "tracks": s.roomTracks(room), "now": nowMs()})
}

// GET /api/rooms/mine: the room the caller is in, to reconnect after a reload.
func (s *Server) handleMyRoom(w http.ResponseWriter, r *http.Request) {
	u := userOf(r)
	h := &s.rooms
	h.mu.Lock()
	defer h.mu.Unlock()
	h.init()
	room := h.rooms[h.byUser[u.ID]]
	if room == nil {
		writeJSON(w, http.StatusOK, map[string]any{"room": nil})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"room": room.view(), "tracks": s.roomTracks(room), "now": nowMs()})
}

// GET /api/rooms/{code}: the room with its songs.
func (s *Server) handleGetRoom(w http.ResponseWriter, r *http.Request) {
	h := &s.rooms
	h.mu.Lock()
	defer h.mu.Unlock()
	h.init()
	room, _ := s.roomOf(w, r)
	if room == nil {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"room": room.view(), "tracks": s.roomTracks(room), "now": nowMs()})
}

// POST /api/rooms/{code}/heartbeat: still here.
func (s *Server) handleRoomHeartbeat(w http.ResponseWriter, r *http.Request) {
	h := &s.rooms
	h.mu.Lock()
	defer h.mu.Unlock()
	h.init()
	room, m := s.roomOf(w, r)
	if room == nil {
		return
	}
	if !m.Connected {
		m.Connected = true
		s.roomBroadcast(room, "members", nil)
	}
	writeJSON(w, http.StatusOK, map[string]any{"rev": room.State.Rev, "now": nowMs()})
}

// POST /api/rooms/{code}/leave.
func (s *Server) handleLeaveRoom(w http.ResponseWriter, r *http.Request) {
	h := &s.rooms
	h.mu.Lock()
	defer h.mu.Unlock()
	h.init()
	s.roomLeaveLocked(userOf(r).ID)
	w.WriteHeader(http.StatusNoContent)
}

// DELETE /api/rooms/{code}: the host closes the room.
func (s *Server) handleCloseRoom(w http.ResponseWriter, r *http.Request) {
	h := &s.rooms
	h.mu.Lock()
	defer h.mu.Unlock()
	h.init()
	room, m := s.roomOf(w, r)
	if room == nil {
		return
	}
	if m.Role != "host" {
		httpError(w, http.StatusForbidden, "Chỉ chủ phòng mới đóng được phòng")
		return
	}
	s.roomCloseLocked(room, "closed")
	w.WriteHeader(http.StatusNoContent)
}

// POST /api/rooms/{code}/state: the host or a controller changes what plays.
func (s *Server) handleRoomState(w http.ResponseWriter, r *http.Request) {
	u := userOf(r)
	var body RoomState
	if !readJSON(w, r, &body) {
		return
	}
	if !s.validRoomState(w, u, &body) {
		return
	}
	h := &s.rooms
	h.mu.Lock()
	defer h.mu.Unlock()
	h.init()
	room, m := s.roomOf(w, r)
	if room == nil {
		return
	}
	if m.Role == "listener" {
		httpError(w, http.StatusForbidden, "Bạn chỉ được nghe trong phòng này")
		return
	}
	body.UpdatedAt, body.Rev, body.By = nowMs(), room.State.Rev+1, u.ID
	room.State = body
	s.roomBroadcast(room, "state", map[string]any{"tracks": s.roomTracks(room)})
	writeJSON(w, http.StatusOK, map[string]any{"rev": body.Rev})
}

// POST /api/rooms/{code}/role: the host sets a member's role.
func (s *Server) handleRoomRole(w http.ResponseWriter, r *http.Request) {
	var body struct {
		UserID string `json:"userId"`
		Role   string `json:"role"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	if body.Role != "controller" && body.Role != "listener" {
		httpError(w, http.StatusBadRequest, "Vai trò không hợp lệ")
		return
	}
	h := &s.rooms
	h.mu.Lock()
	defer h.mu.Unlock()
	h.init()
	room, m := s.roomOf(w, r)
	if room == nil {
		return
	}
	if m.Role != "host" {
		httpError(w, http.StatusForbidden, "Chỉ chủ phòng mới đổi được vai trò")
		return
	}
	target := room.members[body.UserID]
	if target == nil || target.Role == "host" {
		httpError(w, http.StatusNotFound, "Không có thành viên này")
		return
	}
	target.Role = body.Role
	s.roomBroadcast(room, "members", nil)
	w.WriteHeader(http.StatusNoContent)
}

// validRoomState checks a queue sent by a member: their own songs (or the
// room's), sane numbers.
func (s *Server) validRoomState(w http.ResponseWriter, u *User, st *RoomState) bool {
	if len(st.Queue) > roomMaxQueue {
		st.Queue = st.Queue[:roomMaxQueue]
	}
	for _, id := range st.Queue {
		if !isHexID(id) || !(s.canAccess(u, id) || s.roomCanAccess(u.ID, id)) {
			httpError(w, http.StatusNotFound, "Có bài không phát được trong phòng")
			return false
		}
	}
	if st.Index < 0 || (len(st.Queue) > 0 && st.Index >= len(st.Queue)) {
		st.Index = 0
	}
	st.PositionMs = max(0, st.PositionMs)
	return true
}
