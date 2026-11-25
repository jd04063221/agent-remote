package quota

import (
	"context"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/jd04063221/agent-remote/apps/remote-node/internal/protocol"
)

func TestFetchClaudeUsageViaMacOSKeychainHexPayload(t *testing.T) {
	// Point HOME to an empty temp dir so ~/.claude/.credentials.json is absent and Keychain fallback triggers
	origHome := os.Getenv("HOME")
	origURL := claudeOAuthUsageURL
	origReader := readMacKeychainOverride
	t.Cleanup(func() {
		_ = os.Setenv("HOME", origHome)
		claudeOAuthUsageURL = origURL
		readMacKeychainOverride = origReader
	})
	_ = os.Setenv("HOME", t.TempDir())

	// Mock Anthropic OAuth usage endpoint
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer sk-ant-test-keychain" {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"five_hour": {"utilization": 22.5, "resets_at": "2026-11-25T15:00:00Z"},
			"seven_day": {"utilization": 35.0, "resets_at": "2026-12-01T00:00:00Z"}
		}`))
	}))
	defer srv.Close()
	claudeOAuthUsageURL = srv.URL

	// Simulate macOS `security find-generic-password -w` returning hex-encoded JSON
	rawJSON := `{"claudeAiOauth":{"accessToken":"sk-ant-test-keychain","subscriptionType":"max"}}` + "\n"
	hexEncoded := hex.EncodeToString([]byte(rawJSON))
	readMacKeychainOverride = func(ctx context.Context) ([]byte, error) {
		return []byte(hexEncoded + "\n"), nil
	}

	res := Fetch(context.Background(), protocol.QuotaReqPayload{Agent: "claude"})
	if !res.Available || res.Source != "oauth-api" {
		t.Fatalf("expected available oauth-api quota, got %+v", res)
	}
	if res.PlanTier != "max" {
		t.Fatalf("expected tier=max, got %q", res.PlanTier)
	}
	if len(res.Windows) != 2 {
		t.Fatalf("expected 2 windows, got %+v", res.Windows)
	}
	if res.Windows[0].RemainingPercent == nil || *res.Windows[0].RemainingPercent != 77.5 {
		t.Fatalf("unexpected 5-hour remaining: %+v", res.Windows[0])
	}
	if res.Windows[1].RemainingPercent == nil || *res.Windows[1].RemainingPercent != 65.0 {
		t.Fatalf("unexpected 7-day remaining: %+v", res.Windows[1])
	}
}
