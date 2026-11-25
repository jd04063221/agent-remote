//go:build !windows

package server

import (
	"os/exec"
	"syscall"
)

func configureProcGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

func killProcTree(cmd *exec.Cmd) {
	if cmd == nil || cmd.Process == nil {
		return
	}
	// Kill entire process group so sub-shells / wrapped node binaries cannot leak as orphans.
	_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
}
