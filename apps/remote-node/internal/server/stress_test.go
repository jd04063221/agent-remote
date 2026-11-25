package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/jd04063221/agent-remote/apps/remote-node/internal/auth"
	"github.com/jd04063221/agent-remote/apps/remote-node/internal/protocol"
)

func TestConcurrentSessionsAndReconnectStress(t *testing.T) {
	const count = 5
	srv := New(Config{
		Auth: auth.New(auth.Config{
			Mode:     auth.ModeDevToken,
			DevToken: "stress-tok",
		}),
		MaxSessions: 10,
	})
	defer srv.CloseAll()

	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	wsURL := "ws" + strings.TrimPrefix(ts.URL, "http") + "/v1/ws"
	headers := http.Header{"Authorization": []string{"Bearer stress-tok"}}

	ws, _, err := websocket.DefaultDialer.Dial(wsURL, headers)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}

	var frame protocol.Frame
	if err := ws.ReadJSON(&frame); err != nil || frame.Type != protocol.TypeHelloAck {
		t.Fatalf("expected hello_ack, got %+v err=%v", frame, err)
	}

	// Spawn 5 concurrent multiplexed sessions over the single WSS connection
	sessions := make([]protocol.SessionReadyPayload, 0, count)
	for i := 0; i < count; i++ {
		sid := fmt.Sprintf("concurrent-%d", i)
		if err := ws.WriteJSON(protocol.Frame{
			Ch:   0,
			ID:   fmt.Sprintf("sp-%d", i),
			Type: protocol.TypeSpawnSession,
			Payload: protocol.MustMarshalPayload(protocol.SpawnSessionPayload{
				SessionID:       sid,
				Agent:           "antigravity",
				Command:         "cat",
				EnableMcpBridge: true,
			}),
		}); err != nil {
			t.Fatalf("spawn %s: %v", sid, err)
		}

		var readyFrame protocol.Frame
		if err := ws.ReadJSON(&readyFrame); err != nil || readyFrame.Type != protocol.TypeSessionReady {
			t.Fatalf("ready %s: %+v err=%v", sid, readyFrame, err)
		}
		var ready protocol.SessionReadyPayload
		_ = json.Unmarshal(readyFrame.Payload, &ready)
		sessions = append(sessions, ready)
	}

	// Write distinct payloads to every concurrent channel and collect all echoed frames
	for i, s := range sessions {
		if err := ws.WriteJSON(protocol.Frame{
			Ch:      s.Channel,
			Type:    protocol.TypeSessionStdin,
			Payload: protocol.MustMarshalPayload(protocol.StreamChunkPayload{Data: fmt.Sprintf("msg-%d\n", i)}),
		}); err != nil {
			t.Fatalf("stdin %d: %v", i, err)
		}
	}

	seen := make(map[int]string)
	for len(seen) < count {
		var out protocol.Frame
		if err := ws.ReadJSON(&out); err != nil {
			t.Fatalf("read stdout: %v", err)
		}
		if out.Type == protocol.TypeSessionStdout {
			var chunk protocol.StreamChunkPayload
			_ = json.Unmarshal(out.Payload, &chunk)
			seen[out.Ch] = strings.TrimSpace(chunk.Data)
		}
	}
	for i, s := range sessions {
		want := fmt.Sprintf("msg-%d", i)
		if seen[s.Channel] != want {
			t.Fatalf("ch %d expected %q got %q", s.Channel, want, seen[s.Channel])
		}
	}

	// Drop connection abruptly and verify ALL 5 sessions survive and replay cleanly after reconnect
	_ = ws.Close()
	time.Sleep(60 * time.Millisecond)

	ws2, _, err := websocket.DefaultDialer.Dial(wsURL, headers)
	if err != nil {
		t.Fatalf("reconnect dial: %v", err)
	}
	defer ws2.Close()
	_ = ws2.ReadJSON(&frame) // hello_ack

	for _, s := range sessions {
		if err := ws2.WriteJSON(protocol.Frame{
			Ch:   0,
			ID:   "res-" + s.SessionID,
			Type: protocol.TypeSessionResume,
			Payload: protocol.MustMarshalPayload(protocol.SessionResumePayload{
				SessionID:  s.SessionID,
				LastAckSeq: 0,
			}),
		}); err != nil {
			t.Fatalf("resume %s: %v", s.SessionID, err)
		}
		var r1, r2 protocol.Frame
		if err := ws2.ReadJSON(&r1); err != nil || r1.Type != protocol.TypeSessionReady {
			t.Fatalf("resume ready %s: %+v err=%v", s.SessionID, r1, err)
		}
		if err := ws2.ReadJSON(&r2); err != nil || r2.Type != protocol.TypeSessionStdout || r2.Seq != 1 {
			t.Fatalf("resume replay %s: %+v err=%v", s.SessionID, r2, err)
		}
	}

	for _, s := range sessions {
		_ = ws2.WriteJSON(protocol.Frame{Ch: s.Channel, Type: protocol.TypeSessionKill})
	}
}
