//go:build windows

package server

import (
	"os/exec"
	"strconv"
)

func configureProcGroup(_ *exec.Cmd) {
	// Windows process trees are terminated via taskkill /T /F.
}

func killProcTree(cmd *exec.Cmd) {
	if cmd == nil || cmd.Process == nil {
		return
	}
	_ = exec.Command("taskkill", "/PID", strconv.Itoa(cmd.Process.Pid), "/T", "/F").Run()
}
