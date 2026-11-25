package ringbuf

import (
	"sync"

	"github.com/jd04063221/agent-remote/apps/remote-node/internal/protocol"
)

// EventRing stores the most recent capacity frames with strictly increasing sequence numbers,
// allowing reconnecting local hubs to replay missed session output seamlessly.
type EventRing struct {
	mu       sync.RWMutex
	capacity int
	items    []protocol.Frame
	nextSeq  uint64
}

func New(capacity int) *EventRing {
	if capacity <= 0 {
		capacity = 2000
	}
	return &EventRing{
		capacity: capacity,
		items:    make([]protocol.Frame, 0, capacity),
		nextSeq:  1,
	}
}

func (r *EventRing) Append(frame protocol.Frame) protocol.Frame {
	r.mu.Lock()
	defer r.mu.Unlock()

	frame.Seq = r.nextSeq
	r.nextSeq++

	if len(r.items) < r.capacity {
		r.items = append(r.items, frame)
	} else {
		copy(r.items, r.items[1:])
		r.items[len(r.items)-1] = frame
	}
	return frame
}

func (r *EventRing) ReplayAfter(lastAckSeq uint64) []protocol.Frame {
	r.mu.RLock()
	defer r.mu.RUnlock()

	out := make([]protocol.Frame, 0, len(r.items))
	for _, f := range r.items {
		if f.Seq > lastAckSeq {
			out = append(out, f)
		}
	}
	return out
}

func (r *EventRing) LatestSeq() uint64 {
	r.mu.RLock()
	defer r.mu.RUnlock()
	if r.nextSeq == 0 {
		return 0
	}
	return r.nextSeq - 1
}
