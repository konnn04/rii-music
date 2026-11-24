package ffmpegdl

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestAssetFor(t *testing.T) {
	tests := []struct {
		goos        string
		goarch      string
		wantKind    archiveKind
		wantArchive string
		wantFFmpeg  string
		wantFFprobe string
		wantSum     bool
		wantErr     bool
	}{
		{
			goos: "windows", goarch: "amd64",
			wantKind: kindZip, wantArchive: "ffmpeg-master-latest-win64-gpl.zip",
			wantFFmpeg: "ffmpeg.exe", wantFFprobe: "ffprobe.exe", wantSum: true,
		},
		{
			goos: "windows", goarch: "arm64",
			wantKind: kindZip, wantArchive: "ffmpeg-master-latest-winarm64-gpl.zip",
			wantFFmpeg: "ffmpeg.exe", wantFFprobe: "ffprobe.exe", wantSum: true,
		},
		{
			goos: "linux", goarch: "amd64",
			wantKind: kindTarXZ, wantArchive: "ffmpeg-master-latest-linux64-gpl.tar.xz",
			wantFFmpeg: "ffmpeg", wantFFprobe: "ffprobe", wantSum: true,
		},
		{
			goos: "linux", goarch: "arm64",
			wantKind: kindTarXZ, wantArchive: "ffmpeg-master-latest-linuxarm64-gpl.tar.xz",
			wantFFmpeg: "ffmpeg", wantFFprobe: "ffprobe", wantSum: true,
		},
		{
			goos: "darwin", goarch: "amd64",
			wantKind: kindMacOSZips, wantArchive: "",
			wantFFmpeg: "ffmpeg", wantFFprobe: "ffprobe", wantSum: false,
		},
		{
			goos: "darwin", goarch: "arm64",
			wantKind: kindMacOSZips, wantArchive: "",
			wantFFmpeg: "ffmpeg", wantFFprobe: "ffprobe", wantSum: false,
		},
		{goos: "windows", goarch: "386", wantErr: true},
		{goos: "linux", goarch: "386", wantErr: true},
		{goos: "darwin", goarch: "386", wantErr: true},
		{goos: "freebsd", goarch: "amd64", wantErr: true},
	}

	for _, tc := range tests {
		t.Run(tc.goos+"/"+tc.goarch, func(t *testing.T) {
			got, err := assetFor(tc.goos, tc.goarch)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("expected error for %s/%s, got %+v", tc.goos, tc.goarch, got)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got.kind != tc.wantKind {
				t.Errorf("kind = %v, want %v", got.kind, tc.wantKind)
			}
			if got.archiveName != tc.wantArchive {
				t.Errorf("archiveName = %q, want %q", got.archiveName, tc.wantArchive)
			}
			if got.ffmpegName != tc.wantFFmpeg {
				t.Errorf("ffmpegName = %q, want %q", got.ffmpegName, tc.wantFFmpeg)
			}
			if got.ffprobeName != tc.wantFFprobe {
				t.Errorf("ffprobeName = %q, want %q", got.ffprobeName, tc.wantFFprobe)
			}
			if hasSum := got.checksumURL != ""; hasSum != tc.wantSum {
				t.Errorf("hasChecksumURL = %v, want %v", hasSum, tc.wantSum)
			}
			if got.url == "" {
				t.Error("url is empty")
			}
			if tc.wantKind == kindMacOSZips && got.probeURL == "" {
				t.Error("probeURL is empty for macOS")
			}
		})
	}
}

func TestParseChecksum(t *testing.T) {
	hashWin := strings.Repeat("a", 64)
	hashLin := strings.Repeat("B", 64)
	sample := []byte(
		"# comment\r\n" +
			hashWin + "  ffmpeg-master-latest-win64-gpl.zip\r\n" +
			hashLin + "  *ffmpeg-master-latest-linux64-gpl.tar.xz\n" +
			"deadbeef  ffmpeg-broken.zip\n",
	)

	got, err := parseChecksum(sample, "ffmpeg-master-latest-win64-gpl.zip")
	if err != nil {
		t.Fatalf("parseChecksum win64: %v", err)
	}
	if got != hashWin {
		t.Errorf("got %q, want %q", got, hashWin)
	}

	got, err = parseChecksum(sample, "ffmpeg-master-latest-linux64-gpl.tar.xz")
	if err != nil {
		t.Fatalf("parseChecksum linux64: %v", err)
	}
	if got != strings.ToLower(hashLin) {
		t.Errorf("got %q, want %q", got, strings.ToLower(hashLin))
	}

	if _, err := parseChecksum(sample, "ffmpeg-broken.zip"); err == nil {
		t.Error("expected error for short checksum")
	}
	if _, err := parseChecksum(sample, "nonexistent.zip"); err == nil {
		t.Error("expected error for missing filename")
	}
	if _, err := parseChecksum(nil, "ffmpeg-master-latest-win64-gpl.zip"); err == nil {
		t.Error("expected error for empty data")
	}
}

func buildTestZip(t *testing.T, files map[string]string) *zip.Reader {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, content := range files {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatalf("zip create %s: %v", name, err)
		}
		if _, err := w.Write([]byte(content)); err != nil {
			t.Fatalf("zip write %s: %v", name, err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("zip close: %v", err)
	}
	zr, err := zip.NewReader(bytes.NewReader(buf.Bytes()), int64(buf.Len()))
	if err != nil {
		t.Fatalf("zip open: %v", err)
	}
	return zr
}

func TestExtractFromZipReader(t *testing.T) {
	t.Run("btbn layout with prefix", func(t *testing.T) {
		zr := buildTestZip(t, map[string]string{
			"ffmpeg-master/README.txt":      "readme",
			"other/ffmpeg.exe":              "decoy",
			"ffmpeg-master/bin/ffmpeg.exe":  "real-ffmpeg",
			"ffmpeg-master/bin/ffprobe.exe": "real-ffprobe",
		})
		dir := t.TempDir()
		ffDst := filepath.Join(dir, "ffmpeg.exe.tmp")
		fpDst := filepath.Join(dir, "ffprobe.exe.tmp")

		err := extractFromZipReader(zr, map[string]string{
			"ffmpeg.exe":  ffDst,
			"ffprobe.exe": fpDst,
		}, true)
		if err != nil {
			t.Fatalf("extractFromZipReader: %v", err)
		}
		assertFileContent(t, ffDst, "real-ffmpeg")
		assertFileContent(t, fpDst, "real-ffprobe")
	})

	t.Run("direct bin prefix", func(t *testing.T) {
		zr := buildTestZip(t, map[string]string{
			"bin/ffmpeg.exe":  "bin-ffmpeg",
			"bin/ffprobe.exe": "bin-ffprobe",
		})
		dir := t.TempDir()
		ffDst := filepath.Join(dir, "ffmpeg.exe.tmp")
		fpDst := filepath.Join(dir, "ffprobe.exe.tmp")

		err := extractFromZipReader(zr, map[string]string{
			"ffmpeg.exe":  ffDst,
			"ffprobe.exe": fpDst,
		}, true)
		if err != nil {
			t.Fatalf("extractFromZipReader: %v", err)
		}
		assertFileContent(t, ffDst, "bin-ffmpeg")
		assertFileContent(t, fpDst, "bin-ffprobe")
	})

	t.Run("macos single binary zip", func(t *testing.T) {
		zr := buildTestZip(t, map[string]string{
			"ffmpeg": "macos-ffmpeg",
		})
		dir := t.TempDir()
		ffDst := filepath.Join(dir, "ffmpeg.tmp")

		err := extractFromZipReader(zr, map[string]string{"ffmpeg": ffDst}, false)
		if err != nil {
			t.Fatalf("extractFromZipReader macOS: %v", err)
		}
		assertFileContent(t, ffDst, "macos-ffmpeg")
	})

	t.Run("missing binary cleans up partial files", func(t *testing.T) {
		zr := buildTestZip(t, map[string]string{
			"ffmpeg-master/bin/ffmpeg.exe": "only-ffmpeg",
		})
		dir := t.TempDir()
		ffDst := filepath.Join(dir, "ffmpeg.exe.tmp")
		fpDst := filepath.Join(dir, "ffprobe.exe.tmp")

		err := extractFromZipReader(zr, map[string]string{
			"ffmpeg.exe":  ffDst,
			"ffprobe.exe": fpDst,
		}, true)
		if err == nil {
			t.Fatal("expected error when ffprobe.exe is missing")
		}
		if _, statErr := os.Stat(ffDst); !os.IsNotExist(statErr) {
			t.Errorf("expected partial file %s to be removed", ffDst)
		}
	})
}

func buildTestTar(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	if err := tw.WriteHeader(&tar.Header{
		Name:     "ffmpeg-master/bin/",
		Mode:     0o755,
		Typeflag: tar.TypeDir,
	}); err != nil {
		t.Fatalf("tar dir header: %v", err)
	}
	for name, content := range files {
		if err := tw.WriteHeader(&tar.Header{
			Name:     name,
			Mode:     0o755,
			Size:     int64(len(content)),
			Typeflag: tar.TypeReg,
		}); err != nil {
			t.Fatalf("tar header %s: %v", name, err)
		}
		if _, err := tw.Write([]byte(content)); err != nil {
			t.Fatalf("tar write %s: %v", name, err)
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatalf("tar close: %v", err)
	}
	return buf.Bytes()
}

func TestExtractFromTar(t *testing.T) {
	t.Run("extracts ffmpeg and ffprobe", func(t *testing.T) {
		raw := buildTestTar(t, map[string]string{
			"ffmpeg-master/doc/ffmpeg":    "decoy",
			"ffmpeg-master/bin/ffmpeg":    "linux-ffmpeg",
			"ffmpeg-master/bin/ffprobe":   "linux-ffprobe",
			"ffmpeg-master/LICENSE.txt":   "gpl",
		})
		dir := t.TempDir()
		ffDst := filepath.Join(dir, "ffmpeg.tmp")
		fpDst := filepath.Join(dir, "ffprobe.tmp")

		err := extractFromTar(bytes.NewReader(raw), map[string]string{
			"ffmpeg":  ffDst,
			"ffprobe": fpDst,
		}, true)
		if err != nil {
			t.Fatalf("extractFromTar: %v", err)
		}
		assertFileContent(t, ffDst, "linux-ffmpeg")
		assertFileContent(t, fpDst, "linux-ffprobe")
	})

	t.Run("missing binary cleans up partial files", func(t *testing.T) {
		raw := buildTestTar(t, map[string]string{
			"ffmpeg-master/bin/ffmpeg": "only-ffmpeg",
		})
		dir := t.TempDir()
		ffDst := filepath.Join(dir, "ffmpeg.tmp")
		fpDst := filepath.Join(dir, "ffprobe.tmp")

		err := extractFromTar(bytes.NewReader(raw), map[string]string{
			"ffmpeg":  ffDst,
			"ffprobe": fpDst,
		}, true)
		if err == nil {
			t.Fatal("expected error when ffprobe is missing")
		}
		if _, statErr := os.Stat(ffDst); !os.IsNotExist(statErr) {
			t.Errorf("expected partial file %s to be removed", ffDst)
		}
	})
}

func assertFileContent(t *testing.T, path, want string) {
	t.Helper()
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	if string(got) != want {
		t.Errorf("%s content = %q, want %q", path, string(got), want)
	}
}
