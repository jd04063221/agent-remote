package auth

import (
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
)

func TestTailscaleServeAuthAntiSpoofAndACL(t *testing.T) {
	a := New(Config{
		Mode: ModeTailscaleServe,
		AllowedUsers: map[string]struct{}{
			"alice@example.com": {},
		},
	})

	// 1. Rejects non-loopback peer even if Tailscale-User-Login header is forged
	req := httptest.NewRequest(http.MethodGet, "/v1/ws", nil)
	req.RemoteAddr = "203.0.113.5:55555"
	req.Header.Set("Tailscale-User-Login", "alice@example.com")
	if _, err := a.VerifyRequest(req); err == nil {
		t.Fatal("expected non-loopback spoofed header to be rejected")
	}

	// 2. Rejects unauthorized Tailnet user on loopback
	req2 := httptest.NewRequest(http.MethodGet, "/v1/ws", nil)
	req2.RemoteAddr = "127.0.0.1:41234"
	req2.Header.Set("Tailscale-User-Login", "mallory@example.com")
	if _, err := a.VerifyRequest(req2); err == nil {
		t.Fatal("expected disallowed user to be rejected")
	}

	// 3. Accepts allowed Tailnet user via local tailscale serve proxy
	req3 := httptest.NewRequest(http.MethodGet, "/v1/ws", nil)
	req3.RemoteAddr = "127.0.0.1:41234"
	req3.Header.Set("Tailscale-User-Login", "alice@example.com")
	ident, err := a.VerifyRequest(req3)
	if err != nil || ident.UserLogin != "alice@example.com" {
		t.Fatalf("expected alice@example.com, got ident=%+v err=%v", ident, err)
	}
}

func TestTailscaledWhoIsOverUnixSocket(t *testing.T) {
	sockPath := filepath.Join(t.TempDir(), "tailscaled.sock")
	ln, err := net.Listen("unix", sockPath)
	if err != nil {
		t.Fatalf("listen unix: %v", err)
	}
	defer ln.Close()

	srv := &http.Server{
		Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/localapi/v0/whois" {
				http.NotFound(w, r)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"Node":{"ComputedName":"laptop.ts.net"},"UserProfile":{"LoginName":"bob@example.com"}}`))
		}),
	}
	go func() { _ = srv.Serve(ln) }()
	defer srv.Close()

	a := New(Config{
		Mode:           ModeTailscaleWhoIs,
		TailscaledSock: sockPath,
		AllowedUsers:   map[string]struct{}{"bob@example.com": {}},
	})

	req := httptest.NewRequest(http.MethodGet, "/v1/ws", nil)
	req.RemoteAddr = "100.64.0.10:51234"
	ident, err := a.VerifyRequest(req)
	if err != nil {
		t.Fatalf("expected whois auth to succeed: %v", err)
	}
	if ident.UserLogin != "bob@example.com" || ident.NodeName != "laptop.ts.net" {
		t.Fatalf("unexpected identity: %+v", ident)
	}
}
