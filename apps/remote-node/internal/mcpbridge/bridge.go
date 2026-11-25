package mcpbridge

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/jd04063221/agent-remote/apps/remote-node/internal/protocol"
)

// ForwardFunc forwards an MCP HTTP request across the multiplexed WSS tunnel to the local Hub.
type ForwardFunc func(req protocol.McpRpcReqPayload) error

// Bridge exposes an ephemeral loopback HTTP endpoint (127.0.0.1:0/mcp) for a single remote agent session.
// All incoming MCP JSON-RPC calls are authenticated via per-session Bearer token and tunneled over WSS.
type Bridge struct {
	sessionID string
	token     string
	listener  net.Listener
	server    *http.Server
	forward   ForwardFunc

	mu      sync.Mutex
	pending map[string]chan protocol.McpRpcResPayload
}

func New(sessionID string, forward ForwardFunc) (*Bridge, error) {
	tokenBytes := make([]byte, 32)
	if _, err := rand.Read(tokenBytes); err != nil {
		return nil, err
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}

	b := &Bridge{
		sessionID: sessionID,
		token:     hex.EncodeToString(tokenBytes),
		listener:  ln,
		forward:   forward,
		pending:   make(map[string]chan protocol.McpRpcResPayload),
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/mcp", b.handleMCP)
	b.server = &http.Server{
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		_ = b.server.Serve(ln)
	}()

	return b, nil
}

func (b *Bridge) EndpointURL() string {
	return fmt.Sprintf("http://%s/mcp", b.listener.Addr().String())
}

func (b *Bridge) BearerToken() string {
	return b.token
}

func (b *Bridge) Resolve(res protocol.McpRpcResPayload) {
	b.mu.Lock()
	ch, ok := b.pending[res.RpcID]
	if ok {
		delete(b.pending, res.RpcID)
	}
	b.mu.Unlock()
	if ok {
		ch <- res
	}
}

func (b *Bridge) Close() error {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	b.mu.Lock()
	for id, ch := range b.pending {
		close(ch)
		delete(b.pending, id)
	}
	b.mu.Unlock()
	return b.server.Shutdown(ctx)
}

func (b *Bridge) handleMCP(w http.ResponseWriter, r *http.Request) {
	authHeader := r.Header.Get("Authorization")
	const prefix = "Bearer "
	if !strings.HasPrefix(authHeader, prefix) ||
		subtle.ConstantTimeCompare([]byte(strings.TrimPrefix(authHeader, prefix)), []byte(b.token)) != 1 {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	bodyBytes, err := io.ReadAll(io.LimitReader(r.Body, 4<<20))
	if err != nil {
		http.Error(w, "failed reading body", http.StatusBadRequest)
		return
	}

	rpcIDBytes := make([]byte, 12)
	_, _ = rand.Read(rpcIDBytes)
	rpcID := hex.EncodeToString(rpcIDBytes)

	headers := make(map[string]string, len(r.Header))
	for k, vals := range r.Header {
		if strings.EqualFold(k, "Authorization") {
			continue
		}
		if len(vals) > 0 {
			headers[k] = vals[0]
		}
	}

	respCh := make(chan protocol.McpRpcResPayload, 1)
	b.mu.Lock()
	b.pending[rpcID] = respCh
	b.mu.Unlock()

	defer func() {
		b.mu.Lock()
		delete(b.pending, rpcID)
		b.mu.Unlock()
	}()

	reqPayload := protocol.McpRpcReqPayload{
		RpcID:     rpcID,
		SessionID: b.sessionID,
		Method:    r.Method,
		Path:      r.URL.RequestURI(),
		Headers:   headers,
		Body:      string(bodyBytes),
	}

	if err := b.forward(reqPayload); err != nil {
		http.Error(w, fmt.Sprintf("tunnel forward failed: %v", err), http.StatusBadGateway)
		return
	}

	select {
	case res, ok := <-respCh:
		if !ok {
			http.Error(w, "bridge closed", http.StatusServiceUnavailable)
			return
		}
		for k, v := range res.Headers {
			w.Header().Set(k, v)
		}
		if w.Header().Get("Content-Type") == "" {
			w.Header().Set("Content-Type", "application/json")
		}
		status := res.Status
		if status == 0 {
			status = http.StatusOK
		}
		w.WriteHeader(status)
		_, _ = io.WriteString(w, res.Body)
	case <-r.Context().Done():
		http.Error(w, errors.New("request cancelled").Error(), http.StatusRequestTimeout)
	case <-time.After(2 * time.Hour):
		http.Error(w, "mcp tool execution timeout", http.StatusGatewayTimeout)
	}
}
