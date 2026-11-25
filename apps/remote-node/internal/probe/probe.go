package probe

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
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

// ResolveBinary locates a CLI binary via PATH and common fallback locations
// (such as /snap/bin on Ubuntu and /opt/homebrew/bin on macOS when running under systemd/launchd).
func ResolveBinary(bin string) (string, error) {
	if p, err := exec.LookPath(bin); err == nil {
		return p, nil
	}
	if strings.ContainsAny(bin, `/\`) {
		return "", exec.ErrNotFound
	}
	candidates := []string{
		"/snap/bin",
		"/opt/homebrew/bin",
		"/usr/local/bin",
	}
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		candidates = append(candidates,
			filepath.Join(home, ".local", "bin"),
			filepath.Join(home, "bin"),
		)
	}
	for _, dir := range candidates {
		full := filepath.Join(dir, bin)
		if info, err := os.Stat(full); err == nil && !info.IsDir() {
			return full, nil
		}
	}
	return "", exec.ErrNotFound
}

func RunHostProbe(ctx context.Context, activeSessions, maxSessions int) protocol.ProbeResPayload {
	hostname, _ := os.Hostname()
	agents := make([]protocol.AgentProbeItem, 0, len(defaultAgents))

	for _, ka := range defaultAgents {
		item := protocol.AgentProbeItem{
			Agent:  ka.kind,
			Binary: ka.binary,
		}
		if p, err := ResolveBinary(ka.binary); err == nil {
			item.Installed = true
			item.BinaryPath = p
			item.Version = readVersion(ctx, p)
		}
		agents = append(agents, item)
	}

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
