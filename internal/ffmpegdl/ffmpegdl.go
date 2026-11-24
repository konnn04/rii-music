// Package ffmpegdl downloads a static ffmpeg + ffprobe build on first use
// when ffmpeg is not already available on PATH.
package ffmpegdl

import (
	"archive/tar"
	"archive/zip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/xi2/xz"
)

const (
	btbnBase         = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/"
	evermeetFFmpeg   = "https://evermeet.cx/ffmpeg/getrelease/ffmpeg/zip"
	evermeetFFprobe  = "https://evermeet.cx/ffmpeg/getrelease/ffprobe/zip"
	downloadTimeout  = 20 * time.Minute
	verifyTimeout    = 10 * time.Second
	maxChecksumBytes = 4 << 20
)

type archiveKind int

const (
	kindZip archiveKind = iota
	kindTarXZ
	kindMacOSZips
)

type assetSpec struct {
	kind        archiveKind
	archiveName string // filename in checksums.sha256 (empty on macOS)
	url         string // primary archive URL
	probeURL    string // ffprobe archive URL (macOS only)
	checksumURL string // checksums.sha256 URL (empty on macOS)
	ffmpegName  string // "ffmpeg.exe" or "ffmpeg"
	ffprobeName string // "ffprobe.exe" or "ffprobe"
}

var mu sync.Mutex

// Ensure returns the path of an ffmpeg binary: "ffmpeg" on PATH if present,
// else <binDir>/ffmpeg[.exe] if already downloaded, else it downloads and
// extracts ffmpeg (and ffprobe) into binDir. progress (may be nil) receives
// human-readable status updates.
func Ensure(ctx context.Context, binDir string, progress func(string)) (string, error) {
	if p, err := exec.LookPath("ffmpeg"); err == nil {
		return absPath(p), nil
	}
	if binDir == "" {
		return "", errors.New("binDir is empty")
	}

	spec, err := assetFor(runtime.GOOS, runtime.GOARCH)
	if err != nil {
		return "", err
	}

	mu.Lock()
	defer mu.Unlock()

	ffmpegPath := filepath.Join(binDir, spec.ffmpegName)
	if st, err := os.Stat(ffmpegPath); err == nil && !st.IsDir() {
		return absPath(ffmpegPath), nil
	}

	if err := os.MkdirAll(binDir, 0o755); err != nil {
		return "", fmt.Errorf("create bin dir: %w", err)
	}

	hc := &http.Client{Timeout: downloadTimeout}
	ffprobePath := filepath.Join(binDir, spec.ffprobeName)
	ffmpegTmp := ffmpegPath + ".tmp"
	ffprobeTmp := ffprobePath + ".tmp"
	defer os.Remove(ffmpegTmp)
	defer os.Remove(ffprobeTmp)

	switch spec.kind {
	case kindZip, kindTarXZ:
		if err := downloadAndExtractBtbN(ctx, hc, binDir, spec, ffmpegTmp, ffprobeTmp, progress); err != nil {
			return "", err
		}
	case kindMacOSZips:
		if err := downloadAndExtractMacOS(ctx, hc, binDir, spec, ffmpegTmp, ffprobeTmp, progress); err != nil {
			return "", err
		}
	default:
		return "", fmt.Errorf("unsupported archive kind: %d", spec.kind)
	}

	if err := os.Rename(ffmpegTmp, ffmpegPath); err != nil {
		return "", fmt.Errorf("install %s: %w", spec.ffmpegName, err)
	}
	if err := os.Rename(ffprobeTmp, ffprobePath); err != nil {
		os.Remove(ffmpegPath)
		return "", fmt.Errorf("install %s: %w", spec.ffprobeName, err)
	}

	if err := verifyBinary(ctx, ffmpegPath); err != nil {
		os.Remove(ffmpegPath)
		os.Remove(ffprobePath)
		return "", fmt.Errorf("verify ffmpeg: %w", err)
	}

	// RiiMusic never runs ffprobe (yt-dlp only needs it for post-processing we
	// don't use): drop it, it is as large as ffmpeg itself.
	os.Remove(ffprobePath)

	return absPath(ffmpegPath), nil
}

func assetFor(goos, goarch string) (assetSpec, error) {
	switch goos {
	case "windows":
		var archive string
		switch goarch {
		case "amd64":
			archive = "ffmpeg-master-latest-win64-gpl.zip"
		case "arm64":
			archive = "ffmpeg-master-latest-winarm64-gpl.zip"
		default:
			return assetSpec{}, fmt.Errorf("unsupported platform: %s/%s", goos, goarch)
		}
		return assetSpec{
			kind:        kindZip,
			archiveName: archive,
			url:         btbnBase + archive,
			checksumURL: btbnBase + "checksums.sha256",
			ffmpegName:  "ffmpeg.exe",
			ffprobeName: "ffprobe.exe",
		}, nil

	case "linux":
		var archive string
		switch goarch {
		case "amd64":
			archive = "ffmpeg-master-latest-linux64-gpl.tar.xz"
		case "arm64":
			archive = "ffmpeg-master-latest-linuxarm64-gpl.tar.xz"
		default:
			return assetSpec{}, fmt.Errorf("unsupported platform: %s/%s", goos, goarch)
		}
		return assetSpec{
			kind:        kindTarXZ,
			archiveName: archive,
			url:         btbnBase + archive,
			checksumURL: btbnBase + "checksums.sha256",
			ffmpegName:  "ffmpeg",
			ffprobeName: "ffprobe",
		}, nil

	case "darwin":
		switch goarch {
		case "amd64", "arm64":
			return assetSpec{
				kind:        kindMacOSZips,
				url:         evermeetFFmpeg,
				probeURL:    evermeetFFprobe,
				ffmpegName:  "ffmpeg",
				ffprobeName: "ffprobe",
			}, nil
		default:
			return assetSpec{}, fmt.Errorf("unsupported platform: %s/%s", goos, goarch)
		}

	default:
		return assetSpec{}, fmt.Errorf("unsupported platform: %s/%s", goos, goarch)
	}
}

func downloadAndExtractBtbN(
	ctx context.Context,
	hc *http.Client,
	binDir string,
	spec assetSpec,
	ffmpegTmp, ffprobeTmp string,
	progress func(string),
) error {
	sumsData, err := fetchBytes(ctx, hc, spec.checksumURL)
	if err != nil {
		return fmt.Errorf("fetch checksums: %w", err)
	}
	wantSum, err := parseChecksum(sumsData, spec.archiveName)
	if err != nil {
		return err
	}

	archivePath := filepath.Join(binDir, "ffmpeg-download.tmp")
	defer os.Remove(archivePath)

	gotSum, err := downloadFile(ctx, hc, spec.url, archivePath, "ffmpeg", progress)
	if err != nil {
		return fmt.Errorf("download ffmpeg: %w", err)
	}
	if gotSum != wantSum {
		os.Remove(archivePath)
		return fmt.Errorf("checksum mismatch for %s: want %s got %s", spec.archiveName, wantSum, gotSum)
	}

	report(progress, "Đang giải nén ffmpeg")
	targets := map[string]string{
		spec.ffmpegName:  ffmpegTmp,
		spec.ffprobeName: ffprobeTmp,
	}
	switch spec.kind {
	case kindZip:
		if err := extractZipFile(archivePath, targets, true); err != nil {
			return fmt.Errorf("extract ffmpeg zip: %w", err)
		}
	case kindTarXZ:
		if err := extractTarXZFile(archivePath, targets, true); err != nil {
			return fmt.Errorf("extract ffmpeg tar.xz: %w", err)
		}
	}
	return nil
}

func downloadAndExtractMacOS(
	ctx context.Context,
	hc *http.Client,
	binDir string,
	spec assetSpec,
	ffmpegTmp, ffprobeTmp string,
	progress func(string),
) error {
	ffmpegArchive := filepath.Join(binDir, "ffmpeg-download.tmp")
	defer os.Remove(ffmpegArchive)
	if _, err := downloadFile(ctx, hc, spec.url, ffmpegArchive, "ffmpeg", progress); err != nil {
		return fmt.Errorf("download ffmpeg: %w", err)
	}

	ffprobeArchive := filepath.Join(binDir, "ffprobe-download.tmp")
	defer os.Remove(ffprobeArchive)
	if _, err := downloadFile(ctx, hc, spec.probeURL, ffprobeArchive, "ffprobe", progress); err != nil {
		return fmt.Errorf("download ffprobe: %w", err)
	}

	report(progress, "Đang giải nén ffmpeg")
	if err := extractZipFile(ffmpegArchive, map[string]string{spec.ffmpegName: ffmpegTmp}, false); err != nil {
		return fmt.Errorf("extract ffmpeg zip: %w", err)
	}
	if err := extractZipFile(ffprobeArchive, map[string]string{spec.ffprobeName: ffprobeTmp}, false); err != nil {
		return fmt.Errorf("extract ffprobe zip: %w", err)
	}
	return nil
}

func fetchBytes(ctx context.Context, hc *http.Client, url string) ([]byte, error) {
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
	return io.ReadAll(io.LimitReader(res.Body, maxChecksumBytes))
}

// downloadFile streams url to destPath, returning its hex-encoded SHA-256 digest.
func downloadFile(ctx context.Context, hc *http.Client, url, destPath, label string, progress func(string)) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", "rii-music")
	res, err := hc.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return "", fmt.Errorf("GET %s: %s", url, res.Status)
	}

	f, err := os.OpenFile(destPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return "", err
	}
	ok := false
	defer func() {
		if !ok {
			f.Close()
			os.Remove(destPath)
		}
	}()

	h := sha256.New()
	w := io.MultiWriter(f, h)
	total := res.ContentLength
	var written int64
	lastPct := -2

	if total <= 0 {
		report(progress, "Đang tải "+label)
	}

	buf := make([]byte, 32*1024)
	for {
		n, readErr := res.Body.Read(buf)
		if n > 0 {
			if _, err := w.Write(buf[:n]); err != nil {
				return "", err
			}
			written += int64(n)
			if progress != nil && total > 0 {
				pct := int(written * 100 / total)
				if pct > 100 {
					pct = 100
				}
				if pct-lastPct >= 2 || (pct == 100 && lastPct < 100) {
					lastPct = pct
					progress(fmt.Sprintf("Đang tải %s %d%%", label, pct))
				}
			}
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			return "", readErr
		}
	}

	if err := f.Close(); err != nil {
		return "", err
	}
	ok = true
	return hex.EncodeToString(h.Sum(nil)), nil
}

// parseChecksum finds the lowercase SHA-256 hex digest for filename in a
// sha256sum-formatted file.
func parseChecksum(data []byte, filename string) (string, error) {
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		name := strings.TrimPrefix(fields[1], "*")
		name = strings.TrimPrefix(name, "./")
		if name != filename {
			continue
		}
		sum := strings.ToLower(fields[0])
		if len(sum) != 64 {
			return "", fmt.Errorf("invalid checksum length for %s", filename)
		}
		if _, err := hex.DecodeString(sum); err != nil {
			return "", fmt.Errorf("invalid checksum hex for %s: %w", filename, err)
		}
		return sum, nil
	}
	return "", fmt.Errorf("checksum not found for %s", filename)
}

func extractZipFile(zipPath string, targets map[string]string, requireBinDir bool) error {
	r, err := zip.OpenReader(zipPath)
	if err != nil {
		return err
	}
	defer r.Close()
	return extractFromZipReader(&r.Reader, targets, requireBinDir)
}

func extractFromZipReader(zr *zip.Reader, targets map[string]string, requireBinDir bool) error {
	found := make(map[string]bool, len(targets))
	var written []string
	cleanup := func() {
		for _, p := range written {
			os.Remove(p)
		}
	}

	for _, f := range zr.File {
		if f.FileInfo().IsDir() {
			continue
		}
		dst, base, ok := matchEntry(f.Name, targets, requireBinDir)
		if !ok || found[base] {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			cleanup()
			return err
		}
		err = writeStream(dst, rc, 0o755)
		rc.Close()
		if err != nil {
			cleanup()
			return err
		}
		written = append(written, dst)
		found[base] = true
	}

	for name := range targets {
		if !found[name] {
			cleanup()
			return fmt.Errorf("missing %s in zip archive", name)
		}
	}
	return nil
}

func extractTarXZFile(xzPath string, targets map[string]string, requireBinDir bool) error {
	f, err := os.Open(xzPath)
	if err != nil {
		return err
	}
	defer f.Close()

	xr, err := xz.NewReader(f, 0)
	if err != nil {
		return err
	}
	return extractFromTar(xr, targets, requireBinDir)
}

func extractFromTar(r io.Reader, targets map[string]string, requireBinDir bool) error {
	tr := tar.NewReader(r)
	found := make(map[string]bool, len(targets))
	var written []string
	cleanup := func() {
		for _, p := range written {
			os.Remove(p)
		}
	}

	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			cleanup()
			return err
		}
		if hdr.Typeflag != tar.TypeReg && hdr.Typeflag != tar.TypeRegA {
			continue
		}
		dst, base, ok := matchEntry(hdr.Name, targets, requireBinDir)
		if !ok || found[base] {
			continue
		}
		if err := writeStream(dst, tr, 0o755); err != nil {
			cleanup()
			return err
		}
		written = append(written, dst)
		found[base] = true
	}

	for name := range targets {
		if !found[name] {
			cleanup()
			return fmt.Errorf("missing %s in tar archive", name)
		}
	}
	return nil
}

func matchEntry(entryPath string, targets map[string]string, requireBinDir bool) (dst, base string, ok bool) {
	p := path.Clean(strings.ReplaceAll(entryPath, "\\", "/"))
	base = path.Base(p)
	dst, ok = targets[base]
	if !ok {
		return "", "", false
	}
	if requireBinDir {
		dir := path.Dir(p)
		if dir != "bin" && !strings.HasSuffix(dir, "/bin") {
			return "", "", false
		}
	}
	return dst, base, true
}

func writeStream(dst string, r io.Reader, mode os.FileMode) error {
	f, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(f, r)
	closeErr := f.Close()
	if copyErr != nil {
		os.Remove(dst)
		return copyErr
	}
	if closeErr != nil {
		os.Remove(dst)
		return closeErr
	}
	// Ensure executable permission regardless of process umask on Unix.
	if err := os.Chmod(dst, mode); err != nil {
		os.Remove(dst)
		return err
	}
	return nil
}

func verifyBinary(ctx context.Context, binPath string) error {
	vctx, cancel := context.WithTimeout(ctx, verifyTimeout)
	defer cancel()
	cmd := exec.CommandContext(vctx, binPath, "-version")
	out, err := cmd.CombinedOutput()
	if err != nil {
		msg := strings.TrimSpace(string(out))
		if len(msg) > 200 {
			msg = msg[:200]
		}
		if msg != "" {
			return fmt.Errorf("%w: %s", err, msg)
		}
		return err
	}
	return nil
}

func absPath(p string) string {
	if abs, err := filepath.Abs(p); err == nil {
		return abs
	}
	return p
}

func report(fn func(string), msg string) {
	if fn != nil {
		fn(msg)
	}
}
