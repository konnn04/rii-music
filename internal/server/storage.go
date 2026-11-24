package server

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"time"

	"rii_music/internal/vault"
)

// Audio files on disk. In the desktop app's local mode they are encrypted
// (internal/vault: chunked AES-256-GCM, seekable) so songs are never stored
// raw; elsewhere they are plain files. Every reader goes through here.

type audioFile interface {
	io.ReadSeeker
	io.Closer
}

// SetVaultKey turns on encryption of new audio files (local mode).
func (s *Server) SetVaultKey(k vault.Key) { s.vaultKey = &k }

// openAudio opens a track's file for reading, decrypting when needed.
func (s *Server) openAudio(rel string) (audioFile, int64, time.Time, error) {
	path := s.cfg.AudioPath(rel)
	st, err := os.Stat(path)
	if err != nil {
		return nil, 0, time.Time{}, err
	}
	if s.vaultKey != nil && vault.IsEncrypted(path) {
		r, err := vault.Open(path, *s.vaultKey)
		if err != nil {
			return nil, 0, time.Time{}, err
		}
		return r, r.Size(), st.ModTime(), nil
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, 0, time.Time{}, err
	}
	return f, st.Size(), st.ModTime(), nil
}

// plainAudio gives tools that need a path (ffmpeg) a plain copy of an
// encrypted file in the temp dir; cleanup removes it. Plain files are used as they are.
func (s *Server) plainAudio(rel string) (string, func(), error) {
	path := s.cfg.AudioPath(rel)
	if s.vaultKey == nil || !vault.IsEncrypted(path) {
		return path, func() {}, nil
	}
	tmp := filepath.Join(s.cfg.TmpDir(), "plain-"+newID()+filepath.Ext(path))
	if err := vault.DecryptFile(path, tmp, *s.vaultKey); err != nil {
		os.Remove(tmp)
		return "", func() {}, err
	}
	return tmp, func() { os.Remove(tmp) }, nil
}

// sealAudio encrypts a freshly written plain file in place (local mode).
func (s *Server) sealAudio(path string) error {
	if s.vaultKey == nil || vault.IsEncrypted(path) {
		return nil
	}
	enc := path + ".vault"
	if err := vault.EncryptFile(path, enc, *s.vaultKey); err != nil {
		os.Remove(enc)
		return err
	}
	return os.Rename(enc, path)
}

func extractFeaturesFile(ctx context.Context, s *Server, rel string, durMs int64) ([]float64, error) {
	path, done, err := s.plainAudio(rel)
	if err != nil {
		return nil, err
	}
	defer done()
	return extractFeatures(ctx, s.cfg.FFmpeg, path, durMs)
}

func measureLoudnessFile(ctx context.Context, s *Server, rel string) (float64, float64) {
	path, done, err := s.plainAudio(rel)
	if err != nil {
		return 0, 0
	}
	defer done()
	return measureLoudness(ctx, s.cfg.FFmpeg, path)
}

// embedLyricsFile writes lyrics into the track's file; an encrypted file is
// decrypted to a temp copy, tagged, then encrypted back in place.
func (s *Server) embedLyricsFile(ctx context.Context, rel, path, text string) (int64, error) {
	if s.vaultKey == nil || !vault.IsEncrypted(path) {
		return embedLyrics(ctx, s.cfg.FFmpeg, path, text)
	}
	plain, done, err := s.plainAudio(rel)
	if err != nil {
		return 0, err
	}
	defer done()
	size, err := embedLyrics(ctx, s.cfg.FFmpeg, plain, text)
	if err != nil {
		return 0, err
	}
	enc := path + ".vault"
	if err := vault.EncryptFile(plain, enc, *s.vaultKey); err != nil {
		os.Remove(enc)
		return 0, err
	}
	return size, os.Rename(enc, path)
}
