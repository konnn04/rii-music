package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"

	embeddedpostgres "github.com/fergusstrange/embedded-postgres"

	"rii_music/internal/clientproxy"
	"rii_music/internal/server"
	"rii_music/internal/vault"
)

// Desktop app modes (RII_MODE), started by the Tauri shell as a sidecar:
//
//   client: forward everything to a RiiMusic server (RII_REMOTE).
//   local:  a private server for this machine only. Data in RII_APP_DIR
//           (PostgreSQL, covers, yt-dlp, keys), songs encrypted in
//           RII_MUSIC_DIR, one user signed in by the shell (RII_LOCAL_TOKEN).

// runClient serves the reverse proxy on 127.0.0.1:PORT until stopped.
func runClient(log *slog.Logger) error {
	remote, err := url.Parse(strings.TrimRight(strings.TrimSpace(os.Getenv("RII_REMOTE")), "/"))
	if err != nil || (remote.Scheme != "http" && remote.Scheme != "https") || remote.Host == "" {
		return fmt.Errorf("RII_REMOTE không hợp lệ: %q", os.Getenv("RII_REMOTE"))
	}
	h, err := clientproxy.New(remote, log)
	if err != nil {
		return err
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		// The shell waits for this; answered locally so a slow server doesn't block start-up.
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"ok":true,"mode":"client","version":%q}`, server.Version)
	})
	mux.Handle("/", h)
	hs := &http.Server{Addr: "127.0.0.1:" + envOr("PORT", "8080"), Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		sctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		hs.Shutdown(sctx)
	}()
	log.Info("RiiMusic desktop client", "remote", remote.String(), "addr", hs.Addr)
	if err := hs.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		return err
	}
	return nil
}

// prepareLocal sets the environment and config for local mode and starts the
// embedded PostgreSQL. The returned stop function shuts it down.
func prepareLocal(log *slog.Logger) (func(), error) {
	appDir := strings.TrimSpace(os.Getenv("RII_APP_DIR"))
	if appDir == "" {
		return nil, fmt.Errorf("RII_APP_DIR chưa đặt")
	}
	dataDir := filepath.Join(appDir, "data")
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return nil, err
	}
	os.Setenv("DATA_DIR", dataDir)
	if os.Getenv("RII_MUSIC_DIR") == "" {
		home, _ := os.UserHomeDir()
		os.Setenv("RII_MUSIC_DIR", filepath.Join(home, "Music", "RiiMusic"))
	}
	// Only this machine: never listen on the network.
	os.Setenv("PORT", envOr("PORT", "8080"))
	os.Setenv("RII_LISTEN_LOCAL", "1")
	if os.Getenv("ADMIN_EMAIL") == "" {
		os.Setenv("ADMIN_EMAIL", "local@riimusic.local")
	}
	// No storage quota on your own machine (MB).
	os.Setenv("DEFAULT_STORAGE_LIMIT_MB", "10000000")

	// Embedded PostgreSQL: binaries downloaded once into the app dir, data
	// next to them, a free local port and a password made at first start.
	pwFile := filepath.Join(appDir, "pg.secret")
	pw, err := os.ReadFile(pwFile)
	if err != nil {
		b := make([]byte, 16)
		rand.Read(b)
		pw = []byte(hex.EncodeToString(b))
		if err := os.WriteFile(pwFile, pw, 0o600); err != nil {
			return nil, err
		}
	}
	port, err := freePort()
	if err != nil {
		return nil, err
	}
	pg := embeddedpostgres.NewDatabase(embeddedpostgres.DefaultConfig().
		Version(embeddedpostgres.V17).
		Port(uint32(port)).
		Username("rii").Password(string(pw)).Database("rii_music").
		RuntimePath(filepath.Join(appDir, "pg", "runtime")).
		BinariesPath(filepath.Join(appDir, "pg", "bin")).
		CachePath(filepath.Join(appDir, "pg", "cache")).
		DataPath(filepath.Join(appDir, "pg", "data")).
		StartTimeout(3 * time.Minute).
		Logger(&slogWriter{log: log.With("component", "postgres")}))
	log.Info("starting local database (first start downloads PostgreSQL)", "dir", filepath.Join(appDir, "pg"))
	stopStalePostgres(appDir, log)
	if err := pg.Start(); err != nil {
		return nil, fmt.Errorf("PostgreSQL: %w", err)
	}
	os.Setenv("DATABASE_URL", fmt.Sprintf("postgres://rii:%s@127.0.0.1:%d/rii_music?sslmode=disable", pw, port))
	return func() {
		if err := pg.Stop(); err != nil {
			log.Warn("stop local database", "err", err)
		}
	}, nil
}

// localVaultKey: the key that encrypts songs in local mode, in the app dir
// (never next to the music).
func localVaultKey() (vault.Key, error) {
	return vault.LoadOrCreateKey(filepath.Join(os.Getenv("RII_APP_DIR"), "vault.key"))
}

// stopStalePostgres: a previous run that was killed (not shut down) leaves
// PostgreSQL running on the same data dir; stop it so this start succeeds.
func stopStalePostgres(appDir string, log *slog.Logger) {
	data := filepath.Join(appDir, "pg", "data")
	if _, err := os.Stat(filepath.Join(data, "postmaster.pid")); err != nil {
		return
	}
	ctl := filepath.Join(appDir, "pg", "bin", "bin", "pg_ctl")
	if runtime.GOOS == "windows" {
		ctl += ".exe"
	}
	if _, err := os.Stat(ctl); err != nil {
		return
	}
	log.Info("stopping a database left running by a previous session")
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	exec.CommandContext(ctx, ctl, "stop", "-D", data, "-m", "fast").Run()
}

func freePort() (int, error) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port, nil
}

// slogWriter turns PostgreSQL's output into debug log lines.
type slogWriter struct{ log *slog.Logger }

func (w *slogWriter) Write(p []byte) (int, error) {
	for _, line := range strings.Split(strings.TrimSpace(string(p)), "\n") {
		if line != "" {
			w.log.Debug(line)
		}
	}
	return len(p), nil
}
