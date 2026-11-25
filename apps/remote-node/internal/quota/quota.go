package quota

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/jd04063221/agent-remote/apps/remote-node/internal/protocol"
)

var (
	claudeOAuthUsageURL     = "https://api.anthropic.com/api/oauth/usage"
	readMacKeychainOverride func(ctx context.Context) ([]byte, error)
)

// Fetch queries remaining quota on the remote host using remote-local credentials only.
// Tokens and API keys NEVER leave the remote host — only normalized utilization/balance metrics are returned.
func Fetch(ctx context.Context, req protocol.QuotaReqPayload) protocol.QuotaResPayload {
	switch req.Agent {
	case "claude":
		return fetchClaudeOAuthUsage(ctx)
	case "opencode", "factory-droid":
		return fetchProviderBalance(ctx, req.Agent)
	case "codex":
		return protocol.QuotaResPayload{
			Agent:     req.Agent,
			Available: false,
			Source:    "unavailable",
			Windows:   []protocol.QuotaWindow{},
			Note:      "Codex quota is queried via live `codex app-server` RPC (`account/rateLimits/read`) during active session.",
		}
	case "antigravity":
		return protocol.QuotaResPayload{
			Agent:     req.Agent,
			Available: false,
			Source:    "unavailable",
			Windows:   []protocol.QuotaWindow{},
			Note:      "Antigravity CLI (`agy 1.5.x`) shows exact rolling 5h/weekly quota in interactive `/usage`; non-interactive ACP exposes subscription tier (`_meta.antigravity.tier`) and Hub tracks primary vs. offloaded tokens.",
		}
	default:
		return protocol.QuotaResPayload{
			Agent:     req.Agent,
			Available: false,
			Source:    "unavailable",
			Windows:   []protocol.QuotaWindow{},
			Note:      fmt.Sprintf("Agent %q does not expose a non-interactive remaining quota endpoint; Hub tracks session token usage and 429 reset notices.", req.Agent),
		}
	}
}

type claudeOAuthCreds struct {
	ClaudeAiOauth struct {
		AccessToken      string `json:"accessToken"`
		SubscriptionType string `json:"subscriptionType"`
	} `json:"claudeAiOauth"`
}

func parseClaudeCredentialsPayload(raw []byte) (claudeOAuthCreds, error) {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" {
		return claudeOAuthCreds{}, errors.New("empty credentials payload")
	}
	// macOS `security find-generic-password -w` hex-encodes payloads containing newlines or non-ASCII bytes.
	if !strings.HasPrefix(trimmed, "{") {
		if decoded, err := hex.DecodeString(trimmed); err == nil {
			trimmed = strings.TrimSpace(string(decoded))
		}
	}
	var creds claudeOAuthCreds
	if err := json.Unmarshal([]byte(trimmed), &creds); err != nil {
		return claudeOAuthCreds{}, err
	}
	if strings.TrimSpace(creds.ClaudeAiOauth.AccessToken) == "" {
		return claudeOAuthCreds{}, errors.New("claudeAiOauth.accessToken missing")
	}
	return creds, nil
}

func readClaudeMacOSKeychain(ctx context.Context) ([]byte, error) {
	if readMacKeychainOverride != nil {
		return readMacKeychainOverride(ctx)
	}
	if runtime.GOOS != "darwin" {
		return nil, errors.New("not darwin")
	}
	tctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	// Standard Claude Code macOS Keychain item service name
	out, err := exec.CommandContext(
		tctx,
		"security",
		"find-generic-password",
		"-s",
		"Claude Code-credentials",
		"-w",
	).Output()
	if err != nil {
		return nil, err
	}
	return out, nil
}

func loadClaudeOAuthCredentials(ctx context.Context) (claudeOAuthCreds, error) {
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		credPath := filepath.Join(home, ".claude", ".credentials.json")
		if raw, err := os.ReadFile(credPath); err == nil {
			if creds, err := parseClaudeCredentialsPayload(raw); err == nil {
				return creds, nil
			}
		}
	}

	if raw, err := readClaudeMacOSKeychain(ctx); err == nil {
		return parseClaudeCredentialsPayload(raw)
	}

	if runtime.GOOS == "darwin" {
		return claudeOAuthCreds{}, errors.New("no remote ~/.claude/.credentials.json or macOS Keychain 'Claude Code-credentials' entry found")
	}
	return claudeOAuthCreds{}, errors.New("no remote ~/.claude/.credentials.json found (API-key accounts use per-minute headers instead of subscription pools)")
}

func fetchClaudeOAuthUsage(ctx context.Context) protocol.QuotaResPayload {
	creds, err := loadClaudeOAuthCredentials(ctx)
	if err != nil {
		return unavailable("claude", err.Error())
	}

	tctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	httpReq, err := http.NewRequestWithContext(tctx, http.MethodGet, claudeOAuthUsageURL, nil)
	if err != nil {
		return unavailable("claude", err.Error())
	}
	httpReq.Header.Set("Authorization", "Bearer "+creds.ClaudeAiOauth.AccessToken)
	httpReq.Header.Set("anthropic-beta", "oauth-2025-04-20")

	resp, err := (&http.Client{Timeout: 8 * time.Second}).Do(httpReq)
	if err != nil {
		return unavailable("claude", "failed querying Anthropic OAuth usage: "+err.Error())
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return unavailable("claude", fmt.Sprintf("Anthropic OAuth usage returned HTTP %d", resp.StatusCode))
	}

	var body struct {
		FiveHour *struct {
			Utilization float64 `json:"utilization"`
			ResetsAt    string  `json:"resets_at"`
		} `json:"five_hour"`
		SevenDay *struct {
			Utilization float64 `json:"utilization"`
			ResetsAt    string  `json:"resets_at"`
		} `json:"seven_day"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return unavailable("claude", "invalid OAuth usage payload")
	}

	windows := make([]protocol.QuotaWindow, 0, 2)
	if body.FiveHour != nil {
		used := clampPct(body.FiveHour.Utilization)
		rem := clampPct(100 - used)
		windows = append(windows, protocol.QuotaWindow{
			Label:            "5-Hour Window",
			UsedPercent:      &used,
			RemainingPercent: &rem,
			ResetsAt:         body.FiveHour.ResetsAt,
		})
	}
	if body.SevenDay != nil {
		used := clampPct(body.SevenDay.Utilization)
		rem := clampPct(100 - used)
		windows = append(windows, protocol.QuotaWindow{
			Label:            "Weekly Cap",
			UsedPercent:      &used,
			RemainingPercent: &rem,
			ResetsAt:         body.SevenDay.ResetsAt,
		})
	}

	return protocol.QuotaResPayload{
		Agent:     "claude",
		Available: len(windows) > 0,
		Source:    "oauth-api",
		PlanTier:  creds.ClaudeAiOauth.SubscriptionType,
		Windows:   windows,
	}
}

func fetchProviderBalance(ctx context.Context, agent string) protocol.QuotaResPayload {
	windows := make([]protocol.QuotaWindow, 0, 2)

	if dsKey := strings.TrimSpace(os.Getenv("DEEPSEEK_API_KEY")); dsKey != "" {
		if w, ok := queryDeepSeekBalance(ctx, dsKey); ok {
			windows = append(windows, w)
		}
	}
	if orKey := strings.TrimSpace(os.Getenv("OPENROUTER_API_KEY")); orKey != "" {
		if w, ok := queryOpenRouterCredits(ctx, orKey); ok {
			windows = append(windows, w)
		}
	}

	if len(windows) == 0 {
		return unavailable(agent, "Set DEEPSEEK_API_KEY or OPENROUTER_API_KEY on remote host to display live BYOK credit balance.")
	}
	return protocol.QuotaResPayload{
		Agent:     agent,
		Available: true,
		Source:    "provider-balance",
		Windows:   windows,
	}
}

func queryDeepSeekBalance(ctx context.Context, apiKey string) (protocol.QuotaWindow, bool) {
	tctx, cancel := context.WithTimeout(ctx, 6*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(tctx, http.MethodGet, "https://api.deepseek.com/user/balance", nil)
	if err != nil {
		return protocol.QuotaWindow{}, false
	}
	req.Header.Set("Authorization", "Bearer "+apiKey)
	resp, err := (&http.Client{Timeout: 6 * time.Second}).Do(req)
	if err != nil || resp.StatusCode != http.StatusOK {
		if resp != nil {
			resp.Body.Close()
		}
		return protocol.QuotaWindow{}, false
	}
	defer resp.Body.Close()

	var body struct {
		BalanceInfos []struct {
			Currency     string `json:"currency"`
			TotalBalance string `json:"total_balance"`
		} `json:"balance_infos"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil || len(body.BalanceInfos) == 0 {
		return protocol.QuotaWindow{}, false
	}
	info := body.BalanceInfos[0]
	return protocol.QuotaWindow{
		Label:           "DeepSeek Balance",
		RemainingAmount: fmt.Sprintf("%s %s", info.TotalBalance, info.Currency),
	}, true
}

func queryOpenRouterCredits(ctx context.Context, apiKey string) (protocol.QuotaWindow, bool) {
	tctx, cancel := context.WithTimeout(ctx, 6*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(tctx, http.MethodGet, "https://openrouter.ai/api/v1/credits", nil)
	if err != nil {
		return protocol.QuotaWindow{}, false
	}
	req.Header.Set("Authorization", "Bearer "+apiKey)
	resp, err := (&http.Client{Timeout: 6 * time.Second}).Do(req)
	if err != nil || resp.StatusCode != http.StatusOK {
		if resp != nil {
			resp.Body.Close()
		}
		return protocol.QuotaWindow{}, false
	}
	defer resp.Body.Close()

	var body struct {
		Data struct {
			TotalCredits float64 `json:"total_credits"`
			TotalUsage   float64 `json:"total_usage"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return protocol.QuotaWindow{}, false
	}
	rem := body.Data.TotalCredits - body.Data.TotalUsage
	if rem < 0 {
		rem = 0
	}
	return protocol.QuotaWindow{
		Label:           "OpenRouter Credits",
		RemainingAmount: fmt.Sprintf("$%.2f USD", rem),
	}, true
}

func unavailable(agent, note string) protocol.QuotaResPayload {
	return protocol.QuotaResPayload{
		Agent:     agent,
		Available: false,
		Source:    "unavailable",
		Windows:   []protocol.QuotaWindow{},
		Note:      note,
	}
}

func clampPct(v float64) float64 {
	if v < 0 {
		return 0
	}
	if v > 100 {
		return 100
	}
	return v
}
