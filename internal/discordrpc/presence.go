package discordrpc

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"sync"
	"time"
)

// Presence shows "Listening to …" for the desktop app: the web app running in
// it posts what plays to /__rii/discord on its local sidecar, which talks to
// the Discord client on the same computer (no separate agent, no token).

// Playing is what the web app reports.
type Playing struct {
	ClientID   string `json:"clientId"` // the server's Discord Application ID
	Playing    bool   `json:"playing"`
	TrackID    string `json:"trackId"`
	Title      string `json:"title"`
	Artist     string `json:"artist"`
	Album      string `json:"album"`
	DurationMs int64  `json:"durationMs"`
	PositionMs int64  `json:"positionMs"`
	CoverURL   string `json:"coverUrl"`

	at time.Time // when it was posted: positionMs is relative to this
}

type Presence struct {
	log     *slog.Logger
	mu      sync.Mutex
	dc      *Client
	client  string // Application ID of the open connection
	shown   string
	lastErr string
	cur     *Playing
	wake    chan struct{}
	stop    chan struct{}
	done    chan struct{}
	once    sync.Once
}

// NewPresence starts the background loop (reconnects every 15 s while Discord
// is closed; re-sends after reconnecting).
func NewPresence(log *slog.Logger) *Presence {
	p := &Presence{log: log, wake: make(chan struct{}, 1), stop: make(chan struct{}), done: make(chan struct{})}
	go p.loop()
	return p
}

// Close clears any shown Discord status and closes the IPC connection.
func (p *Presence) Close() {
	p.once.Do(func() {
		close(p.stop)
		<-p.done
	})
}

func (p *Presence) set(np *Playing) {
	p.mu.Lock()
	p.cur = np
	p.mu.Unlock()
	select {
	case p.wake <- struct{}{}:
	default:
	}
}

func (p *Presence) loop() {
	defer func() {
		p.mu.Lock()
		if p.dc != nil {
			_ = p.dc.SetActivity(nil)
			_ = p.dc.Close()
			p.dc, p.shown = nil, ""
		}
		p.mu.Unlock()
		close(p.done)
	}()
	tick := time.NewTicker(15 * time.Second)
	defer tick.Stop()
	for {
		p.apply()
		select {
		case <-p.stop:
			return
		case <-p.wake:
		case <-tick.C:
		}
	}
}

func (p *Presence) apply() {
	p.mu.Lock()
	defer p.mu.Unlock()
	np := p.cur
	if np == nil || np.ClientID == "" {
		if p.dc != nil {
			p.dc.SetActivity(nil)
			p.dc.Close()
			p.dc, p.shown = nil, ""
		}
		return
	}
	if p.dc != nil && p.client != np.ClientID { // the admin changed the Application ID
		p.dc.Close()
		p.dc, p.shown = nil, ""
	}
	if p.dc == nil {
		dc, err := Connect(np.ClientID)
		if err != nil {
			if err.Error() != p.lastErr {
				p.log.Info("Discord not reachable (is it running?)", "err", err)
				p.lastErr = err.Error()
			}
			return
		}
		p.dc, p.client, p.shown, p.lastErr = dc, np.ClientID, "", ""
		p.log.Info("connected to Discord")
	}
	key := "none"
	var act *Activity
	if np.Playing && np.Title != "" {
		// From the moment it was posted, not now: the loop re-applies every 15 s, and
		// counting from now moved the start forward each time (progress reset to 0:00).
		start := np.at.Add(-time.Duration(np.PositionMs) * time.Millisecond).Unix()
		act = &Activity{Title: np.Title, Artist: np.Artist, Album: np.Album, StartUnix: start, ImageURL: np.CoverURL, ImageKey: "riimusic"}
		if np.DurationMs > 0 {
			act.EndUnix = start + np.DurationMs/1000
		}
		key = fmt.Sprintf("%s|%d", np.TrackID, start/5) // re-send after a seek
	}
	if key == p.shown {
		return
	}
	if err := p.dc.SetActivity(act); err != nil {
		p.log.Info("lost the Discord connection", "err", err)
		p.dc.Close()
		p.dc, p.shown = nil, ""
		return
	}
	p.shown = key
}

// Handler: POST a Playing as JSON (header X-RiiMusic required, so a web page
// elsewhere can't post to it), DELETE to clear.
func (p *Presence) Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-RiiMusic") == "" {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		switch r.Method {
		case http.MethodPost:
			var np Playing
			if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&np); err != nil {
				http.Error(w, "bad request", http.StatusBadRequest)
				return
			}
			np.at = time.Now()
			p.set(&np)
		case http.MethodDelete:
			p.set(nil)
		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
}
