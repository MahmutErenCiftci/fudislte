// Package mailtest provides an in-memory mail.Sender for tests.
package mailtest

import (
	"context"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"fudislte/api/internal/mail"
)

type Recorder struct {
	mu   sync.Mutex
	msgs []mail.Message
}

func (r *Recorder) Send(_ context.Context, m mail.Message) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.msgs = append(r.msgs, m)
	return nil
}

func (r *Recorder) take(to, kind string) (mail.Message, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for i, m := range r.msgs {
		if m.To == to && m.Kind == kind {
			r.msgs = append(r.msgs[:i], r.msgs[i+1:]...)
			return m, true
		}
	}
	return mail.Message{}, false
}

// Next waits for, removes and returns the first message of kind sent to to.
func (r *Recorder) Next(t testing.TB, to, kind string) mail.Message {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if m, ok := r.take(to, kind); ok {
			return m
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("no %s email to %s", kind, to)
	return mail.Message{}
}

// None asserts that no message of kind reaches to within wait.
func (r *Recorder) None(t testing.TB, to, kind string, wait time.Duration) {
	t.Helper()
	time.Sleep(wait)
	if m, ok := r.take(to, kind); ok {
		t.Fatalf("unexpected %s email to %s: %q", kind, to, m.Subject)
	}
}

var codePattern = regexp.MustCompile(`\b(\d{4}) (\d{4})\b`)

// Code extracts the one-time code from a code email.
func Code(t testing.TB, m mail.Message) string {
	t.Helper()
	match := codePattern.FindStringSubmatch(m.Body)
	if match == nil {
		t.Fatalf("no code in email body: %q", m.Body)
	}
	return strings.Join(match[1:], "")
}
