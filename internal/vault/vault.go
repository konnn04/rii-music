package vault

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"sync"
)

const (
	magic            = "RIIVAULT"
	formatVersion    = 1
	defaultChunkLog2 = 16 // 64 KiB
	minChunkLog2     = 10 // 1 KiB
	maxChunkLog2     = 24 // 16 MiB
	headerSize       = 40
	tagSize          = 16
	nonceSize        = 12
)

// Key is a 256-bit AES key.
type Key [32]byte

// ErrCorrupt is returned when a vault file fails header validation or GCM authentication.
var ErrCorrupt = errors.New("vault: file corrupt or wrong key")

// LoadOrCreateKey reads a 32-byte key file, or creates it (crypto/rand, mode 0600,
// parent dirs created) when missing. A file of the wrong size is an error.
func LoadOrCreateKey(path string) (Key, error) {
	var k Key
	data, err := os.ReadFile(path)
	if err == nil {
		if len(data) != len(k) {
			return Key{}, fmt.Errorf("vault: invalid key file size %d", len(data))
		}
		copy(k[:], data)
		return k, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return Key{}, err
	}

	if dir := filepath.Dir(path); dir != "" && dir != "." {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return Key{}, err
		}
	}
	if _, err := io.ReadFull(rand.Reader, k[:]); err != nil {
		return Key{}, err
	}

	f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		if errors.Is(err, os.ErrExist) {
			data, rerr := os.ReadFile(path)
			if rerr != nil {
				return Key{}, rerr
			}
			if len(data) != len(k) {
				return Key{}, fmt.Errorf("vault: invalid key file size %d", len(data))
			}
			copy(k[:], data)
			return k, nil
		}
		return Key{}, err
	}

	if _, err := f.Write(k[:]); err != nil {
		f.Close()
		os.Remove(path)
		return Key{}, err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		os.Remove(path)
		return Key{}, err
	}
	if err := f.Close(); err != nil {
		os.Remove(path)
		return Key{}, err
	}
	return k, nil
}

// IsEncrypted reports whether the file starts with the vault magic.
func IsEncrypted(path string) bool {
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()

	var buf [len(magic)]byte
	if _, err := io.ReadFull(f, buf[:]); err != nil {
		return false
	}
	return string(buf[:]) == magic
}

// EncryptFile encrypts src into dst (written to dst+".tmp", fsync, then renamed).
func EncryptFile(src, dst string, key Key) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()

	info, err := in.Stat()
	if err != nil {
		return err
	}

	if dir := filepath.Dir(dst); dir != "" && dir != "." {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
	}

	tmp := dst + ".tmp"
	out, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	committed := false
	defer func() {
		if !committed {
			out.Close()
			os.Remove(tmp)
		}
	}()

	if err := Encrypt(out, in, info.Size(), key); err != nil {
		return err
	}
	if err := out.Sync(); err != nil {
		return err
	}
	if err := out.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmp, dst); err != nil {
		return err
	}
	committed = true
	return nil
}

// Encrypt writes the vault form of r (exactly size bytes) to w.
func Encrypt(w io.Writer, r io.Reader, size int64, key Key) error {
	if size < 0 {
		return errors.New("vault: negative size")
	}

	chunkSize := int64(1) << defaultChunkLog2
	var numChunks uint64
	if size > 0 {
		numChunks = (uint64(size)-1)/uint64(chunkSize) + 1
		if numChunks > math.MaxUint32+1 {
			return errors.New("vault: file too large")
		}
	}

	block, err := aes.NewCipher(key[:])
	if err != nil {
		return err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return err
	}

	var hdr [headerSize]byte
	copy(hdr[0:8], magic)
	hdr[8] = formatVersion
	hdr[9] = defaultChunkLog2
	// hdr[10:12] reserved (0, 0)
	if _, err := io.ReadFull(rand.Reader, hdr[12:16]); err != nil {
		return err
	}
	binary.BigEndian.PutUint64(hdr[16:24], uint64(size))
	if _, err := io.ReadFull(rand.Reader, hdr[24:40]); err != nil {
		return err
	}

	if _, err := w.Write(hdr[:]); err != nil {
		return err
	}
	if size == 0 {
		return nil
	}

	plainBuf := make([]byte, chunkSize)
	ctBuf := make([]byte, 0, chunkSize+tagSize)

	var nonce [nonceSize]byte
	copy(nonce[0:4], hdr[12:16])

	var aad [headerSize + 5]byte
	copy(aad[0:headerSize], hdr[:])

	for i := uint64(0); i < numChunks; i++ {
		want := chunkSize
		if rem := size - int64(i)*chunkSize; rem < want {
			want = rem
		}
		if _, err := io.ReadFull(r, plainBuf[:want]); err != nil {
			return err
		}

		binary.BigEndian.PutUint64(nonce[4:12], i)
		binary.BigEndian.PutUint32(aad[headerSize:headerSize+4], uint32(i))
		if i == numChunks-1 {
			aad[headerSize+4] = 1
		} else {
			aad[headerSize+4] = 0
		}

		ct := gcm.Seal(ctBuf[:0], nonce[:], plainBuf[:want], aad[:])
		if _, err := w.Write(ct); err != nil {
			return err
		}
	}
	return nil
}

// DecryptFile writes the plain file (e.g. for "save to device" or tools that need a path).
func DecryptFile(src, dst string, key Key) error {
	r, err := Open(src, key)
	if err != nil {
		return err
	}
	defer r.Close()

	if dir := filepath.Dir(dst); dir != "" && dir != "." {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
	}

	tmp := dst + ".tmp"
	out, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	committed := false
	defer func() {
		if !committed {
			out.Close()
			os.Remove(tmp)
		}
	}()

	if _, err := io.Copy(out, r); err != nil {
		return err
	}
	if err := out.Sync(); err != nil {
		return err
	}
	if err := out.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmp, dst); err != nil {
		return err
	}
	committed = true
	return nil
}

// Reader provides seekable, on-demand decrypted access to a vault file.
type Reader struct {
	f         *os.File
	gcm       cipher.AEAD
	hdr       [headerSize]byte
	plainSize int64
	chunkSize int64
	numChunks uint64

	posMu sync.Mutex
	pos   int64

	mu        sync.Mutex
	cachedIdx int64
	plainBuf  []byte
	plainCap  []byte
	ctCap     []byte
}

// Open returns a reader of the plain bytes. It implements io.Reader, io.Seeker,
// io.ReaderAt and io.Closer, decrypts one chunk at a time on demand (keeps the
// last decrypted chunk cached), and is safe for http.ServeContent.
func Open(path string, key Key) (*Reader, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}

	var hdr [headerSize]byte
	if _, err := io.ReadFull(f, hdr[:]); err != nil {
		f.Close()
		if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
			return nil, ErrCorrupt
		}
		return nil, err
	}

	if string(hdr[0:8]) != magic || hdr[8] != formatVersion || hdr[10] != 0 || hdr[11] != 0 {
		f.Close()
		return nil, ErrCorrupt
	}
	chunkLog2 := hdr[9]
	if chunkLog2 < minChunkLog2 || chunkLog2 > maxChunkLog2 {
		f.Close()
		return nil, ErrCorrupt
	}

	plainSizeU64 := binary.BigEndian.Uint64(hdr[16:24])
	if plainSizeU64 > math.MaxInt64 {
		f.Close()
		return nil, ErrCorrupt
	}
	plainSize := int64(plainSizeU64)
	chunkSize := int64(1) << chunkLog2

	var numChunks uint64
	if plainSize > 0 {
		numChunks = (plainSizeU64-1)/uint64(chunkSize) + 1
		if numChunks > math.MaxUint32+1 {
			f.Close()
			return nil, ErrCorrupt
		}
	}

	block, err := aes.NewCipher(key[:])
	if err != nil {
		f.Close()
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		f.Close()
		return nil, err
	}

	return &Reader{
		f:         f,
		gcm:       gcm,
		hdr:       hdr,
		plainSize: plainSize,
		chunkSize: chunkSize,
		numChunks: numChunks,
		cachedIdx: -1,
	}, nil
}

// Size returns the decrypted byte length of the file.
func (r *Reader) Size() int64 {
	return r.plainSize
}

// Read reads decrypted bytes from the current position.
func (r *Reader) Read(p []byte) (int, error) {
	r.posMu.Lock()
	defer r.posMu.Unlock()

	if len(p) == 0 {
		return 0, nil
	}
	if r.pos >= r.plainSize {
		return 0, io.EOF
	}
	n, err := r.ReadAt(p, r.pos)
	r.pos += int64(n)
	return n, err
}

// Seek sets the offset for the next Read.
func (r *Reader) Seek(off int64, whence int) (int64, error) {
	r.posMu.Lock()
	defer r.posMu.Unlock()

	var next int64
	switch whence {
	case io.SeekStart:
		next = off
	case io.SeekCurrent:
		next = r.pos + off
	case io.SeekEnd:
		next = r.plainSize + off
	default:
		return 0, errors.New("vault: invalid whence")
	}
	if next < 0 {
		return 0, errors.New("vault: negative position")
	}
	r.pos = next
	return next, nil
}

// ReadAt reads len(p) decrypted bytes starting at off without changing the Read/Seek position.
func (r *Reader) ReadAt(p []byte, off int64) (int, error) {
	if off < 0 {
		return 0, errors.New("vault: negative offset")
	}
	if len(p) == 0 {
		return 0, nil
	}
	if off >= r.plainSize {
		return 0, io.EOF
	}

	total := 0
	for len(p) > 0 && off < r.plainSize {
		idx := off / r.chunkSize
		inChunk := off % r.chunkSize

		r.mu.Lock()
		chunk, err := r.loadChunkLocked(idx)
		if err != nil {
			r.mu.Unlock()
			return total, err
		}
		n := copy(p, chunk[inChunk:])
		r.mu.Unlock()

		total += n
		p = p[n:]
		off += int64(n)
	}
	if len(p) > 0 {
		return total, io.EOF
	}
	return total, nil
}

func (r *Reader) loadChunkLocked(idx int64) ([]byte, error) {
	if r.cachedIdx == idx {
		return r.plainBuf, nil
	}

	if r.plainCap == nil {
		r.plainCap = make([]byte, r.chunkSize)
		r.ctCap = make([]byte, r.chunkSize+tagSize)
	}

	plainLen := r.chunkSize
	if rem := r.plainSize - idx*r.chunkSize; rem < plainLen {
		plainLen = rem
	}
	ctLen := plainLen + tagSize
	ctOff := int64(headerSize) + idx*(r.chunkSize+tagSize)

	if _, err := r.f.ReadAt(r.ctCap[:ctLen], ctOff); err != nil {
		if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
			return nil, ErrCorrupt
		}
		return nil, err
	}

	var nonce [nonceSize]byte
	copy(nonce[0:4], r.hdr[12:16])
	binary.BigEndian.PutUint64(nonce[4:12], uint64(idx))

	var aad [headerSize + 5]byte
	copy(aad[0:headerSize], r.hdr[:])
	binary.BigEndian.PutUint32(aad[headerSize:headerSize+4], uint32(idx))
	if uint64(idx) == r.numChunks-1 {
		aad[headerSize+4] = 1
	}

	plain, err := r.gcm.Open(r.plainCap[:0], nonce[:], r.ctCap[:ctLen], aad[:])
	if err != nil {
		r.cachedIdx = -1
		return nil, ErrCorrupt
	}

	r.plainBuf = plain
	r.cachedIdx = idx
	return r.plainBuf, nil
}

// Close closes the underlying file.
func (r *Reader) Close() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.f.Close()
}
