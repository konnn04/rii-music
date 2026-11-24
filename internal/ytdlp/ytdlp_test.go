package ytdlp

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestMain(m *testing.M) {
	if v := os.Getenv("RII_FAKE_YTDLP"); v != "" {
		if msStr, ok := strings.CutPrefix(v, "sleep:"); ok {
			ms, err := strconv.Atoi(msStr)
			if err != nil {
				fmt.Fprintln(os.Stderr, "invalid RII_FAKE_YTDLP:", v)
				os.Exit(2)
			}
			time.Sleep(time.Duration(ms) * time.Millisecond)
			fmt.Println("ok")
			os.Exit(0)
		}
	}
	os.Exit(m.Run())
}

func newFakeClient(t *testing.T, maxProcs int) *Client {
	t.Helper()
	t.Setenv("RII_FAKE_YTDLP", "sleep:0")
	c := New(Config{
		Path:     os.Args[0],
		MaxProcs: maxProcs,
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	c.Init(context.Background())
	ready, err := c.Status()
	if !ready || err != nil {
		t.Fatalf("Init failed: ready=%v err=%v", ready, err)
	}
	return c
}

func TestSemaphore(t *testing.T) {
	c := newFakeClient(t, 2)
	t.Setenv("RII_FAKE_YTDLP", "sleep:300")

	var cur, maxSeen atomic.Int32
	c.onProc = func(d int32) {
		n := cur.Add(d)
		for {
			m := maxSeen.Load()
			if n <= m || maxSeen.CompareAndSwap(m, n) {
				break
			}
		}
	}

	const total = 5
	start := time.Now()
	var wg sync.WaitGroup
	errs := make([]error, total)
	for i := 0; i < total; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			out, err := c.Run(context.Background(), []string{"--dummy"}, nil)
			if err != nil {
				errs[idx] = err
				return
			}
			if strings.TrimSpace(out) != "ok" {
				errs[idx] = fmt.Errorf("unexpected output %q", out)
			}
		}(i)
	}
	wg.Wait()
	elapsed := time.Since(start)

	for i, err := range errs {
		if err != nil {
			t.Fatalf("run %d failed: %v", i, err)
		}
	}
	if elapsed < 750*time.Millisecond {
		t.Fatalf("5 runs with MaxProcs=2 (300ms each) finished too fast: %v (< 750ms)", elapsed)
	}
	if peak := maxSeen.Load(); peak > 2 {
		t.Fatalf("peak concurrent procs = %d, want <= 2", peak)
	}
}

func TestCancel(t *testing.T) {
	c := newFakeClient(t, 2)
	t.Setenv("RII_FAKE_YTDLP", "sleep:30000")

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	timer := time.AfterFunc(200*time.Millisecond, cancel)
	defer timer.Stop()

	start := time.Now()
	_, err := c.Run(ctx, []string{"--dummy"}, nil)
	elapsed := time.Since(start)

	if !errors.Is(err, context.Canceled) {
		t.Fatalf("expected context.Canceled, got %v", err)
	}
	if elapsed > 6*time.Second {
		t.Fatalf("Run took %v after cancel, want <= 6s", elapsed)
	}
}

func TestFlatTimeout(t *testing.T) {
	c := newFakeClient(t, 2)
	prev := flatTimeout
	flatTimeout = 200 * time.Millisecond
	t.Cleanup(func() { flatTimeout = prev })

	t.Setenv("RII_FAKE_YTDLP", "sleep:30000")

	// Parent without deadline should hit flatTimeout and return *Error.
	_, err := c.Flat(context.Background(), "ytsearch1:test")
	var ye *Error
	if !errors.As(err, &ye) || ye.Code != -1 || ye.Reason != "quá thời gian chờ (2 phút)" {
		t.Fatalf("expected timeout *Error, got %T: %v", err, err)
	}

	// Parent cancelled before flatTimeout should return parent's error.
	flatTimeout = 5 * time.Second
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	timer := time.AfterFunc(150*time.Millisecond, cancel)
	defer timer.Stop()

	_, err = c.Flat(ctx, "ytsearch1:test")
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("expected context.Canceled, got %v", err)
	}
}
