package server

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestResolveWorkBaseDirForSnapAndRegularBinaries(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("Snap workdir auto-detection applies to Linux")
	}

	// 1. Explicit --work-base-dir always wins
	custom := filepath.Join(t.TempDir(), "custom-base")
	got, err := resolveWorkBaseDir(custom, "/snap/bin/agy", "antigravity")
	if err != nil || got != custom {
		t.Fatalf("expected custom dir %q, got %q err=%v", custom, got, err)
	}

	// 2. Regular non-snap binary uses default os.TempDir ("") when not inside a Snap env
	origSnap := os.Getenv("SNAP")
	origSnapCommon := os.Getenv("SNAP_USER_COMMON")
	origHome := os.Getenv("HOME")
	t.Cleanup(func() {
		_ = os.Setenv("SNAP", origSnap)
		_ = os.Setenv("SNAP_USER_COMMON", origSnapCommon)
		_ = os.Setenv("HOME", origHome)
	})
	_ = os.Unsetenv("SNAP")
	_ = os.Unsetenv("SNAP_USER_COMMON")

	gotRegular, err := resolveWorkBaseDir("", "/usr/local/bin/claude", "claude")
	if err != nil || gotRegular != "" {
		t.Fatalf("expected empty (default temp dir) for regular binary, got %q err=%v", gotRegular, err)
	}

	// 3. Snap binary (/snap/bin/agy) switches to $HOME/snap/antigravity-cli/common/ar-sessions when present
	fakeHome := t.TempDir()
	_ = os.Setenv("HOME", fakeHome)
	snapCommon := filepath.Join(fakeHome, "snap", "antigravity-cli", "common")
	if err := os.MkdirAll(snapCommon, 0o700); err != nil {
		t.Fatal(err)
	}

	gotSnap, err := resolveWorkBaseDir("", "/snap/bin/agy", "antigravity")
	wantSnap := filepath.Join(snapCommon, "ar-sessions")
	if err != nil || gotSnap != wantSnap {
		t.Fatalf("expected Snap shared dir %q, got %q err=%v", wantSnap, gotSnap, err)
	}

	// 4. Unknown snap binary falls back to non-hidden $HOME/agent-remote-sessions
	gotOther, err := resolveWorkBaseDir("", "/snap/bin/other-agent", "opencode")
	wantOther := filepath.Join(fakeHome, "agent-remote-sessions")
	if err != nil || gotOther != wantOther {
		t.Fatalf("expected fallback dir %q, got %q err=%v", wantOther, gotOther, err)
	}
}
