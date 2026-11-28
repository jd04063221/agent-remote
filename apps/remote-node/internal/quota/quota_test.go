package quota

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/jd04063221/agent-remote/apps/remote-node/internal/protocol"
)

func TestSubscriptionOAuthQuotaProbingDisabled(t *testing.T) {
	fakeHome := t.TempDir()
	t.Setenv("HOME", fakeHome)

	// Even when subscription OAuth credential files exist locally, quota.Fetch must NEVER
	// extract them or call undocumented vendor endpoints for claude or antigravity.
	claudeDir := filepath.Join(fakeHome, ".claude")
	if err := os.MkdirAll(claudeDir, 0o700); err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(
		filepath.Join(claudeDir, ".credentials.json"),
		[]byte(`{"claudeAiOauth":{"accessToken":"sk-ant-should-never-be-read","subscriptionType":"max"}}`),
		0o600,
	)

	agyDir := filepath.Join(fakeHome, ".gemini", "antigravity-cli")
	if err := os.MkdirAll(agyDir, 0o700); err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(filepath.Join(agyDir, "antigravity-oauth-token"), []byte("should-never-be-read"), 0o600)

	for _, agent := range []string{"antigravity", "claude"} {
		res := Fetch(context.Background(), protocol.QuotaReqPayload{Agent: agent})
		if res.Available || res.Source != "unavailable" || len(res.Windows) != 0 {
			t.Fatalf("expected %s quota probing to be safely disabled, got %+v", agent, res)
		}
	}
}
