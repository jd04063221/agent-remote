package quota

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/jd04063221/agent-remote/apps/remote-node/internal/protocol"
)

// Fetch queries remaining credit balance ONLY for official metered BYOK API-key providers
// (DeepSeek / OpenRouter).
//
// Account-safety invariant:
// agent-remote NEVER extracts consumer subscription OAuth tokens (such as Antigravity
// `antigravity-oauth-token`, Claude `~/.claude/.credentials.json` / macOS Keychain, or
// Gemini OAuth credentials) and NEVER calls undocumented vendor quota endpoints
// (such as `daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary` or
// `api.anthropic.com/api/oauth/usage`).
func Fetch(ctx context.Context, req protocol.QuotaReqPayload) protocol.QuotaResPayload {
	switch req.Agent {
	case "opencode", "factory-droid":
		return fetchProviderBalance(ctx, req.Agent)
	case "codex":
		return protocol.QuotaResPayload{
			Agent:     req.Agent,
			Available: false,
			Source:    "unavailable",
			Windows:   []protocol.QuotaWindow{},
			Note:      "Codex quota is queried via official `codex app-server` RPC (`account/rateLimits/read`) during active session.",
		}
	case "antigravity":
		return unavailable(
			"antigravity",
			"Direct Antigravity quota probing is disabled to protect your Google account (no OAuth token reading or undocumented CloudCode API calls). Hub only tracks in-session token usage from official `agy acp` events.",
		)
	case "claude":
		return unavailable(
			"claude",
			"Direct Claude OAuth quota probing is disabled to protect your subscription account (no credential/Keychain extraction or undocumented `/api/oauth/usage` calls). Hub tracks in-session token usage and reported cost from official Claude CLI output.",
		)
	default:
		return unavailable(
			req.Agent,
			fmt.Sprintf("Agent %q does not expose a safe official quota API; Hub tracks in-session token usage only.", req.Agent),
		)
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
