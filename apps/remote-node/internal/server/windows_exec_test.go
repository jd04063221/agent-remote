package server

import (
	"strings"
	"testing"
)

func TestPrepareExecCommandWindowsWrappers(t *testing.T) {
	// 1. .ps1 script gets wrapped with PowerShell
	bin, args := prepareExecCommand("windows", `C:\Users\dev\bin\my-cli.ps1`, []string{"acp", "--stdio"})
	if !strings.Contains(strings.ToLower(bin), "powershell") && !strings.Contains(strings.ToLower(bin), "pwsh") {
		t.Fatalf("expected powershell wrapper for .ps1, got %q", bin)
	}
	if len(args) < 7 || args[4] != "-File" || args[5] != `C:\Users\dev\bin\my-cli.ps1` {
		t.Fatalf("unexpected ps1 args: %#v", args)
	}

	// 2. .cmd shim flattens multiline args so cmd.exe does not truncate --append-system-prompt
	bin2, args2 := prepareExecCommand("windows", `C:\Users\dev\AppData\Roaming\npm\claude.cmd`, []string{
		"--append-system-prompt",
		"line1\nline2\r\nline3",
	})
	if bin2 != `C:\Users\dev\AppData\Roaming\npm\claude.cmd` {
		t.Fatalf("unexpected cmd bin: %q", bin2)
	}
	if strings.ContainsAny(args2[1], "\r\n") {
		t.Fatalf("expected newlines flattened for .cmd arg, got %q", args2[1])
	}
	if args2[1] != "line1 line2 line3" {
		t.Fatalf("unexpected flattened prompt: %q", args2[1])
	}

	// 3. Non-windows passes through untouched
	bin3, args3 := prepareExecCommand("linux", "/usr/bin/claude", []string{"line1\nline2"})
	if bin3 != "/usr/bin/claude" || args3[0] != "line1\nline2" {
		t.Fatalf("linux command should stay untouched: %q %#v", bin3, args3)
	}
}
