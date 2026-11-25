package ringbuf

import (
	"testing"

	"github.com/jd04063221/agent-remote/apps/remote-node/internal/protocol"
)

func TestEventRingReplayAndEviction(t *testing.T) {
	ring := New(3)
	for i := 0; i < 5; i++ {
		f := ring.Append(protocol.Frame{Ch: 1, Type: protocol.TypeSessionStdout})
		if f.Seq != uint64(i+1) {
			t.Fatalf("expected seq %d, got %d", i+1, f.Seq)
		}
	}

	if ring.LatestSeq() != 5 {
		t.Fatalf("expected latest seq 5, got %d", ring.LatestSeq())
	}

	// Only last 3 (seq 3, 4, 5) are retained
	replayed := ring.ReplayAfter(2)
	if len(replayed) != 3 || replayed[0].Seq != 3 || replayed[2].Seq != 5 {
		t.Fatalf("unexpected replay after 2: %+v", replayed)
	}

	replayed = ring.ReplayAfter(4)
	if len(replayed) != 1 || replayed[0].Seq != 5 {
		t.Fatalf("unexpected replay after 4: %+v", replayed)
	}
}
