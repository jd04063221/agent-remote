package protocol

import "encoding/json"

// Frame mirrors @agent-remote/protocol MuxFrame.
// Ch == 0 is the control plane; Ch >= 1 carries isolated remote agent sessions.
type Frame struct {
	Ch      int             `json:"ch"`
	Seq     uint64          `json:"seq,omitempty"`
	ID      string          `json:"id,omitempty"`
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

const (
	TypeHello         = "hello"
	TypeHelloAck      = "hello_ack"
	TypePing          = "ping"
	TypePong          = "pong"
	TypeProbeReq      = "probe_req"
	TypeProbeRes      = "probe_res"
	TypeCatalogReq    = "catalog_req"
	TypeCatalogRes    = "catalog_res"
	TypeQuotaReq      = "quota_req"
	TypeQuotaRes      = "quota_res"
	TypeSpawnSession  = "spawn_session"
	TypeSessionReady  = "session_ready"
	TypeSessionResume = "session_resume"
	TypeSessionStdin  = "session_stdin"
	TypeSessionStdout = "session_stdout"
	TypeSessionStderr = "session_stderr"
	TypeSessionKill   = "session_kill"
	TypeSessionExit   = "session_exit"
	TypeMcpRpcReq     = "mcp_rpc_req"
	TypeMcpRpcRes     = "mcp_rpc_res"
	TypeError         = "error"
)

type HelloAckPayload struct {
	NodeVersion string `json:"nodeVersion"`
	Hostname    string `json:"hostname"`
	OS          string `json:"os"`
	Arch        string `json:"arch"`
	PeerUser    string `json:"peerUser,omitempty"`
}

type AgentProbeItem struct {
	Agent      string `json:"agent"`
	Binary     string `json:"binary"`
	Installed  bool   `json:"installed"`
	BinaryPath string `json:"binaryPath,omitempty"`
	Version    string `json:"version,omitempty"`
}

type ProbeResPayload struct {
	Hostname       string           `json:"hostname"`
	OS             string           `json:"os"`
	Arch           string           `json:"arch"`
	ActiveSessions int              `json:"activeSessions"`
	MaxSessions    int              `json:"maxSessions"`
	Agents         []AgentProbeItem `json:"agents"`
}

type CatalogReqPayload struct {
	Agent  string `json:"agent"`
	Binary string `json:"binary,omitempty"`
}

type CatalogResPayload struct {
	Agent     string `json:"agent"`
	RawOutput string `json:"rawOutput"`
	Error     string `json:"error,omitempty"`
}

type QuotaReqPayload struct {
	Agent  string `json:"agent"`
	Binary string `json:"binary,omitempty"`
}

type QuotaWindow struct {
	Label            string   `json:"label"`
	UsedPercent      *float64 `json:"usedPercent,omitempty"`
	RemainingPercent *float64 `json:"remainingPercent,omitempty"`
	RemainingAmount  string   `json:"remainingAmount,omitempty"`
	ResetsAt         string   `json:"resetsAt,omitempty"`
}

type QuotaResPayload struct {
	Agent     string        `json:"agent"`
	Available bool          `json:"available"`
	Source    string        `json:"source"`
	PlanTier  string        `json:"planTier,omitempty"`
	Windows   []QuotaWindow `json:"windows"`
	Note      string        `json:"note,omitempty"`
}

type SpawnSessionPayload struct {
	SessionID       string            `json:"sessionId"`
	Agent           string            `json:"agent"`
	Command         string            `json:"command"`
	Args            []string          `json:"args,omitempty"`
	Env             map[string]string `json:"env,omitempty"`
	EphemeralFiles  map[string]string `json:"ephemeralFiles,omitempty"`
	EnableMcpBridge bool              `json:"enableMcpBridge"`
	EphemeralRemote bool              `json:"ephemeralRemote,omitempty"`
}

type SessionReadyPayload struct {
	SessionID      string `json:"sessionId"`
	Channel        int    `json:"channel"`
	Workdir        string `json:"workdir"`
	McpEndpointURL string `json:"mcpEndpointUrl,omitempty"`
	McpBearerToken string `json:"mcpBearerToken,omitempty"`
}

type SessionResumePayload struct {
	SessionID  string `json:"sessionId"`
	LastAckSeq uint64 `json:"lastAckSeq"`
}

type StreamChunkPayload struct {
	Data string `json:"data"`
}

type SessionExitPayload struct {
	SessionID string `json:"sessionId"`
	ExitCode  int    `json:"exitCode"`
	Error     string `json:"error,omitempty"`
}

type McpRpcReqPayload struct {
	RpcID     string            `json:"rpcId"`
	SessionID string            `json:"sessionId"`
	Method    string            `json:"method"`
	Path      string            `json:"path"`
	Headers   map[string]string `json:"headers,omitempty"`
	Body      string            `json:"body"`
}

type McpRpcResPayload struct {
	RpcID   string            `json:"rpcId"`
	Status  int               `json:"status"`
	Headers map[string]string `json:"headers,omitempty"`
	Body    string            `json:"body"`
}

type ErrorPayload struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func MustMarshalPayload(v any) json.RawMessage {
	if v == nil {
		return nil
	}
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return b
}
