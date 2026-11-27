package auth

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"
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

func makeSignedPubKeyRequest(t *testing.T, pub ed25519.PublicKey, priv ed25519.PrivateKey, reqPath string, ts int64, nonce string) *http.Request {
	t.Helper()
	pubB64 := base64.RawURLEncoding.EncodeToString(pub)
	tsStr := strconv.FormatInt(ts, 10)
	payload := fmt.Sprintf("agent-remote-auth-v1\n%s\n%s\n%s\n%s\n%s",
		http.MethodGet, reqPath, tsStr, nonce, pubB64)
	sig := ed25519.Sign(priv, []byte(payload))
	sigB64 := base64.RawURLEncoding.EncodeToString(sig)

	req := httptest.NewRequest(http.MethodGet, reqPath, nil)
	req.Header.Set("Authorization", fmt.Sprintf("AR-Ed25519 pub=%s,ts=%s,nonce=%s,sig=%s",
		pubB64, tsStr, nonce, sigB64))
	return req
}

func TestPubKeyAuthSigningReplayAndHotReload(t *testing.T) {
	pub1, priv1, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate key 1: %v", err)
	}
	pub2, priv2, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate key 2: %v", err)
	}

	sshLine1 := "ssh-ed25519 " + base64.StdEncoding.EncodeToString(buildSSHEd25519Blob(pub1)) + " win-desktop"
	compactLine2 := "ed25519:" + base64.RawStdEncoding.EncodeToString(pub2) + " mac-laptop"

	keysFile := filepath.Join(t.TempDir(), "authorized_keys")
	if err := os.WriteFile(keysFile, []byte("# Comment\n"+sshLine1+"\n"), 0o600); err != nil {
		t.Fatalf("write authorized_keys: %v", err)
	}

	now := time.Unix(1_795_000_000, 0)
	a := New(Config{
		Mode:               ModePubKey,
		AuthorizedKeysFile: keysFile,
		NowFunc:            func() time.Time { return now },
	})

	// 1. Valid Ed25519 signed request succeeds and returns key comment as UserLogin
	req1 := makeSignedPubKeyRequest(t, pub1, priv1, "/v1/ws", now.Unix(), "0123456789abcdef0123456789abcdef")
	ident, err := a.VerifyRequest(req1)
	if err != nil {
		t.Fatalf("expected valid pubkey auth: %v", err)
	}
	if ident.UserLogin != "win-desktop" {
		t.Fatalf("expected win-desktop, got %+v", ident)
	}

	// 2. Exact replay with same nonce is rejected
	if _, err := a.VerifyRequest(req1); err == nil {
		t.Fatal("expected replayed nonce to be rejected")
	}

	// 3. Stale timestamp (>120s skew) is rejected
	staleReq := makeSignedPubKeyRequest(t, pub1, priv1, "/v1/ws", now.Unix()-300, "abcdef0123456789abcdef0123456789")
	if _, err := a.VerifyRequest(staleReq); err == nil {
		t.Fatal("expected expired timestamp to be rejected")
	}

	// 4. Unauthorized key2 is rejected before being added to authorized_keys
	unauthReq := makeSignedPubKeyRequest(t, pub2, priv2, "/v1/ws", now.Unix(), "11112222333344445555666677778888")
	if _, err := a.VerifyRequest(unauthReq); err == nil {
		t.Fatal("expected unauthorized key2 to be rejected")
	}

	// 5. Hot-reload: append key2 (compact ed25519: format) to authorized_keys file without recreating Authenticator
	if err := os.WriteFile(keysFile, []byte(sshLine1+"\n"+compactLine2+"\n"), 0o600); err != nil {
		t.Fatalf("update authorized_keys: %v", err)
	}
	// Bump mtime explicitly in case filesystem timestamp granularity is coarse
	futureTime := time.Now().Add(2 * time.Second)
	_ = os.Chtimes(keysFile, futureTime, futureTime)

	ident2, err := a.VerifyRequest(unauthReq)
	if err != nil {
		t.Fatalf("expected hot-reloaded key2 to succeed: %v", err)
	}
	if ident2.UserLogin != "mac-laptop" {
		t.Fatalf("expected mac-laptop, got %+v", ident2)
	}

	// 6. Token mode alias works identically to dev-token
	tokAuth := New(Config{Mode: ModeToken, DevToken: "ar_sk_secret123"})
	tokReq := httptest.NewRequest(http.MethodGet, "/v1/ws", nil)
	tokReq.Header.Set("Authorization", "Bearer ar_sk_secret123")
	if _, err := tokAuth.VerifyRequest(tokReq); err != nil {
		t.Fatalf("expected token mode alias to succeed: %v", err)
	}
}
