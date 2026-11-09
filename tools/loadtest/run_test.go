package main

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestPercentile(t *testing.T) {
	samples := make([]int64, 100)
	for i := range samples {
		samples[i] = int64(100-i) * 1e6 // 100 ms … 1 ms, unsorted
	}
	s := summarize(samples)
	if s.P50 != 50 || s.P95 != 95 || s.P99 != 99 || s.Max != 100 || s.Count != 100 {
		t.Fatalf("unexpected summary %+v", s)
	}
	if got := summarize([]int64{7e6}); got.P50 != 7 || got.P99 != 7 {
		t.Fatalf("single sample: %+v", got)
	}
}

func TestSeqOf(t *testing.T) {
	r := &runner{tag: "lt abcd1234 ", total: 10}
	for body, want := range map[string]int{"lt abcd1234 3 xxxx": 3, "lt abcd1234 9": 9} {
		if got, ok := r.seqOf(body); !ok || got != want {
			t.Errorf("seqOf(%q) = %d, %v", body, got, ok)
		}
	}
	for _, body := range []string{"lt other 3 x", "lt abcd1234 10 x", "lt abcd1234 -1 x", "hello"} {
		if _, ok := r.seqOf(body); ok {
			t.Errorf("seqOf(%q) accepted", body)
		}
	}
}

// TestStreamParsing serves an event stream shaped like realtime.Hub's and checks what one
// stream counts: its own echo, a delivery, a duplicate, foreign traffic and the heartbeat.
func TestStreamParsing(t *testing.T) {
	r := &runner{tag: "lt run1 ", total: 4}
	r.sent = make([]atomic.Int64, r.total)
	r.ok = make([]atomic.Bool, r.total)
	r.delivered = make([]atomic.Int32, r.total)
	r.slowest = make([]atomic.Int64, r.total)
	r.start = time.Now().Add(-time.Second)
	r.sent[1].Store(1) // message 1 was sent right at the start
	r.sent[2].Store(1)

	msg := func(seq int, author string) string {
		return fmt.Sprintf("event: message.created\ndata: {\"orgId\":\"o\",\"channelId\":\"c\",\"message\":{\"id\":\"m%d\",\"author\":{\"id\":%q,\"displayName\":\"x\"},\"body\":\"lt run1 %d xx\"}}\n\n", seq, author, seq)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if c, err := req.Cookie(defaultCookie); err != nil || c.Value != "tok" {
			http.Error(w, "no session", http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "retry: 3000\nevent: ready\ndata: {\"connectionId\":\"x\"}\n\n")
		fmt.Fprint(w, ": ping\n\n")
		fmt.Fprint(w, msg(1, "other"))
		fmt.Fprint(w, msg(1, "other")) // duplicate
		fmt.Fprint(w, msg(2, "me"))    // the stream owner's own message
		fmt.Fprint(w, "event: presence.changed\ndata: {\"userId\":\"u\",\"state\":\"online\"}\n\n")
		fmt.Fprint(w, strings.Replace(msg(3, "other"), "lt run1", "lt run2", 1)) // another run
	}))
	defer srv.Close()

	r.opt.base, r.opt.cookie = srv.URL, defaultCookie
	r.sse = srv.Client()
	s := &stream{acc: account{UserID: "me", Token: "tok"}, events: map[string]int{}, seen: make([]uint64, 1)}
	connected, err := r.consume(context.Background(), s, time.Now())
	if !connected || err == nil || !strings.Contains(err.Error(), "EOF") {
		t.Fatalf("consume = %v, %v; want connected and EOF", connected, err)
	}
	switch {
	case !s.ready || r.readyCount.Load() != 1:
		t.Error("ready event not counted")
	case len(s.latencies) != 1 || r.delivered[1].Load() != 1 || r.deliveredTotal.Load() != 1:
		t.Errorf("deliveries: latencies %v, delivered[1] %d", s.latencies, r.delivered[1].Load())
	case s.duplicates != 1 || s.selfEchoes != 1 || s.foreign != 1:
		t.Errorf("duplicates %d, self %d, foreign %d", s.duplicates, s.selfEchoes, s.foreign)
	case s.events["presence.changed"] != 1 || s.events["message.created"] != 4:
		t.Errorf("events %v", s.events)
	case r.slowest[1].Load() <= 0:
		t.Error("slowest delivery not recorded")
	}
}
