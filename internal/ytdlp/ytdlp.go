// Package ytdlp manages the yt-dlp binary (download, checksum, daily refresh)
// and runs it as a child process with arguments passed as an argv array — never
// through a shell.
package ytdlp

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

type Config struct {
	Path       string // explicit binary; empty = managed copy in BinDir
	BinDir     string // where the managed binary lives
	FFmpeg     string
	Cookies    string // Netscape cookies.txt, used when the file exists
	JSRuntime  string // deno|node|"" (auto)
	RemoteEJS  bool   // --remote-components ejs:github
	GeoCountry string
}

type Client struct {
	cfg   Config
	log   *slog.Logger
	ready chan struct{}

	mu        sync.RWMutex
	bin       string
	managed   bool
	initErr   error
	jsRuntime string
}

func New(cfg Config, log *slog.Logger) *Client {
	return &Client{cfg: cfg, log: log, ready: make(chan struct{})}
}

const nightlyBase = "https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download/"

func assetName() string {
	switch runtime.GOOS {
	case "windows":
		return "yt-dlp.exe"
	case "darwin":
		return "yt-dlp_macos"
	default:
		if runtime.GOARCH == "arm64" {
			return "yt-dlp_linux_aarch64"
		}
		return "yt-dlp_linux"
	}
}

func (c *Client) managedPath() string {
	name := "yt-dlp"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	return filepath.Join(c.cfg.BinDir, name)
}

// Init resolves the binary, downloading it if needed, then keeps it fresh daily.
// Downloads wait on Ready, so the server can start serving immediately.
func (c *Client) Init(ctx context.Context) {
	c.jsRuntime = c.cfg.JSRuntime
	if c.jsRuntime == "" {
		for _, rt := range []string{"deno", "node"} {
			if _, err := exec.LookPath(rt); err == nil {
				c.jsRuntime = rt
				break
			}
		}
	}

	bin, managed, err := c.resolve(ctx)
	c.mu.Lock()
	c.bin, c.managed, c.initErr = bin, managed, err
	c.mu.Unlock()
	close(c.ready)
	if err != nil {
		c.log.Error("yt-dlp unavailable", "err", err)
		return
	}
	c.log.Info("yt-dlp ready", "bin", bin, "managed", managed, "js_runtime", c.jsRuntime, "version", c.Version(ctx))

	if !managed {
		return
	}
	t := time.NewTicker(6 * time.Hour)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if c.stale() {
				if err := c.download(ctx); err != nil {
					c.log.Warn("yt-dlp refresh failed", "err", err)
				}
			}
		}
	}
}

func (c *Client) resolve(ctx context.Context) (string, bool, error) {
	if c.cfg.Path != "" {
		p, err := exec.LookPath(c.cfg.Path)
		if err != nil {
			return "", false, fmt.Errorf("YTDLP_PATH %q: %w", c.cfg.Path, err)
		}
		return p, false, nil
	}
	mp := c.managedPath()
	if _, err := os.Stat(mp); err != nil || c.stale() {
		if err := c.download(ctx); err != nil {
			c.log.Warn("could not download yt-dlp", "err", err)
		}
	}
	if _, err := os.Stat(mp); err == nil {
		return mp, true, nil
	}
	if p, err := exec.LookPath("yt-dlp"); err == nil {
		return p, false, nil
	}
	return "", false, errors.New("yt-dlp not found and could not be downloaded")
}

func (c *Client) stale() bool {
	st, err := os.Stat(c.managedPath())
	return err != nil || time.Since(st.ModTime()) > 24*time.Hour
}

// download fetches the nightly build and verifies it against SHA2-256SUMS.
func (c *Client) download(ctx context.Context) error {
	if err := os.MkdirAll(c.cfg.BinDir, 0o755); err != nil {
		return err
	}
	asset := assetName()
	hc := &http.Client{Timeout: 5 * time.Minute}

	sums, err := httpGet(ctx, hc, nightlyBase+"SHA2-256SUMS")
	if err != nil {
		return fmt.Errorf("checksums: %w", err)
	}
	want := ""
	for _, line := range strings.Split(string(sums), "\n") {
		f := strings.Fields(line)
		if len(f) == 2 && f[1] == asset {
			want = f[0]
		}
	}
	if want == "" {
		return fmt.Errorf("no checksum for %s", asset)
	}

	body, err := httpGet(ctx, hc, nightlyBase+asset)
	if err != nil {
		return fmt.Errorf("binary: %w", err)
	}
	sum := sha256.Sum256(body)
	if got := hex.EncodeToString(sum[:]); got != want {
		return fmt.Errorf("checksum mismatch for %s: want %s got %s", asset, want, got)
	}

	tmp := c.managedPath() + ".tmp"
	if err := os.WriteFile(tmp, body, 0o755); err != nil {
		return err
	}
	if err := os.Rename(tmp, c.managedPath()); err != nil {
		os.Remove(tmp)
		return err
	}
	c.log.Info("yt-dlp downloaded", "asset", asset, "bytes", len(body))
	return nil
}

func httpGet(ctx context.Context, hc *http.Client, url string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "rii-music")
	res, err := hc.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GET %s: %s", url, res.Status)
	}
	return io.ReadAll(io.LimitReader(res.Body, 200<<20))
}

// Wait blocks until Init has resolved the binary.
func (c *Client) Wait(ctx context.Context) (string, error) {
	select {
	case <-ctx.Done():
		return "", ctx.Err()
	case <-c.ready:
	}
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.bin, c.initErr
}

// Status reports whether yt-dlp is usable, for the UI.
func (c *Client) Status() (ready bool, err error) {
	select {
	case <-c.ready:
	default:
		return false, nil
	}
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.initErr == nil, c.initErr
}

// Update downloads the latest nightly now (admin action). Only for the binary
// RiiMusic manages; a YTDLP_PATH binary is the operator's to update.
func (c *Client) Update(ctx context.Context) error {
	c.mu.RLock()
	managed := c.managed
	c.mu.RUnlock()
	if !managed {
		return errors.New("yt-dlp không do RiiMusic quản lý (đang dùng YTDLP_PATH hoặc bản cài sẵn)")
	}
	return c.download(ctx)
}

// Info describes the binary in use, for the admin page.
func (c *Client) Info() (bin string, managed bool, jsRuntime string) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.bin, c.managed, c.jsRuntime
}

func (c *Client) Version(ctx context.Context) string {
	out, err := c.Run(ctx, []string{"--version"}, nil)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(out)
}

// BaseArgs are added to every invocation.
func (c *Client) BaseArgs() []string {
	// UTF-8 output whatever the OS code page (Windows prints Vietnamese titles in cp1258 otherwise).
	args := []string{"--ignore-config", "--no-warnings", "--socket-timeout", "20", "--encoding", "utf-8"}
	if c.cfg.FFmpeg != "" {
		args = append(args, "--ffmpeg-location", c.cfg.FFmpeg)
	}
	if c.cfg.Cookies != "" {
		if _, err := os.Stat(c.cfg.Cookies); err == nil {
			args = append(args, "--cookies", c.cfg.Cookies)
		}
	}
	if c.jsRuntime != "" {
		args = append(args, "--js-runtimes", c.jsRuntime)
	}
	if c.cfg.RemoteEJS {
		args = append(args, "--remote-components", "ejs:github")
	}
	if c.cfg.GeoCountry != "" {
		args = append(args, "--xff", c.cfg.GeoCountry)
	}
	return args
}

// Error is a failed yt-dlp run with the most useful line of stderr.
type Error struct {
	Code   int
	Reason string
}

func (e *Error) Error() string { return "yt-dlp: " + e.Reason }

// Run executes yt-dlp with BaseArgs + args. onLine, if set, receives each stdout
// line as it arrives; the full stdout is returned too.
func (c *Client) Run(ctx context.Context, args []string, onLine func(string)) (string, error) {
	bin, err := c.Wait(ctx)
	if err != nil {
		return "", err
	}
	cmd := exec.CommandContext(ctx, bin, append(c.BaseArgs(), args...)...)
	cmd.Env = append(os.Environ(), "NO_COLOR=1", "PYTHONIOENCODING=utf-8")
	cmd.WaitDelay = 5 * time.Second
	var stderr tailBuffer
	cmd.Stderr = &stderr
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return "", err
	}
	if err := cmd.Start(); err != nil {
		return "", err
	}
	var out bytes.Buffer
	sc := bufio.NewScanner(stdout)
	sc.Buffer(make([]byte, 64*1024), 64<<20)
	sc.Split(scanLinesCR)
	for sc.Scan() {
		line := sc.Text()
		out.WriteString(line)
		out.WriteByte('\n')
		if onLine != nil {
			onLine(line)
		}
	}
	if err := cmd.Wait(); err != nil {
		if ctx.Err() != nil {
			return out.String(), ctx.Err()
		}
		code := -1
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			code = ee.ExitCode()
		}
		return out.String(), &Error{Code: code, Reason: stderr.reason()}
	}
	return out.String(), nil
}

// scanLinesCR splits on \n or \r so progress updates arrive line by line.
func scanLinesCR(data []byte, atEOF bool) (int, []byte, error) {
	for i, b := range data {
		if b == '\n' || b == '\r' {
			return i + 1, data[:i], nil
		}
	}
	if atEOF && len(data) > 0 {
		return len(data), data, nil
	}
	return 0, nil, nil
}

// tailBuffer keeps the last 16 KiB of stderr.
type tailBuffer struct{ b []byte }

func (t *tailBuffer) Write(p []byte) (int, error) {
	t.b = append(t.b, p...)
	if len(t.b) > 16<<10 {
		t.b = t.b[len(t.b)-16<<10:]
	}
	return len(p), nil
}

func (t *tailBuffer) reason() string {
	lines := strings.Split(strings.TrimSpace(string(t.b)), "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		if l := strings.TrimSpace(lines[i]); strings.HasPrefix(l, "ERROR:") {
			return strings.TrimSpace(strings.TrimPrefix(l, "ERROR:"))
		}
	}
	if len(lines) > 0 && strings.TrimSpace(lines[len(lines)-1]) != "" {
		return strings.TrimSpace(lines[len(lines)-1])
	}
	return "lỗi không rõ"
}

// Entry is one item of a flat playlist or search result.
type Entry struct {
	ID        string  `json:"id"`
	Title     string  `json:"title"`
	Duration  float64 `json:"duration"`
	Channel   string  `json:"channel"`
	Uploader  string  `json:"uploader"`
	Thumbnail string  `json:"thumbnail"`
	Thumbs    []struct {
		URL   string `json:"url"`
		Width int    `json:"width"`
	} `json:"thumbnails"`
}

type FlatResult struct {
	Title   string  `json:"title"`
	Entries []Entry `json:"entries"`
}

// Flat lists a playlist or search ("ytsearchN:q") without downloading anything.
func (c *Client) Flat(ctx context.Context, target string) (*FlatResult, error) {
	out, err := c.Run(ctx, []string{"-J", "--flat-playlist", "--", target}, nil)
	if err != nil {
		return nil, err
	}
	var r FlatResult
	if err := json.Unmarshal([]byte(out), &r); err != nil {
		return nil, fmt.Errorf("parse yt-dlp json: %w", err)
	}
	for i := range r.Entries {
		e := &r.Entries[i]
		if e.Thumbnail == "" && len(e.Thumbs) > 0 {
			e.Thumbnail = e.Thumbs[len(e.Thumbs)-1].URL
		}
		e.Thumbs = nil
	}
	return &r, nil
}
