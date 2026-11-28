package server

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"

	"github.com/gorilla/websocket"

	"github.com/jd04063221/agent-remote/apps/remote-node/internal/auth"
	"github.com/jd04063221/agent-remote/apps/remote-node/internal/mcpbridge"
	"github.com/jd04063221/agent-remote/apps/remote-node/internal/probe"
	"github.com/jd04063221/agent-remote/apps/remote-node/internal/protocol"
	"github.com/jd04063221/agent-remote/apps/remote-node/internal/quota"
	"github.com/jd04063221/agent-remote/apps/remote-node/internal/ringbuf"
)

const NodeVersion = "0.1.5a"

type Config struct {
	Auth        *auth.Authenticator
	MaxSessions int
	WorkBaseDir string
}

type activeConn struct {
	ws *websocket.Conn
	mu sync.Mutex
}

func (c *activeConn) Send(f protocol.Frame) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.ws.WriteJSON(f)
}

type managedSession struct {
	id         string
	channel    int
	workdir    string
	emptyDir   string
	cmd        *exec.Cmd
	stdin      io.WriteCloser
	ring       *ringbuf.EventRing
	mcpBridge  *mcpbridge.Bridge
	cancelFunc context.CancelFunc

	mu     sync.RWMutex
	conn   *activeConn
	exited bool
}

func (s *managedSession) setConn(c *activeConn) {
	s.mu.Lock()
	s.conn = c
	s.mu.Unlock()
}

func (s *managedSession) emit(f protocol.Frame) {
	recorded := s.ring.Append(f)
	s.mu.RLock()
	c := s.conn
	s.mu.RUnlock()
	if c != nil {
		_ = c.Send(recorded)
	}
}

func (s *managedSession) cleanup() {
	if s.cmd != nil {
		killProcTree(s.cmd)
	}
	if s.cancelFunc != nil {
		s.cancelFunc()
	}
	if s.mcpBridge != nil {
		_ = s.mcpBridge.Close()
	}
	if s.workdir != "" {
		_ = os.RemoveAll(s.workdir)
	}
}

type Server struct {
	cfg      Config
	upgrader websocket.Upgrader

	mu       sync.Mutex
	nextCh   int
	sessions map[string]*managedSession
	byCh     map[int]*managedSession
}

func New(cfg Config) *Server {
	if cfg.MaxSessions <= 0 {
		cfg.MaxSessions = 16
	}
	return &Server{
		cfg: cfg,
		upgrader: websocket.Upgrader{
			CheckOrigin: func(r *http.Request) bool { return true },
		},
		nextCh:   1,
		sessions: make(map[string]*managedSession),
		byCh:     make(map[int]*managedSession),
	}
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"ok":true,"version":"`+NodeVersion+`"}`)
	})
	mux.HandleFunc("/v1/ws", s.handleWS)
	return mux
}

func (s *Server) CloseAll() {
	s.mu.Lock()
	all := make([]*managedSession, 0, len(s.sessions))
	for _, sess := range s.sessions {
		all = append(all, sess)
	}
	s.sessions = make(map[string]*managedSession)
	s.byCh = make(map[int]*managedSession)
	s.mu.Unlock()

	for _, sess := range all {
		sess.cleanup()
	}
}

func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	ident, err := s.cfg.Auth.VerifyRequest(r)
	if err != nil {
		http.Error(w, "unauthorized: "+err.Error(), http.StatusUnauthorized)
		return
	}

	ws, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	conn := &activeConn{ws: ws}
	defer func() {
		// Detach connection without killing running remote sessions (enables roaming & reconnect!).
		s.detachConn(conn)
		_ = ws.Close()
	}()

	hostname, _ := os.Hostname()
	_ = conn.Send(protocol.Frame{
		Ch:   0,
		Type: protocol.TypeHelloAck,
		Payload: protocol.MustMarshalPayload(protocol.HelloAckPayload{
			NodeVersion: NodeVersion,
			Hostname:    hostname,
			OS:          runtime.GOOS,
			Arch:        runtime.GOARCH,
			PeerUser:    ident.UserLogin,
		}),
	})

	for {
		var frame protocol.Frame
		if err := ws.ReadJSON(&frame); err != nil {
			return
		}
		s.dispatch(r.Context(), conn, frame)
	}
}

func (s *Server) detachConn(conn *activeConn) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, sess := range s.sessions {
		sess.mu.Lock()
		if sess.conn == conn {
			sess.conn = nil
		}
		sess.mu.Unlock()
	}
}

func (s *Server) dispatch(ctx context.Context, conn *activeConn, frame protocol.Frame) {
	switch frame.Type {
	case protocol.TypePing:
		_ = conn.Send(protocol.Frame{Ch: 0, ID: frame.ID, Type: protocol.TypePong})

	case protocol.TypeProbeReq:
		s.mu.Lock()
		activeCount := len(s.sessions)
		s.mu.Unlock()
		res := probe.RunHostProbe(ctx, activeCount, s.cfg.MaxSessions)
		_ = conn.Send(protocol.Frame{
			Ch:      0,
			ID:      frame.ID,
			Type:    protocol.TypeProbeRes,
			Payload: protocol.MustMarshalPayload(res),
		})

	case protocol.TypeCatalogReq:
		var req protocol.CatalogReqPayload
		if err := json.Unmarshal(frame.Payload, &req); err != nil {
			sendErr(conn, 0, frame.ID, "invalid_payload", err.Error())
			return
		}
		res := probe.DiscoverCatalog(ctx, req)
		_ = conn.Send(protocol.Frame{
			Ch:      0,
			ID:      frame.ID,
			Type:    protocol.TypeCatalogRes,
			Payload: protocol.MustMarshalPayload(res),
		})

	case protocol.TypeQuotaReq:
		var req protocol.QuotaReqPayload
		if err := json.Unmarshal(frame.Payload, &req); err != nil {
			sendErr(conn, 0, frame.ID, "invalid_payload", err.Error())
			return
		}
		res := quota.Fetch(ctx, req)
		_ = conn.Send(protocol.Frame{
			Ch:      0,
			ID:      frame.ID,
			Type:    protocol.TypeQuotaRes,
			Payload: protocol.MustMarshalPayload(res),
		})

	case protocol.TypeSpawnSession:
		var req protocol.SpawnSessionPayload
		if err := json.Unmarshal(frame.Payload, &req); err != nil {
			sendErr(conn, 0, frame.ID, "invalid_payload", err.Error())
			return
		}
		s.handleSpawn(conn, frame.ID, req)

	case protocol.TypeSessionResume:
		var req protocol.SessionResumePayload
		if err := json.Unmarshal(frame.Payload, &req); err != nil {
			sendErr(conn, 0, frame.ID, "invalid_payload", err.Error())
			return
		}
		s.handleResume(conn, frame.ID, req)

	case protocol.TypeSessionStdin:
		var chunk protocol.StreamChunkPayload
		if err := json.Unmarshal(frame.Payload, &chunk); err != nil {
			sendErr(conn, frame.Ch, frame.ID, "invalid_payload", err.Error())
			return
		}
		sess := s.getByChannel(frame.Ch)
		if sess == nil {
			sendErr(conn, frame.Ch, frame.ID, "session_not_found", "unknown channel")
			return
		}
		if _, err := io.WriteString(sess.stdin, chunk.Data); err != nil {
			sendErr(conn, frame.Ch, frame.ID, "stdin_write_failed", err.Error())
		}

	case protocol.TypeMcpRpcRes:
		var res protocol.McpRpcResPayload
		if err := json.Unmarshal(frame.Payload, &res); err != nil {
			return
		}
		if sess := s.getByChannel(frame.Ch); sess != nil && sess.mcpBridge != nil {
			sess.mcpBridge.Resolve(res)
		}

	case protocol.TypeSessionKill:
		sess := s.getByChannel(frame.Ch)
		if sess != nil {
			s.removeSession(sess)
			sess.cleanup()
		}

	default:
		sendErr(conn, frame.Ch, frame.ID, "unknown_frame_type", fmt.Sprintf("unsupported type %q", frame.Type))
	}
}

func (s *Server) handleSpawn(conn *activeConn, reqID string, req protocol.SpawnSessionPayload) {
	if req.SessionID == "" || req.Command == "" {
		sendErr(conn, 0, reqID, "invalid_payload", "sessionId and command are required")
		return
	}

	s.mu.Lock()
	if _, exists := s.sessions[req.SessionID]; exists {
		s.mu.Unlock()
		sendErr(conn, 0, reqID, "session_exists", "session already exists")
		return
	}
	if len(s.sessions) >= s.cfg.MaxSessions {
		s.mu.Unlock()
		sendErr(conn, 0, reqID, "capacity_exceeded", "max concurrent sessions reached")
		return
	}
	ch := s.nextCh
	s.nextCh++
	s.mu.Unlock()

	resolvedCmd := req.Command
	if p, err := probe.ResolveBinary(req.Command); err == nil {
		resolvedCmd = p
	}

	workBase, err := resolveWorkBaseDir(s.cfg.WorkBaseDir, resolvedCmd, req.Agent)
	if err != nil {
		sendErr(conn, 0, reqID, "workdir_failed", err.Error())
		return
	}
	workdir, err := os.MkdirTemp(workBase, "ar-sess-*")
	if err != nil {
		sendErr(conn, 0, reqID, "workdir_failed", err.Error())
		return
	}
	_ = os.Chmod(workdir, 0o700)
	emptyDir := filepath.Join(workdir, "empty")
	if err := os.MkdirAll(emptyDir, 0o700); err != nil {
		_ = os.RemoveAll(workdir)
		sendErr(conn, 0, reqID, "workdir_failed", err.Error())
		return
	}

	sessCtx, cancel := context.WithCancel(context.Background())
	sess := &managedSession{
		id:         req.SessionID,
		channel:    ch,
		workdir:    workdir,
		emptyDir:   emptyDir,
		ring:       ringbuf.New(2000),
		cancelFunc: cancel,
		conn:       conn,
	}

	if req.EnableMcpBridge {
		bridge, err := mcpbridge.New(req.SessionID, func(rpcReq protocol.McpRpcReqPayload) error {
			sess.mu.RLock()
			c := sess.conn
			sess.mu.RUnlock()
			if c == nil {
				return errors.New("local hub disconnected")
			}
			return c.Send(protocol.Frame{
				Ch:      ch,
				Type:    protocol.TypeMcpRpcReq,
				Payload: protocol.MustMarshalPayload(rpcReq),
			})
		})
		if err != nil {
			sess.cleanup()
			sendErr(conn, 0, reqID, "mcp_bridge_failed", err.Error())
			return
		}
		sess.mcpBridge = bridge
	}

	replacer := buildMcpReplacer(sess.mcpBridge)
	if err := materializeFiles(workdir, req.EphemeralFiles, replacer); err != nil {
		sess.cleanup()
		sendErr(conn, 0, reqID, "ephemeral_files_failed", err.Error())
		return
	}

	expandedArgs := make([]string, len(req.Args))
	for i, a := range req.Args {
		expandedArgs[i] = replacer.Replace(a)
	}

	var ephemEnv map[string]string
	if req.EphemeralRemote {
		expandedArgs, ephemEnv = applyEphemeralIsolation(req.Agent, resolvedCmd, workdir, expandedArgs)
	}

	execBin, execArgs := prepareExecCommand(runtime.GOOS, resolvedCmd, expandedArgs)
	cmd := exec.CommandContext(sessCtx, execBin, execArgs...)
	configureProcGroup(cmd)
	cmd.Dir = emptyDir
	env := buildAugmentedEnv(os.Environ())
	env = setEnvVar(env, "AGENT_REMOTE_SESSION_ID", req.SessionID)
	env = setEnvVar(env, "AGENT_REMOTE_WORKDIR", workdir)
	if sess.mcpBridge != nil {
		env = setEnvVar(env, "AGENT_REMOTE_MCP_URL", sess.mcpBridge.EndpointURL())
		env = setEnvVar(env, "AGENT_REMOTE_MCP_TOKEN", sess.mcpBridge.BearerToken())
	}
	for k, v := range req.Env {
		env = setEnvVar(env, k, v)
	}
	for k, v := range ephemEnv {
		env = setEnvVar(env, k, v)
	}
	cmd.Env = env

	stdin, err := cmd.StdinPipe()
	if err != nil {
		sess.cleanup()
		sendErr(conn, 0, reqID, "pipe_failed", err.Error())
		return
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		sess.cleanup()
		sendErr(conn, 0, reqID, "pipe_failed", err.Error())
		return
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		sess.cleanup()
		sendErr(conn, 0, reqID, "pipe_failed", err.Error())
		return
	}

	if err := cmd.Start(); err != nil {
		sess.cleanup()
		sendErr(conn, 0, reqID, "spawn_failed", err.Error())
		return
	}

	sess.cmd = cmd
	sess.stdin = stdin

	s.mu.Lock()
	s.sessions[req.SessionID] = sess
	s.byCh[ch] = sess
	s.mu.Unlock()

	ready := protocol.SessionReadyPayload{
		SessionID: req.SessionID,
		Channel:   ch,
		Workdir:   emptyDir,
	}
	if sess.mcpBridge != nil {
		ready.McpEndpointURL = sess.mcpBridge.EndpointURL()
		ready.McpBearerToken = sess.mcpBridge.BearerToken()
	}

	_ = conn.Send(protocol.Frame{
		Ch:      0,
		ID:      reqID,
		Type:    protocol.TypeSessionReady,
		Payload: protocol.MustMarshalPayload(ready),
	})

	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		pumpStream(stdout, func(line string) {
			sess.emit(protocol.Frame{
				Ch:      ch,
				Type:    protocol.TypeSessionStdout,
				Payload: protocol.MustMarshalPayload(protocol.StreamChunkPayload{Data: line}),
			})
		})
	}()
	go func() {
		defer wg.Done()
		pumpStream(stderr, func(line string) {
			sess.emit(protocol.Frame{
				Ch:      ch,
				Type:    protocol.TypeSessionStderr,
				Payload: protocol.MustMarshalPayload(protocol.StreamChunkPayload{Data: line}),
			})
		})
	}()

	go func() {
		wg.Wait()
		err := cmd.Wait()
		exitCode := 0
		errStr := ""
		if err != nil {
			errStr = err.Error()
			var exitErr *exec.ExitError
			if errors.As(err, &exitErr) {
				exitCode = exitErr.ExitCode()
			} else {
				exitCode = -1
			}
		}
		sess.mu.Lock()
		sess.exited = true
		sess.mu.Unlock()

		sess.emit(protocol.Frame{
			Ch:   ch,
			Type: protocol.TypeSessionExit,
			Payload: protocol.MustMarshalPayload(protocol.SessionExitPayload{
				SessionID: req.SessionID,
				ExitCode:  exitCode,
				Error:     errStr,
			}),
		})
		s.removeSession(sess)
		sess.cleanup()
	}()
}

func (s *Server) handleResume(conn *activeConn, reqID string, req protocol.SessionResumePayload) {
	s.mu.Lock()
	sess, ok := s.sessions[req.SessionID]
	s.mu.Unlock()
	if !ok {
		sendErr(conn, 0, reqID, "session_not_found", "session not active on this node")
		return
	}

	sess.setConn(conn)
	ready := protocol.SessionReadyPayload{
		SessionID: sess.id,
		Channel:   sess.channel,
		Workdir:   sess.emptyDir,
	}
	if sess.mcpBridge != nil {
		ready.McpEndpointURL = sess.mcpBridge.EndpointURL()
		ready.McpBearerToken = sess.mcpBridge.BearerToken()
	}
	_ = conn.Send(protocol.Frame{
		Ch:      0,
		ID:      reqID,
		Type:    protocol.TypeSessionReady,
		Payload: protocol.MustMarshalPayload(ready),
	})

	for _, f := range sess.ring.ReplayAfter(req.LastAckSeq) {
		_ = conn.Send(f)
	}
}

func (s *Server) getByChannel(ch int) *managedSession {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.byCh[ch]
}

func (s *Server) removeSession(sess *managedSession) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.sessions, sess.id)
	delete(s.byCh, sess.channel)
}

func buildMcpReplacer(bridge *mcpbridge.Bridge) *strings.Replacer {
	if bridge == nil {
		return strings.NewReplacer()
	}
	return strings.NewReplacer(
		"{{MCP_URL}}", bridge.EndpointURL(),
		"{{MCP_TOKEN}}", bridge.BearerToken(),
	)
}

func materializeFiles(baseDir string, files map[string]string, replacer *strings.Replacer) error {
	cleanBase := filepath.Clean(baseDir)
	for rel, content := range files {
		cleanRel := filepath.Clean(rel)
		if filepath.IsAbs(cleanRel) || strings.HasPrefix(cleanRel, "..") {
			return fmt.Errorf("disallowed ephemeral file path: %q", rel)
		}
		target := filepath.Join(cleanBase, cleanRel)
		if !strings.HasPrefix(target, cleanBase+string(os.PathSeparator)) {
			return fmt.Errorf("ephemeral file escapes sandbox: %q", rel)
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
			return err
		}
		expanded := content
		if replacer != nil {
			expanded = replacer.Replace(content)
		}
		if err := os.WriteFile(target, []byte(expanded), 0o600); err != nil {
			return err
		}
	}
	return nil
}

func pumpStream(r io.Reader, onLine func(string)) {
	reader := bufio.NewReaderSize(r, 64*1024)
	for {
		line, err := reader.ReadString('\n')
		if len(line) > 0 {
			onLine(line)
		}
		if err != nil {
			return
		}
	}
}

func sendErr(conn *activeConn, ch int, id, code, msg string) {
	_ = conn.Send(protocol.Frame{
		Ch:      ch,
		ID:      id,
		Type:    protocol.TypeError,
		Payload: protocol.MustMarshalPayload(protocol.ErrorPayload{Code: code, Message: msg}),
	})
}

var knownSnapPackageByBinary = map[string]string{
	"agy": "antigravity-cli",
}

// isSnapBinary detects whether a resolved executable path belongs to an Ubuntu Snap package
// (which runs inside a private /tmp mount namespace and cannot access host /tmp).
func isSnapBinary(resolvedPath string) bool {
	if strings.HasPrefix(resolvedPath, "/snap/") || strings.HasPrefix(resolvedPath, "/var/lib/snapd/snap/") {
		return true
	}
	if target, err := os.Readlink(resolvedPath); err == nil {
		if strings.HasSuffix(target, "/bin/snap") || target == "snap" || strings.HasPrefix(target, "/snap/") {
			return true
		}
	}
	return false
}

// resolveWorkBaseDir chooses the base directory for per-session isolated workdirs.
// When the target CLI runs inside Ubuntu Snap confinement, host /tmp is invisible to the Snap
// process, so we automatically switch to a directory shared between host and Snap
// ($SNAP_USER_COMMON/ar-sessions, $HOME/snap/<pkg>/common/ar-sessions, or non-hidden $HOME/agent-remote-sessions).
func resolveWorkBaseDir(configuredBase, resolvedCmd, agent string) (string, error) {
	if configuredBase != "" {
		if err := os.MkdirAll(configuredBase, 0o700); err != nil {
			return "", err
		}
		return configuredBase, nil
	}

	if runtime.GOOS != "linux" {
		return "", nil
	}

	inSnapEnv := os.Getenv("SNAP") != "" || os.Getenv("SNAP_USER_COMMON") != ""
	if !inSnapEnv && !isSnapBinary(resolvedCmd) {
		return "", nil
	}

	if snapCommon := strings.TrimSpace(os.Getenv("SNAP_USER_COMMON")); snapCommon != "" {
		dir := filepath.Join(snapCommon, "ar-sessions")
		if err := os.MkdirAll(dir, 0o700); err == nil {
			return dir, nil
		}
	}

	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return "", nil
	}

	baseName := filepath.Base(resolvedCmd)
	snapCandidates := make([]string, 0, 3)
	if pkg, ok := knownSnapPackageByBinary[baseName]; ok {
		snapCandidates = append(snapCandidates, pkg)
	}
	if agent == "antigravity" {
		snapCandidates = append(snapCandidates, "antigravity-cli")
	}
	snapCandidates = append(snapCandidates, baseName)

	for _, pkg := range snapCandidates {
		commonDir := filepath.Join(home, "snap", pkg, "common")
		if info, err := os.Stat(commonDir); err == nil && info.IsDir() {
			dir := filepath.Join(commonDir, "ar-sessions")
			if err := os.MkdirAll(dir, 0o700); err == nil {
				return dir, nil
			}
		}
	}

	// Fallback: non-hidden directory inside $HOME (accessible via Snap `home` plug, unlike /tmp or ~/.cache)
	dir := filepath.Join(home, "agent-remote-sessions")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	return dir, nil
}

// prepareExecCommand adapts remote CLI invocation for Windows .ps1 and .cmd/.bat wrappers:
// - .ps1 scripts are launched via PowerShell (`pwsh` or `powershell.exe -NoProfile -ExecutionPolicy Bypass -File`).
// - .cmd/.bat shims (e.g. npm-installed claude.cmd) have raw newlines in arguments flattened so cmd.exe does not truncate them.
func prepareExecCommand(goos, resolvedCmd string, args []string) (string, []string) {
	if goos != "windows" {
		return resolvedCmd, args
	}
	lower := strings.ToLower(resolvedCmd)
	if strings.HasSuffix(lower, ".ps1") {
		ps := "powershell.exe"
		if p, err := exec.LookPath("pwsh"); err == nil {
			ps = p
		}
		wrapped := make([]string, 0, len(args)+5)
		wrapped = append(wrapped, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", resolvedCmd)
		wrapped = append(wrapped, args...)
		return ps, wrapped
	}
	if strings.HasSuffix(lower, ".cmd") || strings.HasSuffix(lower, ".bat") {
		safe := make([]string, len(args))
		for i, a := range args {
			a = strings.ReplaceAll(a, "\r\n", " ")
			a = strings.ReplaceAll(a, "\n", " ")
			a = strings.ReplaceAll(a, "\r", " ")
			safe[i] = a
		}
		return resolvedCmd, safe
	}
	return resolvedCmd, args
}

func buildAugmentedEnv(base []string) []string {
	out := make([]string, 0, len(base)+1)
	foundPath := false
	for _, entry := range base {
		if idx := strings.IndexByte(entry, '='); idx > 0 && strings.EqualFold(entry[:idx], "PATH") {
			key := entry[:idx]
			out = append(out, key+"="+probe.AugmentedPath(entry[idx+1:]))
			foundPath = true
		} else {
			out = append(out, entry)
		}
	}
	if !foundPath {
		out = append(out, "PATH="+probe.AugmentedPath(""))
	}
	return out
}

func setEnvVar(env []string, key, value string) []string {
	for i, entry := range env {
		if idx := strings.IndexByte(entry, '='); idx > 0 && strings.EqualFold(entry[:idx], key) {
			env[i] = key + "=" + value
			return env
		}
	}
	return append(env, key+"="+value)
}

func linkOrCopyFile(src, dst string) {
	info, err := os.Stat(src)
	if err != nil {
		return
	}
	if err := os.Symlink(src, dst); err == nil {
		return
	}
	if info.IsDir() {
		return
	}
	data, err := os.ReadFile(src)
	if err != nil {
		return
	}
	_ = os.WriteFile(dst, data, info.Mode().Perm())
}

// applyEphemeralIsolation redirects agent conversation/history storage into the session's
// temporary workdir (which is wiped on exit by os.RemoveAll) while symlinking only auth & config files,
// guaranteeing zero persistent conversation records remain on the remote host in incognito mode.
func applyEphemeralIsolation(agent, resolvedCmd, workdir string, args []string) ([]string, map[string]string) {
	envOverrides := make(map[string]string)
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return args, envOverrides
	}

	switch agent {
	case "antigravity":
		for _, a := range args {
			if a == "--gemini-dir" || a == "--gemini_dir" ||
				strings.HasPrefix(a, "--gemini-dir=") || strings.HasPrefix(a, "--gemini_dir=") {
				return args, envOverrides
			}
		}
		candidates := make([]string, 0, 3)
		if snapCommon := strings.TrimSpace(os.Getenv("SNAP_USER_COMMON")); snapCommon != "" {
			candidates = append(candidates, filepath.Join(snapCommon, ".gemini", "antigravity-cli"))
		}
		if runtime.GOOS == "linux" || isSnapBinary(resolvedCmd) {
			candidates = append(candidates, filepath.Join(home, "snap", "antigravity-cli", "common", ".gemini", "antigravity-cli"))
		}
		candidates = append(candidates, filepath.Join(home, ".gemini", "antigravity-cli"))

		srcAppDir := ""
		for _, c := range candidates {
			if info, err := os.Stat(c); err == nil && info.IsDir() {
				srcAppDir = c
				break
			}
		}
		if srcAppDir == "" {
			return args, envOverrides
		}

		ephemGemini := filepath.Join(workdir, ".ephem-gemini")
		ephemAppDir := filepath.Join(ephemGemini, "antigravity-cli")
		if err := os.MkdirAll(ephemAppDir, 0o700); err != nil {
			return args, envOverrides
		}
		// Never duplicate OAuth tokens or installation_id into throwaway copies:
		// require real symlinks so official `agy` refreshes its own canonical token file in-place.
		for _, mustSymlink := range []string{"antigravity-oauth-token", "installation_id"} {
			src := filepath.Join(srcAppDir, mustSymlink)
			if _, statErr := os.Stat(src); statErr == nil {
				if err := os.Symlink(src, filepath.Join(ephemAppDir, mustSymlink)); err != nil {
					_ = os.RemoveAll(ephemGemini)
					return args, envOverrides
				}
			}
		}
		for _, entry := range []string{
			"settings.json",
			"jetski_state.pbtxt",
			"builtin",
			"bin",
			"mcp",
		} {
			linkOrCopyFile(filepath.Join(srcAppDir, entry), filepath.Join(ephemAppDir, entry))
		}
		outArgs := append(append([]string(nil), args...), "--gemini-dir", ephemGemini)
		return outArgs, envOverrides

	case "opencode":
		candidates := make([]string, 0, 4)
		if xdg := strings.TrimSpace(os.Getenv("XDG_DATA_HOME")); xdg != "" {
			candidates = append(candidates, filepath.Join(xdg, "opencode"))
		}
		candidates = append(candidates, filepath.Join(home, ".local", "share", "opencode"))
		if localApp := strings.TrimSpace(os.Getenv("LOCALAPPDATA")); localApp != "" {
			candidates = append(candidates, filepath.Join(localApp, "opencode"))
		}
		if appData := strings.TrimSpace(os.Getenv("APPDATA")); appData != "" {
			candidates = append(candidates, filepath.Join(appData, "opencode"))
		}
		srcBase := ""
		hadRealAuth := false
		for _, c := range candidates {
			if _, err := os.Stat(filepath.Join(c, "auth.json")); err == nil {
				srcBase = c
				hadRealAuth = true
				break
			}
		}
		if srcBase == "" {
			for _, c := range candidates {
				if info, err := os.Stat(c); err == nil && info.IsDir() {
					srcBase = c
					break
				}
			}
		}
		ephemXdg := filepath.Join(workdir, ".ephem-xdg-data")
		ephemOpenCode := filepath.Join(ephemXdg, "opencode")
		if err := os.MkdirAll(ephemOpenCode, 0o700); err != nil {
			return args, envOverrides
		}
		if srcBase != "" {
			for _, entry := range []string{"auth.json", "mcp-auth.json"} {
				linkOrCopyFile(filepath.Join(srcBase, entry), filepath.Join(ephemOpenCode, entry))
			}
		}
		if !hadRealAuth {
			envOverrides["XDG_DATA_HOME"] = ephemXdg
		} else if _, err := os.Stat(filepath.Join(ephemOpenCode, "auth.json")); err == nil {
			envOverrides["XDG_DATA_HOME"] = ephemXdg
		}
		return args, envOverrides
	}

	return args, envOverrides
}
