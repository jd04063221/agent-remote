package probe

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/jd04063221/agent-remote/apps/remote-node/internal/protocol"
)

type knownAgent struct {
	kind   string
	binary string
}

var defaultAgents = []knownAgent{
	{kind: "antigravity", binary: "agy"},
	{kind: "opencode", binary: "opencode"},
	{kind: "claude", binary: "claude"},
	{kind: "codex", binary: "codex"},
	{kind: "gemini", binary: "gemini"},
	{kind: "kiro", binary: "kiro-cli"},
	{kind: "factory-droid", binary: "droid"},
}

// ExtraSearchPaths returns common CLI installation directories that are often missing
// from minimal systemd / launchd / non-interactive service PATHs (nvm, volta, fnm, pnpm, bun, Homebrew, Snap, Windows npm).
func ExtraSearchPaths() []string {
	var dirs []string
	home, _ := os.UserHomeDir()

	if runtime.GOOS == "windows" {
		if appData := os.Getenv("APPDATA"); appData != "" {
			dirs = append(dirs, filepath.Join(appData, "npm"))
		}
		if localAppData := os.Getenv("LOCALAPPDATA"); localAppData != "" {
			dirs = append(dirs, filepath.Join(localAppData, "pnpm"))
		}
		if progFiles := os.Getenv("ProgramFiles"); progFiles != "" {
			dirs = append(dirs, filepath.Join(progFiles, "nodejs"))
		}
		if home != "" {
			dirs = append(dirs,
				filepath.Join(home, ".volta", "bin"),
				filepath.Join(home, ".bun", "bin"),
				filepath.Join(home, ".local", "bin"),
				filepath.Join(home, ".cargo", "bin"),
			)
		}
		return existingDirs(dirs)
	}

	dirs = append(dirs, "/snap/bin", "/opt/homebrew/bin", "/usr/local/bin")
	if home != "" {
		dirs = append(dirs,
			filepath.Join(home, ".local", "bin"),
			filepath.Join(home, "bin"),
			filepath.Join(home, ".volta", "bin"),
			filepath.Join(home, ".bun", "bin"),
			filepath.Join(home, ".cargo", "bin"),
			filepath.Join(home, ".local", "share", "pnpm"),
			filepath.Join(home, "Library", "pnpm"),
			filepath.Join(home, ".npm-global", "bin"),
		)
		// Discover newest Node version installed by nvm or fnm (descending lexical order)
		for _, pattern := range []string{
			filepath.Join(home, ".nvm", "versions", "node", "*", "bin"),
			filepath.Join(home, ".fnm", "node-versions", "*", "installation", "bin"),
			filepath.Join(home, ".local", "share", "fnm", "node-versions", "*", "installation", "bin"),
		} {
			matches, _ := filepath.Glob(pattern)
			sort.Sort(sort.Reverse(sort.StringSlice(matches)))
			dirs = append(dirs, matches...)
		}
	}
	return existingDirs(dirs)
}

func existingDirs(candidates []string) []string {
	seen := make(map[string]struct{}, len(candidates))
	out := make([]string, 0, len(candidates))
	for _, d := range candidates {
		if d == "" {
			continue
		}
		if _, dup := seen[d]; dup {
			continue
		}
		if info, err := os.Stat(d); err == nil && info.IsDir() {
			seen[d] = struct{}{}
			out = append(out, d)
		}
	}
	return out
}

// AugmentedPath appends discovered ExtraSearchPaths onto an existing PATH without duplicates.
func AugmentedPath(currentPath string) string {
	sep := string(os.PathListSeparator)
	parts := strings.Split(currentPath, sep)
	seen := make(map[string]struct{}, len(parts))
	out := make([]string, 0, len(parts)+8)
	for _, p := range parts {
		if p == "" {
			continue
		}
		if _, ok := seen[p]; !ok {
			seen[p] = struct{}{}
			out = append(out, p)
		}
	}
	for _, extra := range ExtraSearchPaths() {
		if _, ok := seen[extra]; !ok {
			seen[extra] = struct{}{}
			out = append(out, extra)
		}
	}
	return strings.Join(out, sep)
}

// ResolveBinary locates a CLI binary via PATH and ExtraSearchPaths.
// On Windows, also checks .exe, .cmd, .bat, and .ps1 extensions when no extension is specified.
func ResolveBinary(bin string) (string, error) {
	if p, err := exec.LookPath(bin); err == nil {
		return p, nil
	}
	if strings.ContainsAny(bin, `/\`) {
		return "", exec.ErrNotFound
	}
	names := []string{bin}
	if runtime.GOOS == "windows" && filepath.Ext(bin) == "" {
		names = []string{bin + ".exe", bin + ".cmd", bin + ".bat", bin + ".ps1", bin}
	}
	for _, dir := range ExtraSearchPaths() {
		for _, name := range names {
			full := filepath.Join(dir, name)
			if info, err := os.Stat(full); err == nil && !info.IsDir() {
				return full, nil
			}
		}
	}
	return "", exec.ErrNotFound
}

func RunHostProbe(ctx context.Context, activeSessions, maxSessions int) protocol.ProbeResPayload {
	hostname, _ := os.Hostname()
	agents := make([]protocol.AgentProbeItem, len(defaultAgents))

	var wg sync.WaitGroup
	for i, ka := range defaultAgents {
		wg.Add(1)
		go func(idx int, k knownAgent) {
			defer wg.Done()
			item := protocol.AgentProbeItem{
				Agent:  k.kind,
				Binary: k.binary,
			}
			if p, err := ResolveBinary(k.binary); err == nil {
				item.Installed = true
				item.BinaryPath = p
				item.Version = readVersion(ctx, p)
			}
			agents[idx] = item
		}(i, ka)
	}
	wg.Wait()

	return protocol.ProbeResPayload{
		Hostname:       hostname,
		OS:             runtime.GOOS,
		Arch:           runtime.GOARCH,
		ActiveSessions: activeSessions,
		MaxSessions:    maxSessions,
		Agents:         agents,
	}
}

func DiscoverCatalog(ctx context.Context, req protocol.CatalogReqPayload) protocol.CatalogResPayload {
	res := protocol.CatalogResPayload{Agent: req.Agent}
	bin := req.Binary
	var args []string

	switch req.Agent {
	case "antigravity":
		if bin == "" {
			bin = "agy"
		}
		args = []string{"models"}
	case "kiro":
		if bin == "" {
			bin = "kiro-cli"
		}
		args = []string{"chat", "--list-models"}
	case "opencode":
		if bin == "" {
			bin = "opencode"
		}
		args = []string{"models"}
	case "factory-droid":
		home, _ := os.UserHomeDir()
		if home != "" {
			if data, err := os.ReadFile(filepath.Join(home, ".factory", "settings.json")); err == nil {
				res.RawOutput = string(data)
				return res
			}
		}
		res.RawOutput = "{}"
		return res
	default:
		res.Error = "CLI catalog probe not implemented for agent " + req.Agent + " (use live session RPC discovery)"
		return res
	}

	tctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()

	if resolved, err := ResolveBinary(bin); err == nil {
		bin = resolved
	}
	cmd := exec.CommandContext(tctx, bin, args...)
	out, err := cmd.CombinedOutput()
	res.RawOutput = string(out)
	if err != nil {
		res.Error = err.Error()
	}
	return res
}

func readVersion(ctx context.Context, binPath string) string {
	tctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	out, err := exec.CommandContext(tctx, binPath, "--version").CombinedOutput()
	if err != nil {
		return ""
	}
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	if len(lines) == 0 {
		return ""
	}
	return strings.TrimSpace(lines[0])
}
