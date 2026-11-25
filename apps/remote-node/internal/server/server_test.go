package server

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/jd04063221/agent-remote/apps/remote-node/internal/auth"
	"github.com/jd04063221/agent-remote/apps/remote-node/internal/protocol"
)

func TestWSSAuthProbeSpawnMcpAndReconnectReplay(t *testing.T) {
	srv := New(Config{
		Auth: auth.New(auth.Config{
			Mode:     auth.ModeDevToken,
			DevToken: "secret-test-token",
		}),
		MaxSessions: 4,
	})
	defer srv.CloseAll()

	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	wsURL := "ws" + strings.TrimPrefix(ts.URL, "http") + "/v1/ws"

	// 1. Unauthorized connection must fail with 401
	_, resp, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err == nil || resp == nil || resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401 unauthorized, got err=%v resp=%v", err, resp)
	}

	// 2. Authorized connection succeeds and receives hello_ack
	headers := http.Header{"Authorization": []string{"Bearer secret-test-token"}}
	ws, _, err := websocket.DefaultDialer.Dial(wsURL, headers)
	if err != nil {
		t.Fatalf("dial failed: %v", err)
	}
	defer ws.Close()

	var hello protocol.Frame
	if err := ws.ReadJSON(&hello); err != nil {
		t.Fatalf("read hello_ack: %v", err)
	}
	if hello.Type != protocol.TypeHelloAck {
		t.Fatalf("expected hello_ack, got %s", hello.Type)
	}

	// 3. Control-plane probe_req
	if err := ws.WriteJSON(protocol.Frame{Ch: 0, ID: "p1", Type: protocol.TypeProbeReq}); err != nil {
		t.Fatalf("write probe_req: %v", err)
	}
	var probeRes protocol.Frame
	if err := ws.ReadJSON(&probeRes); err != nil {
		t.Fatalf("read probe_res: %v", err)
	}
	if probeRes.Type != protocol.TypeProbeRes {
		t.Fatalf("expected probe_res, got %s", probeRes.Type)
	}

	// 4. Spawn isolated `cat` session with MCP bridge enabled
	if err := ws.WriteJSON(protocol.Frame{
		Ch:   0,
		ID:   "s1",
		Type: protocol.TypeSpawnSession,
		Payload: protocol.MustMarshalPayload(protocol.SpawnSessionPayload{
			SessionID:       "sess-test-1",
			Agent:           "antigravity",
			Command:         "cat",
			EnableMcpBridge: true,
			EphemeralFiles: map[string]string{
				"config/test.json": `{"url":"{{MCP_URL}}","token":"{{MCP_TOKEN}}"}`,
			},
		}),
	}); err != nil {
		t.Fatalf("write spawn_session: %v", err)
	}

	var readyFrame protocol.Frame
	if err := ws.ReadJSON(&readyFrame); err != nil {
		t.Fatalf("read session_ready: %v", err)
	}
	if readyFrame.Type != protocol.TypeSessionReady {
		t.Fatalf("expected session_ready, got %s (%s)", readyFrame.Type, string(readyFrame.Payload))
	}
	var ready protocol.SessionReadyPayload
	if err := json.Unmarshal(readyFrame.Payload, &ready); err != nil {
		t.Fatalf("unmarshal session_ready: %v", err)
	}
	if ready.McpEndpointURL == "" || ready.McpBearerToken == "" {
		t.Fatalf("expected MCP bridge endpoint and bearer token, got %+v", ready)
	}

	// 5. Round-trip stdin -> stdout over session channel
	if err := ws.WriteJSON(protocol.Frame{
		Ch:      ready.Channel,
		Type:    protocol.TypeSessionStdin,
		Payload: protocol.MustMarshalPayload(protocol.StreamChunkPayload{Data: "hello-tailnet\n"}),
	}); err != nil {
		t.Fatalf("write stdin: %v", err)
	}

	var outFrame protocol.Frame
	if err := ws.ReadJSON(&outFrame); err != nil {
		t.Fatalf("read stdout: %v", err)
	}
	if outFrame.Type != protocol.TypeSessionStdout || outFrame.Seq != 1 {
		t.Fatalf("expected stdout seq 1, got %+v", outFrame)
	}

	// 6. Test MCP-over-WSS reverse tunnel round-trip
	mcpDone := make(chan string, 1)
	go func() {
		req, _ := http.NewRequest(http.MethodPost, ready.McpEndpointURL, bytes.NewBufferString(`{"jsonrpc":"2.0","id":9,"method":"tools/list"}`))
		req.Header.Set("Authorization", "Bearer "+ready.McpBearerToken)
		req.Header.Set("Content-Type", "application/json")
		resp, err := (&http.Client{Timeout: 5 * time.Second}).Do(req)
		if err != nil {
			mcpDone <- "ERR:" + err.Error()
			return
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		mcpDone <- string(b)
	}()

	var mcpReqFrame protocol.Frame
	if err := ws.ReadJSON(&mcpReqFrame); err != nil {
		t.Fatalf("read mcp_rpc_req: %v", err)
	}
	if mcpReqFrame.Type != protocol.TypeMcpRpcReq {
		t.Fatalf("expected mcp_rpc_req, got %s", mcpReqFrame.Type)
	}
	var mcpReq protocol.McpRpcReqPayload
	_ = json.Unmarshal(mcpReqFrame.Payload, &mcpReq)

	if err := ws.WriteJSON(protocol.Frame{
		Ch:   ready.Channel,
		Type: protocol.TypeMcpRpcRes,
		Payload: protocol.MustMarshalPayload(protocol.McpRpcResPayload{
			RpcID:  mcpReq.RpcID,
			Status: http.StatusOK,
			Body:   `{"jsonrpc":"2.0","id":9,"result":{"tools":["read_file"]}}`,
		}),
	}); err != nil {
		t.Fatalf("write mcp_rpc_res: %v", err)
	}

	gotMcp := <-mcpDone
	if !strings.Contains(gotMcp, "read_file") {
		t.Fatalf("unexpected MCP response: %s", gotMcp)
	}

	// 7. Disconnect WS and reconnect with session_resume -> verify ring buffer replay!
	_ = ws.Close()
	time.Sleep(50 * time.Millisecond)

	ws2, _, err := websocket.DefaultDialer.Dial(wsURL, headers)
	if err != nil {
		t.Fatalf("reconnect dial failed: %v", err)
	}
	defer ws2.Close()

	_ = ws2.ReadJSON(&hello) // consume hello_ack
	if err := ws2.WriteJSON(protocol.Frame{
		Ch:   0,
		ID:   "r1",
		Type: protocol.TypeSessionResume,
		Payload: protocol.MustMarshalPayload(protocol.SessionResumePayload{
			SessionID:  "sess-test-1",
			LastAckSeq: 0,
		}),
	}); err != nil {
		t.Fatalf("write session_resume: %v", err)
	}

	var resumeReady, replayed protocol.Frame
	if err := ws2.ReadJSON(&resumeReady); err != nil || resumeReady.Type != protocol.TypeSessionReady {
		t.Fatalf("expected resume session_ready, got %+v err=%v", resumeReady, err)
	}
	if err := ws2.ReadJSON(&replayed); err != nil || replayed.Type != protocol.TypeSessionStdout || replayed.Seq != 1 {
		t.Fatalf("expected replayed stdout seq 1, got %+v err=%v", replayed, err)
	}

	// 8. Cleanly kill session
	_ = ws2.WriteJSON(protocol.Frame{Ch: ready.Channel, Type: protocol.TypeSessionKill})
}
