// Package mail delivers transactional email: sign-in codes, invitations and meeting
// invitations with their calendar files.
package mail

import (
	"context"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"
)

type Message struct {
	To      string
	Subject string
	// Body is the plain-text version; HTML, when set, is sent alongside it.
	Body string
	HTML string
	// Attachments follow the text, e.g. a meeting's calendar file.
	Attachments []Attachment
	// Kind labels the message in logs and tests ("login_code", "invitation", …).
	// It is not sent.
	Kind string
}

// Attachment is a file sent with a message.
type Attachment struct {
	// Name is the file name shown to the recipient, e.g. "invite.ics".
	Name string
	// ContentType is the media type with its parameters, e.g.
	// `text/calendar; charset="utf-8"; method=REQUEST`.
	ContentType string
	Data        []byte
}

type Sender interface {
	Send(ctx context.Context, m Message) error
}

// LogSender writes messages to the log instead of delivering them. Configuration only
// allows it in development; codes appear in the log.
type LogSender struct{}

func (LogSender) Send(ctx context.Context, m Message) error {
	slog.WarnContext(ctx, "development email (not delivered)", "to", m.To, "subject", m.Subject, "body", m.Body, "attachments", len(m.Attachments))
	return nil
}

const (
	sendTimeout = 30 * time.Second
	// At most this many messages are prepared and sent at once: mail relays throttle
	// bursts (a meeting with 200 invitees), and composing a message may query the
	// database.
	concurrentSends = 4
	// Beyond this many waiting messages new ones are dropped, so a flood of sign-in
	// requests cannot pile up without limit.
	maxPending = 1000
)

// Outbox sends email in the background. Request handlers enqueue work and respond
// immediately, so response times never reveal whether an address is registered.
type Outbox struct {
	sender  Sender
	wg      sync.WaitGroup
	slots   chan struct{}
	pending atomic.Int64
}

func NewOutbox(sender Sender) *Outbox {
	return &Outbox{sender: sender, slots: make(chan struct{}, concurrentSends)}
}

// Enqueue runs compose in the background and sends the message it returns. compose
// may return nil to send nothing.
func (o *Outbox) Enqueue(compose func(ctx context.Context) (*Message, error)) {
	if o.pending.Add(1) > maxPending {
		o.pending.Add(-1)
		slog.Error("email queue full; message dropped")
		return
	}
	o.wg.Add(1)
	go func() {
		defer o.wg.Done()
		defer o.pending.Add(-1)
		o.slots <- struct{}{}
		defer func() { <-o.slots }()
		ctx, cancel := context.WithTimeout(context.Background(), sendTimeout)
		defer cancel()
		m, err := compose(ctx)
		if err != nil {
			slog.ErrorContext(ctx, "preparing email failed", "error", err)
			return
		}
		if m == nil {
			return
		}
		if err := o.sender.Send(ctx, *m); err != nil {
			slog.ErrorContext(ctx, "sending email failed", "kind", m.Kind, "to", m.To, "error", err)
		}
	}()
}

// SendNow delivers synchronously, for flows that must report delivery problems.
func (o *Outbox) SendNow(ctx context.Context, m Message) error {
	ctx, cancel := context.WithTimeout(ctx, sendTimeout)
	defer cancel()
	return o.sender.Send(ctx, m)
}

// Wait blocks until background sends finish or ctx ends (graceful shutdown).
func (o *Outbox) Wait(ctx context.Context) {
	done := make(chan struct{})
	go func() {
		o.wg.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-ctx.Done():
	}
}
