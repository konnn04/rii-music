//go:build !windows

package ytdlp

import (
	"os/exec"
	"syscall"
)

// setTree puts the child in its own process group and kills the whole group on cancel.
func setTree(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		if cmd.Process == nil {
			return nil
		}
		return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	}
}
