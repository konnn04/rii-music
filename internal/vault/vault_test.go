package vault

import (
	"bytes"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	mrand "math/rand/v2"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

const testChunkSize = 1 << defaultChunkLog2

func randomBytes(t *testing.T, n int) []byte {
	t.Helper()
	b := make([]byte, n)
	if n > 0 {
		if _, err := io.ReadFull(rand.Reader, b); err != nil {
			t.Fatalf("rand.Read: %v", err)
		}
	}
	return b
}

func randomKey(t *testing.T) Key {
	t.Helper()
	var k Key
	if _, err := io.ReadFull(rand.Reader, k[:]); err != nil {
		t.Fatalf("rand.Read key: %v", err)
	}
	return k
}

func TestRoundTripSizes(t *testing.T) {
	sizes := []int{
		0,
		1,
		testChunkSize - 1,
		testChunkSize,
		testChunkSize + 1,
		5*testChunkSize + 7,
	}
	key := randomKey(t)
	dir := t.TempDir()

	for _, sz := range sizes {
		t.Run(fmt.Sprintf("size_%d", sz), func(t *testing.T) {
			plain := randomBytes(t, sz)
			src := filepath.Join(dir, fmt.Sprintf("plain_%d.bin", sz))
			enc := filepath.Join(dir, fmt.Sprintf("enc_%d.vault", sz))
			dec := filepath.Join(dir, fmt.Sprintf("dec_%d.bin", sz))

			if err := os.WriteFile(src, plain, 0o600); err != nil {
				t.Fatalf("write src: %v", err)
			}
			if err := EncryptFile(src, enc, key); err != nil {
				t.Fatalf("EncryptFile: %v", err)
			}

			r, err := Open(enc, key)
			if err != nil {
				t.Fatalf("Open: %v", err)
			}
			defer r.Close()

			if r.Size() != int64(sz) {
				t.Fatalf("Size() = %d, want %d", r.Size(), sz)
			}
			got, err := io.ReadAll(r)
			if err != nil {
				t.Fatalf("ReadAll: %v", err)
			}
			if !bytes.Equal(got, plain) {
				t.Fatalf("ReadAll mismatch for size %d", sz)
			}

			if err := DecryptFile(enc, dec, key); err != nil {
				t.Fatalf("DecryptFile: %v", err)
			}
			decBytes, err := os.ReadFile(dec)
			if err != nil {
				t.Fatalf("read dec: %v", err)
			}
			if !bytes.Equal(decBytes, plain) {
				t.Fatalf("DecryptFile mismatch for size %d", sz)
			}
		})
	}
}

func TestRandomSeeksAndConcurrentReadAt(t *testing.T) {
	const totalSize = 5*testChunkSize + 12345
	plain := randomBytes(t, totalSize)
	key := randomKey(t)
	dir := t.TempDir()

	src := filepath.Join(dir, "plain.bin")
	enc := filepath.Join(dir, "enc.vault")
	if err := os.WriteFile(src, plain, 0o600); err != nil {
		t.Fatalf("write src: %v", err)
	}
	if err := EncryptFile(src, enc, key); err != nil {
		t.Fatalf("EncryptFile: %v", err)
	}

	r, err := Open(enc, key)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer r.Close()

	rng := mrand.New(mrand.NewPCG(42, 99))
	for i := range 200 {
		off := rng.IntN(totalSize)
		maxLen := totalSize - off
		length := rng.IntN(min(maxLen, 2*testChunkSize)) + 1

		// ReadAt
		bufAt := make([]byte, length)
		n, err := r.ReadAt(bufAt, int64(off))
		if err != nil || n != length {
			t.Fatalf("iter %d: ReadAt(off=%d, len=%d) = (%d, %v)", i, off, length, n, err)
		}
		if !bytes.Equal(bufAt, plain[off:off+length]) {
			t.Fatalf("iter %d: ReadAt mismatch at off=%d len=%d", i, off, length)
		}

		// Seek + Read
		pos, err := r.Seek(int64(off), io.SeekStart)
		if err != nil || pos != int64(off) {
			t.Fatalf("iter %d: Seek(%d) = (%d, %v)", i, off, pos, err)
		}
		bufSeq := make([]byte, length)
		if _, err := io.ReadFull(r, bufSeq); err != nil {
			t.Fatalf("iter %d: ReadFull(off=%d, len=%d): %v", i, off, length, err)
		}
		if !bytes.Equal(bufSeq, plain[off:off+length]) {
			t.Fatalf("iter %d: Seek+Read mismatch at off=%d len=%d", i, off, length)
		}
	}

	// Verify ReadAt does not change Seek/Read position and is safe concurrently.
	if _, err := r.Seek(100, io.SeekStart); err != nil {
		t.Fatalf("Seek(100): %v", err)
	}
	var wg sync.WaitGroup
	errCh := make(chan error, 16)
	for g := range 16 {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()
			off := int64((id * 17321) % (totalSize - 1024))
			buf := make([]byte, 1024)
			if _, err := r.ReadAt(buf, off); err != nil {
				errCh <- err
				return
			}
			if !bytes.Equal(buf, plain[off:off+1024]) {
				errCh <- fmt.Errorf("goroutine %d mismatch", id)
			}
		}(g)
	}
	wg.Wait()
	close(errCh)
	for err := range errCh {
		t.Fatalf("concurrent ReadAt: %v", err)
	}

	cur, err := r.Seek(0, io.SeekCurrent)
	if err != nil || cur != 100 {
		t.Fatalf("position after ReadAt = (%d, %v), want (100, nil)", cur, err)
	}
}

func TestHTTPServeContentRange(t *testing.T) {
	const totalSize = 2*testChunkSize + 5000
	plain := randomBytes(t, totalSize)
	key := randomKey(t)
	dir := t.TempDir()

	src := filepath.Join(dir, "track.m4a")
	enc := filepath.Join(dir, "track.vault")
	if err := os.WriteFile(src, plain, 0o600); err != nil {
		t.Fatalf("write src: %v", err)
	}
	if err := EncryptFile(src, enc, key); err != nil {
		t.Fatalf("EncryptFile: %v", err)
	}

	r, err := Open(enc, key)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer r.Close()

	req := httptest.NewRequest(http.MethodGet, "/track.m4a", nil)
	req.Header.Set("Range", "bytes=70000-70099")
	rec := httptest.NewRecorder()

	http.ServeContent(rec, req, "track.m4a", time.Unix(1700000000, 0), r)

	if rec.Code != http.StatusPartialContent {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusPartialContent)
	}
	want := plain[70000:70100]
	if !bytes.Equal(rec.Body.Bytes(), want) {
		t.Fatalf("body mismatch: got %d bytes, want %d bytes", rec.Body.Len(), len(want))
	}
}

func TestTampering(t *testing.T) {
	const totalSize = 3*testChunkSize + 100
	plain := randomBytes(t, totalSize)
	key := randomKey(t)
	wrongKey := randomKey(t)
	dir := t.TempDir()

	src := filepath.Join(dir, "plain.bin")
	orig := filepath.Join(dir, "orig.vault")
	if err := os.WriteFile(src, plain, 0o600); err != nil {
		t.Fatalf("write src: %v", err)
	}
	if err := EncryptFile(src, orig, key); err != nil {
		t.Fatalf("EncryptFile: %v", err)
	}
	origBytes, err := os.ReadFile(orig)
	if err != nil {
		t.Fatalf("read orig: %v", err)
	}

	t.Run("flip_byte_in_chunk", func(t *testing.T) {
		p := filepath.Join(dir, "flipped.vault")
		b := append([]byte(nil), origBytes...)
		// Flip a byte inside chunk 1.
		chunk1Off := headerSize + (testChunkSize + tagSize) + 100
		b[chunk1Off] ^= 0xFF
		if err := os.WriteFile(p, b, 0o600); err != nil {
			t.Fatalf("write: %v", err)
		}

		r, err := Open(p, key)
		if err != nil {
			t.Fatalf("Open: %v", err)
		}
		defer r.Close()

		// Chunk 0 should still read cleanly.
		buf := make([]byte, 32)
		if _, err := r.ReadAt(buf, 0); err != nil {
			t.Fatalf("chunk 0 ReadAt: %v", err)
		}
		// Chunk 1 must fail with ErrCorrupt.
		_, err = r.ReadAt(buf, testChunkSize+50)
		if !errors.Is(err, ErrCorrupt) {
			t.Fatalf("chunk 1 ReadAt err = %v, want ErrCorrupt", err)
		}
	})

	t.Run("truncate_one_chunk", func(t *testing.T) {
		p := filepath.Join(dir, "truncated.vault")
		// Drop the last chunk (100 + 16 bytes) and one full chunk.
		trunc := origBytes[:len(origBytes)-(testChunkSize+tagSize)]
		if err := os.WriteFile(p, trunc, 0o600); err != nil {
			t.Fatalf("write: %v", err)
		}

		r, err := Open(p, key)
		if err == nil {
			defer r.Close()
			_, err = io.ReadAll(r)
		}
		if err == nil {
			t.Fatalf("expected error on truncated file, got nil")
		}
	})

	t.Run("wrong_key", func(t *testing.T) {
		r, err := Open(orig, wrongKey)
		if err != nil {
			t.Fatalf("Open: %v", err)
		}
		defer r.Close()

		buf := make([]byte, 16)
		_, err = r.Read(buf)
		if !errors.Is(err, ErrCorrupt) {
			t.Fatalf("wrong key Read err = %v, want ErrCorrupt", err)
		}
	})

	t.Run("swap_two_chunks", func(t *testing.T) {
		p := filepath.Join(dir, "swapped.vault")
		b := append([]byte(nil), origBytes...)
		ctChunkLen := testChunkSize + tagSize
		c0Start := headerSize
		c1Start := headerSize + ctChunkLen
		tmp := append([]byte(nil), b[c0Start:c0Start+ctChunkLen]...)
		copy(b[c0Start:c0Start+ctChunkLen], b[c1Start:c1Start+ctChunkLen])
		copy(b[c1Start:c1Start+ctChunkLen], tmp)
		if err := os.WriteFile(p, b, 0o600); err != nil {
			t.Fatalf("write: %v", err)
		}

		r, err := Open(p, key)
		if err != nil {
			t.Fatalf("Open: %v", err)
		}
		defer r.Close()

		buf := make([]byte, 16)
		_, err = r.ReadAt(buf, 0)
		if !errors.Is(err, ErrCorrupt) {
			t.Fatalf("swapped chunk 0 err = %v, want ErrCorrupt", err)
		}
		_, err = r.ReadAt(buf, testChunkSize)
		if !errors.Is(err, ErrCorrupt) {
			t.Fatalf("swapped chunk 1 err = %v, want ErrCorrupt", err)
		}
	})

	t.Run("bad_header", func(t *testing.T) {
		p := filepath.Join(dir, "bad_magic.vault")
		b := append([]byte(nil), origBytes...)
		b[0] = 'X'
		if err := os.WriteFile(p, b, 0o600); err != nil {
			t.Fatalf("write: %v", err)
		}
		if _, err := Open(p, key); !errors.Is(err, ErrCorrupt) {
			t.Fatalf("bad magic Open err = %v, want ErrCorrupt", err)
		}

		pv := filepath.Join(dir, "bad_version.vault")
		bv := append([]byte(nil), origBytes...)
		bv[8] = 2
		if err := os.WriteFile(pv, bv, 0o600); err != nil {
			t.Fatalf("write: %v", err)
		}
		if _, err := Open(pv, key); !errors.Is(err, ErrCorrupt) {
			t.Fatalf("bad version Open err = %v, want ErrCorrupt", err)
		}
	})
}

func TestIsEncryptedAndLoadOrCreateKey(t *testing.T) {
	dir := t.TempDir()

	keyPath := filepath.Join(dir, "nested", "dir", "vault.key")
	k1, err := LoadOrCreateKey(keyPath)
	if err != nil {
		t.Fatalf("LoadOrCreateKey create: %v", err)
	}
	k2, err := LoadOrCreateKey(keyPath)
	if err != nil {
		t.Fatalf("LoadOrCreateKey reload: %v", err)
	}
	if k1 != k2 {
		t.Fatalf("reloaded key does not match created key")
	}

	badKeyPath := filepath.Join(dir, "bad.key")
	if err := os.WriteFile(badKeyPath, []byte("too short"), 0o600); err != nil {
		t.Fatalf("write bad key: %v", err)
	}
	if _, err := LoadOrCreateKey(badKeyPath); err == nil {
		t.Fatalf("expected error for wrong-size key file")
	}

	plainPath := filepath.Join(dir, "plain.bin")
	if err := os.WriteFile(plainPath, []byte("hello plain audio"), 0o600); err != nil {
		t.Fatalf("write plain: %v", err)
	}
	encPath := filepath.Join(dir, "enc.vault")
	if err := EncryptFile(plainPath, encPath, k1); err != nil {
		t.Fatalf("EncryptFile: %v", err)
	}

	if !IsEncrypted(encPath) {
		t.Fatalf("IsEncrypted(vault) = false, want true")
	}
	if IsEncrypted(plainPath) {
		t.Fatalf("IsEncrypted(plain) = true, want false")
	}
	if IsEncrypted(filepath.Join(dir, "missing.vault")) {
		t.Fatalf("IsEncrypted(missing) = true, want false")
	}
}
