package mail

import (
	"context"
	"errors"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestBuildMessage(t *testing.T) {
	s, err := NewSMTPSender(SMTPConfig{From: "FUDISLTE <fudislte@example.com>"})
	if err != nil {
		t.Fatal(err)
	}
	raw, err := s.build(Message{To: "dana@example.com", Subject: "Kodunuz: giriş", Body: "Line one\nCode 1234 5678\n"}, time.Unix(0, 0))
	if err != nil {
		t.Fatal(err)
	}
	msg := string(raw)
	for _, want := range []string{
		"From: \"FUDISLTE\" <fudislte@example.com>\r\n",
		"To: <dana@example.com>\r\n",
		"Subject: =?utf-8?q?Kodunuz:_giri=C5=9F?=\r\n",
		"Content-Transfer-Encoding: quoted-printable\r\n",
		"@example.com>\r\n",
		"\r\n\r\nLine one\r\nCode 1234 5678\r\n",
	} {
		if !strings.Contains(msg, want) {
			t.Errorf("message missing %q:\n%s", want, msg)
		}
	}
}

func TestBuildRejectsHeaderInjection(t *testing.T) {
	s, _ := NewSMTPSender(SMTPConfig{From: "fudislte@example.com"})
	for _, m := range []Message{
		{To: "a@example.com\r\nBcc: victim@example.com", Subject: "x"},
		{To: "a@example.com", Subject: "x\r\nBcc: victim@example.com"},
	} {
		if _, err := s.build(m, time.Now()); err == nil {
			t.Errorf("expected rejection of %+v", m)
		}
	}
}

type countingSender struct{ n atomic.Int32 }

func (c *countingSender) Send(context.Context, Message) error { c.n.Add(1); return nil }

func TestOutboxSendsComposedMessagesAndSkipsNil(t *testing.T) {
	s := &countingSender{}
	o := NewOutbox(s)
	o.Enqueue(func(context.Context) (*Message, error) { return &Message{To: "a@example.com"}, nil })
	o.Enqueue(func(context.Context) (*Message, error) { return nil, nil })
	o.Enqueue(func(context.Context) (*Message, error) { return nil, errors.New("boom") })
	o.Wait(context.Background())
	if got := s.n.Load(); got != 1 {
		t.Fatalf("sent %d messages, want 1", got)
	}
}

func TestFormatCode(t *testing.T) {
	if got := FormatCode("12345678"); got != "1234 5678" {
		t.Fatalf("got %q", got)
	}
}
