package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"
)

// Hub fans server events (job progress, library changes) out to SSE clients.
// Each subscriber belongs to a user and only gets that user's events, plus
// events for everyone (shared track data such as a measured gain).
type Hub struct {
	mu   sync.Mutex
	subs map[chan []byte]string // → user id
}

func NewHub() *Hub { return &Hub{subs: map[chan []byte]string{}} }

func frame(event string, data any) []byte {
	b, err := json.Marshal(data)
	if err != nil {
		return nil
	}
	return []byte(fmt.Sprintf("event: %s\ndata: %s\n\n", event, b))
}

// Publish sends an event to every open tab of one user.
func (h *Hub) Publish(uid, event string, data any) {
	msg := frame(event, data)
	if msg == nil {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	for ch, owner := range h.subs {
		if owner == uid {
			send(ch, msg)
		}
	}
}

// PublishAll sends an event to everyone.
func (h *Hub) PublishAll(event string, data any) {
	msg := frame(event, data)
	if msg == nil {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	for ch := range h.subs {
		send(ch, msg)
	}
}

func send(ch chan []byte, msg []byte) {
	select {
	case ch <- msg:
	default: // slow client: drop; it refetches on reconnect
	}
}

func (h *Hub) subscribe(uid string) chan []byte {
	ch := make(chan []byte, 64)
	h.mu.Lock()
	h.subs[ch] = uid
	h.mu.Unlock()
	return ch
}

func (h *Hub) unsubscribe(ch chan []byte) {
	h.mu.Lock()
	delete(h.subs, ch)
	h.mu.Unlock()
}

// online lists user ids with an open tab (admin page).
func (h *Hub) online() map[string]bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	out := map[string]bool{}
	for _, uid := range h.subs {
		out[uid] = true
	}
	return out
}

func (s *Server) handleSSE(w http.ResponseWriter, r *http.Request) {
	rc := http.NewResponseController(w)
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	fmt.Fprint(w, "retry: 3000\n\n")
	rc.Flush()

	ch := s.hub.subscribe(userOf(r).ID)
	defer s.hub.unsubscribe(ch)
	ping := time.NewTicker(25 * time.Second)
	defer ping.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case msg := <-ch:
			if _, err := w.Write(msg); err != nil {
				return
			}
			rc.Flush()
		case <-ping.C:
			if _, err := fmt.Fprint(w, ": ping\n\n"); err != nil {
				return
			}
			rc.Flush()
		}
	}
}
