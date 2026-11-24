// RiiMusic — self-hosted personal music player: one binary serving the web app and API.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"rii_music/internal/db"
	"rii_music/internal/discordrpc"
	"rii_music/internal/server"
	"rii_music/internal/ytdlp"
	"rii_music/web"
)

func main() {
	// .env next to the binary's working directory (or ENV_FILE); real
	// environment variables win over it.
	if err := server.LoadDotEnv(envOr("ENV_FILE", ".env")); err != nil {
		slog.Error("đọc .env lỗi", "err", err)
	}
	if len(os.Args) > 1 && (os.Args[1] == "-version" || os.Args[1] == "version") {
		fmt.Println("rii_music", server.Version)
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "-healthcheck" {
		res, err := http.Get("http://127.0.0.1:" + envOr("PORT", "8080") + "/api/health")
		if err != nil || res.StatusCode != http.StatusOK {
			os.Exit(1)
		}
		os.Exit(0)
	}
	level := slog.LevelInfo
	if strings.EqualFold(os.Getenv("LOG_LEVEL"), "debug") {
		level = slog.LevelDebug
	}
	logBuf := server.NewLogBuffer(3000) // recent logs for the admin page
	log := slog.New(logBuf.Wrap(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: level})))
	slog.SetDefault(log)

	if len(os.Args) > 1 && os.Args[1] == "migrate" {
		if err := runMigrate(os.Args[2:]); err != nil {
			log.Error("migrate", "err", err)
			os.Exit(1)
		}
		return
	}

	if len(os.Args) > 1 && os.Args[1] == "discord-agent" {
		if err := runDiscordAgent(os.Args[2:], log); err != nil {
			log.Error("discord agent", "err", err)
			os.Exit(1)
		}
		return
	}

	switch os.Getenv("RII_MODE") {
	case "client": // desktop app connected to a RiiMusic server
		if err := runClient(log); err != nil {
			log.Error("fatal", "err", err)
			os.Exit(1)
		}
		return
	case "local": // desktop app on its own
		stopPG, err := prepareLocal(log)
		if err != nil {
			log.Error("fatal", "err", err)
			os.Exit(1)
		}
		err = run(log, logBuf)
		stopPG()
		if err != nil {
			log.Error("fatal", "err", err)
			os.Exit(1)
		}
		return
	}
	if err := run(log, logBuf); err != nil {
		log.Error("fatal", "err", err)
		os.Exit(1)
	}
}

func run(log *slog.Logger, logBuf *server.LogBuffer) error {
	cfg := server.LoadConfig()
	if cfg.ForceIPv4 {
		forceIPv4()
	}
	for _, d := range []string{cfg.DataDir, cfg.MusicDir(), cfg.CoverDir(), cfg.TmpDir(), cfg.BinDir()} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			return err
		}
	}

	database, err := db.Open(context.Background(), cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer database.Close()

	// yt-dlp wants a real path for --ffmpeg-location, not a bare command name.
	if p, err := exec.LookPath(cfg.FFmpeg); err == nil {
		if abs, err := filepath.Abs(p); err == nil {
			cfg.FFmpeg = abs
		}
	} else {
		log.Error("ffmpeg not found — downloads will fail until it is installed or FFMPEG_PATH is set", "ffmpeg", cfg.FFmpeg)
	}

	cookies := os.Getenv("YT_COOKIES_PATH")
	if cookies == "" {
		cookies = filepath.Join(cfg.DataDir, "cookies.txt")
	}
	yt := ytdlp.New(ytdlp.Config{
		Path:       os.Getenv("YTDLP_PATH"),
		BinDir:     cfg.BinDir(),
		FFmpeg:     cfg.FFmpeg,
		Cookies:    cookies,
		JSRuntime:  os.Getenv("YTDLP_JS_RUNTIME"),
		RemoteEJS:  os.Getenv("YTDLP_REMOTE_EJS") != "false",
		GeoCountry: os.Getenv("YTDLP_GEO_COUNTRY"),
		ForceIPv4:  cfg.ForceIPv4,
	}, log.With("component", "ytdlp"))

	webFS := web.Dist()
	if dir := os.Getenv("WEB_DIR"); dir != "" { // dev: serve a live web/dist instead of the embedded copy
		webFS = os.DirFS(dir)
	}
	srv, err := server.New(cfg, database, yt, webFS, log)
	if err != nil {
		return err
	}
	srv.SetLogBuffer(logBuf)
	if err := srv.EnsureAdmin(); err != nil {
		return err
	}
	if cfg.Local() {
		key, err := localVaultKey()
		if err != nil {
			return err
		}
		srv.SetVaultKey(key) // songs are stored encrypted
		srv.LoadLocalMusicDir()
	}
	if !cfg.MailConfigured() {
		log.Warn("SMTP chưa cấu hình: đăng nhập bằng mã OTP và quên mật khẩu sẽ không dùng được (xem .env.example)")
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	server.SetShutdownHook(stop) // desktop app: POST /__rii/shutdown

	log.Info("RiiMusic", "version", server.Version)
	go yt.Init(ctx)
	srv.Start(ctx)

	handler := srv.Handler()
	if cfg.Local() {
		// Desktop app: Discord presence straight to the Discord client on this computer.
		dp := discordrpc.NewPresence(log.With("component", "discord"))
		defer dp.Close()
		mux := http.NewServeMux()
		mux.Handle("/__rii/discord", dp.Handler())
		mux.Handle("/", handler)
		handler = mux
	}
	hs := &http.Server{
		Addr:              cfg.Addr,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
	errc := make(chan error, 1)
	go func() {
		log.Info("listening", "addr", cfg.Addr, "data", cfg.DataDir)
		errc <- hs.ListenAndServe()
	}()

	select {
	case err := <-errc:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	case <-ctx.Done():
		log.Info("shutting down")
		sctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		hs.Shutdown(sctx)
	}
	return nil
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

// runDiscordAgent: "rii_music discord-agent -server URL -token TOKEN" on the computer
// where Discord desktop runs. Shows what you play on RiiMusic as Discord presence.
// The token comes from RiiMusic → Cài đặt → Trạng thái Discord; the Discord
// Application ID from the server (set by its admin).
func runDiscordAgent(args []string, log *slog.Logger) error {
	fs := flag.NewFlagSet("discord-agent", flag.ExitOnError)
	server := fs.String("server", envOr("RIIMUSIC_SERVER", "http://localhost:8080"), "địa chỉ server RiiMusic")
	token := fs.String("token", os.Getenv("RIIMUSIC_AGENT_TOKEN"), "token agent (Cài đặt → Trạng thái Discord)")
	clientID := fs.String("client-id", os.Getenv("DISCORD_CLIENT_ID"), "Discord Application ID (mặc định lấy từ server)")
	fs.Parse(args)
	if *token == "" {
		return errors.New("thiếu -token (tạo trong RiiMusic → Cài đặt → Trạng thái Discord)")
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	log.Info("discord agent đang chạy", "server", *server)
	a := &discordrpc.Agent{Server: *server, Token: *token, ClientID: *clientID, Log: log}
	return a.Run(ctx)
}

// runMigrate: "rii_music migrate [status|up]". The server also migrates on
// start; this shows where a database stands, or upgrades it ahead of a deploy.
func runMigrate(args []string) error {
	ctx := context.Background()
	d, err := db.Connect(ctx, os.Getenv("DATABASE_URL"))
	if err != nil {
		return err
	}
	defer d.Close()
	cmd := "status"
	if len(args) > 0 {
		cmd = args[0]
	}
	switch cmd {
	case "up":
		done, err := db.Migrate(ctx, d)
		for _, v := range done {
			fmt.Println(fmt.Sprintf("applied %04d", v))
		}
		if err != nil {
			return err
		}
		if len(done) == 0 {
			fmt.Println("up to date")
		}
	case "status":
		st, err := db.MigrationStatus(ctx, d)
		if err != nil {
			return err
		}
		for _, m := range st {
			at := "pending"
			if !m.AppliedAt.IsZero() {
				at = m.AppliedAt.Local().Format("2006-01-02 15:04")
			}
			fmt.Println(fmt.Sprintf("%04d  %-28s %s", m.Version, m.Name, at))
		}
	default:
		return fmt.Errorf("lệnh không rõ %q: dùng status hoặc up", cmd)
	}
	return nil
}

// forceIPv4 makes every outbound HTTP request of the server (YouTube Music,
// LRCLIB, Deezer, the yt-dlp download…) connect over IPv4 only (FORCE_IPV4).
func forceIPv4() {
	t := http.DefaultTransport.(*http.Transport).Clone()
	d := &net.Dialer{Timeout: 30 * time.Second, KeepAlive: 30 * time.Second}
	t.DialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
		switch network {
		case "tcp", "tcp6":
			network = "tcp4"
		}
		return d.DialContext(ctx, network, addr)
	}
	http.DefaultTransport = t
}
