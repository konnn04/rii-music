package textutil

import (
	"sync"
	"testing"
)

// Fold used to share one transform.Chain and panicked under concurrent use.
func TestFoldConcurrent(t *testing.T) {
	inputs := []string{"Sơn Tùng M-TP", "Ngồi Nghe Em Khóc", "Đạt G", "Emcee L (Da LAB)", "Hẹn Em Mai Sau Gặp Lại"}
	want := []string{"son tung m-tp", "ngoi nghe em khoc", "dat g", "emcee l (da lab)", "hen em mai sau gap lai"}
	var wg sync.WaitGroup
	for g := 0; g < 16; g++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < 500; i++ {
				k := i % len(inputs)
				if got := Fold(inputs[k]); got != want[k] {
					t.Errorf("Fold(%q) = %q, want %q", inputs[k], got, want[k])
					return
				}
			}
		}()
	}
	wg.Wait()
}
