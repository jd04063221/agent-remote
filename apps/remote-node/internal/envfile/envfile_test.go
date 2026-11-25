package envfile

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadDotEnvFile(t *testing.T) {
	dir := t.TempDir()
	envPath := filepath.Join(dir, "node.env")
	content := `
# Remote secrets & proxy
DEEPSEEK_API_KEY="sk-ds-test-123"
export OPENROUTER_API_KEY='sk-or-test-456'
AR_EXISTING_VAR=should-not-overwrite
`
	if err := os.WriteFile(envPath, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}

	t.Setenv("AR_EXISTING_VAR", "already-set")
	_ = os.Unsetenv("DEEPSEEK_API_KEY")
	_ = os.Unsetenv("OPENROUTER_API_KEY")
	t.Cleanup(func() {
		_ = os.Unsetenv("DEEPSEEK_API_KEY")
		_ = os.Unsetenv("OPENROUTER_API_KEY")
	})

	n, err := Load(envPath)
	if err != nil {
		t.Fatalf("Load failed: %v", err)
	}
	if n != 2 {
		t.Fatalf("expected 2 loaded vars, got %d", n)
	}
	if os.Getenv("DEEPSEEK_API_KEY") != "sk-ds-test-123" {
		t.Fatalf("unexpected DEEPSEEK_API_KEY: %q", os.Getenv("DEEPSEEK_API_KEY"))
	}
	if os.Getenv("OPENROUTER_API_KEY") != "sk-or-test-456" {
		t.Fatalf("unexpected OPENROUTER_API_KEY: %q", os.Getenv("OPENROUTER_API_KEY"))
	}
	if os.Getenv("AR_EXISTING_VAR") != "already-set" {
		t.Fatalf("existing env var was overwritten: %q", os.Getenv("AR_EXISTING_VAR"))
	}
}
