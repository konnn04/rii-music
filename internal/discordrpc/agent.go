package discordrpc

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"
)

// Agent polls a RiiMusic server for what is playing and mirrors it to Discord.
type Agent struct {
	Server   string // e.g. https://music.example.com
	Token    string // agent token from RiiMusic → Cài đặt → Discord
	ClientID string // optional; otherwise taken from the server
	Log      *slog.Logger
}

type nowPlaying struct {
	Playing    bool   `json:"playing"`
	TrackID    string `json:"trackId"`
	Title      string `json:"title"`
	Artist     string `json:"artist"`
	Album      string `json:"album"`
	DurationMs int64  `json:"durationMs"`
	PositionMs int64  `json:"positionMs"`
	CoverURL   string `json:"coverUrl"`
}

func (a *Agent) fetch(ctx context.Context, hc *http.Client) (*nowPlaying, string, error) {
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(a.Server, "/")+"/api/agent/nowplaying", nil)
	req.Header.Set("Authorization", "Bearer "+a.Token)
	res, err := hc.Do(req)
	if err != nil {
		return nil, "", err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, "", fmt.Errorf("server trả %s (kiểm tra token)", res.Status)
	}
	var body struct {
		NowPlaying      *nowPlaying `json:"nowPlaying"`
		DiscordClientID string      `json:"discordClientId"`
	}
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		return nil, "", err
	}
	return body.NowPlaying, body.DiscordClientID, nil
}

// Run loops until ctx ends, reconnecting to Discord and the server as needed.
func (a *Agent) Run(ctx context.Context) error {
	hc := &http.Client{Timeout: 10 * time.Second}
	var dc *Client
	var shown string // key of the activity currently displayed
	var lastConnErr string
	defer func() {
		if dc != nil {
			dc.SetActivity(nil)
			dc.Close()
		}
	}()
	tick := time.NewTicker(5 * time.Second)
	defer tick.Stop()
	for {
		np, serverClientID, err := a.fetch(ctx, hc)
		clientID := firstNonEmpty(a.ClientID, serverClientID)
		switch {
		case err != nil:
			a.Log.Warn("không lấy được trạng thái từ RiiMusic", "err", err)
		case clientID == "":
			a.Log.Warn("chưa có Discord Application ID: đặt trong RiiMusic → Cài đặt → Discord, hoặc dùng -client-id")
		default:
			if dc == nil {
				dc, err = Connect(clientID)
				if err != nil {
					// Say it once per distinct problem (e.g. wrong Application ID, Discord closed).
					if err.Error() != lastConnErr {
						a.Log.Warn("chưa kết nối được Discord", "err", err)
						lastConnErr = err.Error()
					}
					dc = nil
					break
				}
				lastConnErr = ""
				a.Log.Info("đã kết nối Discord")
				shown = ""
			}
			key := "none"
			var act *Activity
			if np != nil && np.Playing {
				start := time.Now().Add(-time.Duration(np.PositionMs) * time.Millisecond).Unix()
				act = &Activity{Title: np.Title, Artist: np.Artist, Album: np.Album, StartUnix: start, ImageURL: np.CoverURL, ImageKey: "vang"}
				if np.DurationMs > 0 {
					act.EndUnix = start + np.DurationMs/1000
				}
				key = fmt.Sprintf("%s|%d", np.TrackID, start/5) // re-send after seeks
			}
			if key != shown {
				if err := dc.SetActivity(act); err != nil {
					a.Log.Warn("mất kết nối Discord", "err", err)
					dc.Close()
					dc = nil
					break
				}
				shown = key
				if act != nil {
					a.Log.Info("đang hiển thị", "title", act.Title, "artist", act.Artist)
				} else {
					a.Log.Info("đã xoá trạng thái (không phát)")
				}
			}
		}
		select {
		case <-ctx.Done():
			return nil
		case <-tick.C:
		}
	}
}
