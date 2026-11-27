package main

import (
	"context"
	"flag"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/jd04063221/agent-remote/apps/remote-node/internal/auth"
	"github.com/jd04063221/agent-remote/apps/remote-node/internal/envfile"
	"github.com/jd04063221/agent-remote/apps/remote-node/internal/server"
)

func main() {
	listenAddr := flag.String("listen", "127.0.0.1:19420", "Listen address (bind 127.0.0.1 when behind tailscale serve, or 0.0.0.0:19420 for LAN/VPN)")
	authMode := flag.String("auth-mode", string(auth.ModeTailscaleServe), "Auth mode: tailscale-serve | tailscaled-whois | pubkey | token | dev-token")
	allowedUsers := flag.String("allowed-users", "", "Comma-separated allowed Tailscale user logins or key labels (empty = any authorized identity)")
	devToken := flag.String("dev-token", os.Getenv("AGENT_REMOTE_DEV_TOKEN"), "Bearer API key for token / dev-token mode")
	apiToken := flag.String("token", os.Getenv("AGENT_REMOTE_TOKEN"), "Alias for --dev-token (Bearer API key for token / dev-token mode)")
	authorizedKeys := flag.String("authorized-keys", os.Getenv("AGENT_REMOTE_AUTHORIZED_KEYS"), "Authorized Ed25519 public keys for pubkey mode (ssh-ed25519 ... lines, semicolon or newline separated)")
	authorizedKeysFile := flag.String("authorized-keys-file", os.Getenv("AGENT_REMOTE_AUTHORIZED_KEYS_FILE"), "Path to authorized_keys file for pubkey mode (defaults to ~/.config/agent-remote/authorized_keys)")
	tailscaledSock := flag.String("tailscaled-sock", "/var/run/tailscale/tailscaled.sock", "Path to tailscaled Unix socket")
	workBaseDir := flag.String("work-base-dir", os.Getenv("AGENT_REMOTE_WORK_BASE_DIR"), "Base directory for per-session isolated workdirs (auto-switches to Snap-shared dir for /snap/bin/* CLIs)")
	envFilePath := flag.String("env-file", os.Getenv("AGENT_REMOTE_ENV_FILE"), "Optional dotenv file loaded at startup (defaults to ~/.config/agent-remote/node.env if present)")
	maxSessions := flag.Int("max-sessions", 16, "Maximum concurrent remote agent sessions")
	flag.Parse()

	if targetEnv := strings.TrimSpace(*envFilePath); targetEnv != "" {
		n, err := envfile.Load(targetEnv)
		if err != nil {
			log.Printf("warning: failed loading --env-file %s: %v", targetEnv, err)
		} else {
			log.Printf("loaded %d environment variable(s) from %s", n, targetEnv)
		}
	} else if defEnv := envfile.DefaultPath(); defEnv != "" {
		if n, err := envfile.Load(defEnv); err == nil && n > 0 {
			log.Printf("loaded %d environment variable(s) from %s", n, defEnv)
		}
	}
	resolvedToken := strings.TrimSpace(*apiToken)
	if resolvedToken == "" {
		resolvedToken = strings.TrimSpace(*devToken)
	}
	if resolvedToken == "" {
		resolvedToken = strings.TrimSpace(os.Getenv("AGENT_REMOTE_TOKEN"))
	}
	if resolvedToken == "" {
		resolvedToken = strings.TrimSpace(os.Getenv("AGENT_REMOTE_DEV_TOKEN"))
	}
	resolvedAuthKeys := strings.TrimSpace(*authorizedKeys)
	if resolvedAuthKeys == "" {
		resolvedAuthKeys = strings.TrimSpace(os.Getenv("AGENT_REMOTE_AUTHORIZED_KEYS"))
	}
	resolvedAuthKeysFile := strings.TrimSpace(*authorizedKeysFile)
	if resolvedAuthKeysFile == "" {
		resolvedAuthKeysFile = strings.TrimSpace(os.Getenv("AGENT_REMOTE_AUTHORIZED_KEYS_FILE"))
	}
	if resolvedAuthKeysFile == "" {
		resolvedAuthKeysFile = auth.DefaultAuthorizedKeysPath()
	}

	allowed := make(map[string]struct{})
	for _, u := range strings.Split(*allowedUsers, ",") {
		if trimmed := strings.TrimSpace(u); trimmed != "" {
			allowed[trimmed] = struct{}{}
		}
	}

	authenticator := auth.New(auth.Config{
		Mode:               auth.Mode(*authMode),
		AllowedUsers:       allowed,
		DevToken:           resolvedToken,
		AuthorizedKeys:     resolvedAuthKeys,
		AuthorizedKeysFile: resolvedAuthKeysFile,
		TailscaledSock:     *tailscaledSock,
	})

	nodeSrv := server.New(server.Config{
		Auth:        authenticator,
		MaxSessions: *maxSessions,
		WorkBaseDir: strings.TrimSpace(*workBaseDir),
	})

	httpSrv := &http.Server{
		Addr:              *listenAddr,
		Handler:           nodeSrv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		log.Printf("agent-remote-node v%s listening on %s (auth=%s, maxSessions=%d)",
			server.NodeVersion, *listenAddr, *authMode, *maxSessions)
		if err := httpSrv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("server failed: %v", err)
		}
	}()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	<-sigCh

	log.Println("shutting down agent-remote-node...")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = httpSrv.Shutdown(ctx)
	nodeSrv.CloseAll()
}
