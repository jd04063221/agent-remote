package auth

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"runtime"
	"strings"
	"sync"
	"time"
)

type Mode string

const (
	ModeTailscaleServe Mode = "tailscale-serve"
	ModeTailscaleWhoIs Mode = "tailscaled-whois"
	ModePubKey         Mode = "pubkey"
	ModeToken          Mode = "token"
	ModeDevToken       Mode = "dev-token"
)

type Config struct {
	Mode               Mode
	AllowedUsers       map[string]struct{}
	DevToken           string
	AuthorizedKeys     string
	AuthorizedKeysFile string
	TailscaledSock     string
	NowFunc            func() time.Time
}

type Identity struct {
	UserLogin string
	NodeName  string
}

type Authenticator struct {
	cfg Config

	mu          sync.Mutex
	inlineKeys  []AuthorizedKey
	fileKeys    []AuthorizedKey
	fileModTime time.Time
	fileSize    int64
	fileLoaded  bool
	seenNonces  map[string]time.Time
}

func New(cfg Config) *Authenticator {
	if cfg.TailscaledSock == "" {
		cfg.TailscaledSock = "/var/run/tailscale/tailscaled.sock"
	}
	var inlineKeys []AuthorizedKey
	if strings.TrimSpace(cfg.AuthorizedKeys) != "" {
		if parsed, err := ParseAuthorizedKeysText(cfg.AuthorizedKeys); err == nil {
			inlineKeys = parsed
		}
	}
	return &Authenticator{
		cfg:        cfg,
		inlineKeys: inlineKeys,
		seenNonces: make(map[string]time.Time),
	}
}

func (a *Authenticator) now() time.Time {
	if a.cfg.NowFunc != nil {
		return a.cfg.NowFunc()
	}
	return time.Now()
}

func (a *Authenticator) VerifyRequest(r *http.Request) (Identity, error) {
	switch a.cfg.Mode {
	case ModeTailscaleServe:
		return a.verifyTailscaleServe(r)
	case ModeTailscaleWhoIs:
		return a.verifyTailscaledWhoIs(r)
	case ModePubKey:
		return a.verifyPubKey(r)
	case ModeDevToken, ModeToken:
		return a.verifyDevToken(r)
	default:
		return Identity{}, fmt.Errorf("unsupported auth mode: %q", a.cfg.Mode)
	}
}

func (a *Authenticator) verifyTailscaleServe(r *http.Request) (Identity, error) {
	// Tailscale Serve terminates TLS locally and proxies from 127.0.0.1 / ::1.
	// Reject non-loopback peers so spoofed Tailscale-User-Login headers cannot bypass auth.
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return Identity{}, fmt.Errorf("invalid remote addr: %w", err)
	}
	ip := net.ParseIP(host)
	if ip == nil || !ip.IsLoopback() {
		return Identity{}, errors.New("tailscale-serve mode only accepts loopback proxy connections")
	}

	user := strings.TrimSpace(r.Header.Get("Tailscale-User-Login"))
	if user == "" {
		return Identity{}, errors.New("missing Tailscale-User-Login header")
	}
	if err := a.checkAllowedUser(user); err != nil {
		return Identity{}, err
	}
	return Identity{UserLogin: user}, nil
}

func (a *Authenticator) verifyTailscaledWhoIs(r *http.Request) (Identity, error) {
	if runtime.GOOS == "windows" {
		return Identity{}, errors.New("tailscaled-whois Unix socket is unsupported on Windows; use --auth-mode tailscale-serve (or dev-token) instead")
	}
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()

	client := &http.Client{
		Transport: &http.Transport{
			DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				var d net.Dialer
				return d.DialContext(ctx, "unix", a.cfg.TailscaledSock)
			},
		},
	}

	endpoint := "http://local-tailscaled.sock/localapi/v0/whois?addr=" + url.QueryEscape(r.RemoteAddr)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return Identity{}, err
	}

	resp, err := client.Do(req)
	if err != nil {
		return Identity{}, fmt.Errorf("tailscaled whois query failed (%w) — on macOS App Store Tailscale or non-standard setups, use --auth-mode tailscale-serve instead", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return Identity{}, fmt.Errorf("tailscaled whois rejected peer with status %d", resp.StatusCode)
	}

	var parsed struct {
		Node struct {
			ComputedName string `json:"ComputedName"`
		} `json:"Node"`
		UserProfile struct {
			LoginName string `json:"LoginName"`
		} `json:"UserProfile"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
		return Identity{}, fmt.Errorf("invalid whois response: %w", err)
	}

	user := strings.TrimSpace(parsed.UserProfile.LoginName)
	if user == "" {
		return Identity{}, errors.New("tailscaled whois returned empty user login")
	}
	if err := a.checkAllowedUser(user); err != nil {
		return Identity{}, err
	}
	return Identity{
		UserLogin: user,
		NodeName:  parsed.Node.ComputedName,
	}, nil
}

func (a *Authenticator) verifyDevToken(r *http.Request) (Identity, error) {
	if a.cfg.DevToken == "" {
		return Identity{}, errors.New("dev-token auth enabled without configured token")
	}
	header := r.Header.Get("Authorization")
	const prefix = "Bearer "
	if !strings.HasPrefix(header, prefix) {
		return Identity{}, errors.New("missing Bearer token")
	}
	got := strings.TrimPrefix(header, prefix)
	if subtle.ConstantTimeCompare([]byte(got), []byte(a.cfg.DevToken)) != 1 {
		return Identity{}, errors.New("invalid Bearer token")
	}
	return Identity{UserLogin: "dev-local"}, nil
}

func (a *Authenticator) checkAllowedUser(user string) error {
	if len(a.cfg.AllowedUsers) == 0 {
		return nil
	}
	if _, ok := a.cfg.AllowedUsers[user]; !ok {
		return fmt.Errorf("user %q is not in allowed tailnet user list", user)
	}
	return nil
}
