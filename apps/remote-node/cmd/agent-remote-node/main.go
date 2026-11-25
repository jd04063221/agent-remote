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
	listenAddr := flag.String("listen", "127.0.0.1:19420", "Listen address (bind 127.0.0.1 when behind tailscale serve)")
	authMode := flag.String("auth-mode", string(auth.ModeTailscaleServe), "Auth mode: tailscale-serve | tailscaled-whois | dev-token")
	allowedUsers := flag.String("allowed-users", "", "Comma-separated allowed Tailscale user logins (empty = any peer in tailnet)")
	devToken := flag.String("dev-token", os.Getenv("AGENT_REMOTE_DEV_TOKEN"), "Bearer token for dev-token mode")
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
	if *devToken == "" {
		*devToken = os.Getenv("AGENT_REMOTE_DEV_TOKEN")
	}

	allowed := make(map[string]struct{})
	for _, u := range strings.Split(*allowedUsers, ",") {
		if trimmed := strings.TrimSpace(u); trimmed != "" {
			allowed[trimmed] = struct{}{}
		}
	}

	authenticator := auth.New(auth.Config{
		Mode:           auth.Mode(*authMode),
		AllowedUsers:   allowed,
		DevToken:       *devToken,
		TailscaledSock: *tailscaledSock,
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
