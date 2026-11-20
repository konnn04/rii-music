// Package discordrpc talks to the local Discord desktop client over its IPC
// socket (named pipe on Windows, unix socket elsewhere) to set Rich Presence.
// This is the documented, ToS-friendly path: it needs a Discord application ID
// and Discord running on the same machine; no user token is involved.
package discordrpc

import (
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"time"
)

const (
	opHandshake = 0
	opFrame     = 1
	opClose     = 2
)

type Client struct {
	conn     io.ReadWriteCloser
	clientID string
}

// Connect opens the first available discord-ipc-N socket and performs the handshake.
func Connect(clientID string) (*Client, error) {
	var handshakeErr error // more useful than "no such pipe", so it wins
	for i := 0; i < 10; i++ {
		conn, err := dial(i)
		if err != nil {
			continue
		}
		c := &Client{conn: conn, clientID: clientID}
		if err := c.handshake(); err != nil {
			conn.Close()
			if handshakeErr == nil {
				handshakeErr = err
			}
			continue
		}
		return c, nil
	}
	if handshakeErr != nil {
		return nil, handshakeErr
	}
	return nil, errors.New("không tìm thấy Discord đang chạy trên máy này")
}

func dial(i int) (io.ReadWriteCloser, error) {
	name := fmt.Sprintf("discord-ipc-%d", i)
	if runtime.GOOS == "windows" {
		return os.OpenFile(`\\.\pipe\`+name, os.O_RDWR, 0)
	}
	dirs := []string{}
	for _, env := range []string{"XDG_RUNTIME_DIR", "TMPDIR", "TMP", "TEMP"} {
		if v := os.Getenv(env); v != "" {
			dirs = append(dirs, v)
		}
	}
	dirs = append(dirs, "/tmp")
	var lastErr error = os.ErrNotExist
	for _, d := range dirs {
		for _, sub := range []string{"", "app/com.discordapp.Discord", "snap.discord", ".flatpak/com.discordapp.Discord/xdg-run"} {
			conn, err := net.DialTimeout("unix", filepath.Join(d, sub, name), 2*time.Second)
			if err == nil {
				return conn, nil
			}
			lastErr = err
		}
	}
	return nil, lastErr
}

func (c *Client) send(op uint32, payload any) error {
	b, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	hdr := make([]byte, 8)
	binary.LittleEndian.PutUint32(hdr[0:4], op)
	binary.LittleEndian.PutUint32(hdr[4:8], uint32(len(b)))
	_, err = c.conn.Write(append(hdr, b...))
	return err
}

func (c *Client) recv() (uint32, map[string]any, error) {
	hdr := make([]byte, 8)
	if _, err := io.ReadFull(c.conn, hdr); err != nil {
		return 0, nil, err
	}
	op := binary.LittleEndian.Uint32(hdr[0:4])
	n := binary.LittleEndian.Uint32(hdr[4:8])
	if n > 1<<20 {
		return 0, nil, errors.New("discord ipc: frame too large")
	}
	body := make([]byte, n)
	if _, err := io.ReadFull(c.conn, body); err != nil {
		return 0, nil, err
	}
	var m map[string]any
	json.Unmarshal(body, &m)
	return op, m, nil
}

func (c *Client) handshake() error {
	if err := c.send(opHandshake, map[string]any{"v": 1, "client_id": c.clientID}); err != nil {
		return err
	}
	op, m, err := c.recv()
	if err != nil {
		return err
	}
	if op == opClose || m["evt"] != "READY" {
		return fmt.Errorf("discord từ chối kết nối: %v", m["message"])
	}
	return nil
}

// Activity is a "Listening to …" presence.
type Activity struct {
	Title, Artist, Album string
	StartUnix, EndUnix   int64 // seconds; zero = no progress bar
	ImageURL             string
	ImageKey             string // asset key uploaded in the Discord developer portal (fallback)
}

func nonce() string {
	b := make([]byte, 8)
	rand.Read(b)
	return hex.EncodeToString(b)
}

// SetActivity shows the activity; nil clears it.
func (c *Client) SetActivity(a *Activity) error {
	var act any
	if a != nil {
		m := map[string]any{
			"type":    2, // Listening
			"details": clip(a.Title, 128),
			"state":   clip(firstNonEmpty(a.Artist, "RiiMusic"), 128),
		}
		if a.StartUnix > 0 {
			ts := map[string]int64{"start": a.StartUnix}
			if a.EndUnix > a.StartUnix {
				ts["end"] = a.EndUnix
			}
			m["timestamps"] = ts
		}
		img := firstNonEmpty(a.ImageURL, a.ImageKey)
		if img != "" {
			m["assets"] = map[string]string{"large_image": img, "large_text": clip(firstNonEmpty(a.Album, a.Title), 128)}
		}
		act = m
	}
	if err := c.send(opFrame, map[string]any{
		"cmd": "SET_ACTIVITY", "nonce": nonce(),
		"args": map[string]any{"pid": os.Getpid(), "activity": act},
	}); err != nil {
		return err
	}
	_, m, err := c.recv()
	if err != nil {
		return err
	}
	if m["evt"] == "ERROR" {
		return fmt.Errorf("discord: %v", m["data"])
	}
	return nil
}

func (c *Client) Close() error { return c.conn.Close() }

func clip(s string, n int) string {
	r := []rune(s)
	if len(r) < 2 {
		return s + "  " // Discord requires ≥ 2 characters
	}
	if len(r) > n {
		return string(r[:n-1]) + "…"
	}
	return s
}

func firstNonEmpty(v ...string) string {
	for _, s := range v {
		if s != "" {
			return s
		}
	}
	return ""
}
