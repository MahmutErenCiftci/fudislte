package mail

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"mime"
	"mime/quotedprintable"
	"net"
	"net/mail"
	"net/smtp"
	"strconv"
	"strings"
	"time"
)

type SMTPConfig struct {
	Host     string
	Port     int
	Username string
	Password string
	// TLS is "starttls", "tls" (implicit) or "none".
	TLS  string
	From string
}

type SMTPSender struct {
	cfg  SMTPConfig
	from *mail.Address
	// rootCAs overrides the system certificate pool; tests only.
	rootCAs *x509.CertPool
}

func NewSMTPSender(cfg SMTPConfig) (*SMTPSender, error) {
	from, err := mail.ParseAddress(cfg.From)
	if err != nil {
		return nil, fmt.Errorf("invalid sender address: %w", err)
	}
	return &SMTPSender{cfg: cfg, from: from}, nil
}

func (s *SMTPSender) Send(ctx context.Context, m Message) error {
	body, err := s.build(m, time.Now())
	if err != nil {
		return err
	}
	addr := net.JoinHostPort(s.cfg.Host, strconv.Itoa(s.cfg.Port))
	tlsConfig := &tls.Config{ServerName: s.cfg.Host, MinVersion: tls.VersionTLS12, RootCAs: s.rootCAs}
	dialer := &net.Dialer{Timeout: 10 * time.Second}

	var conn net.Conn
	if s.cfg.TLS == "tls" {
		conn, err = (&tls.Dialer{NetDialer: dialer, Config: tlsConfig}).DialContext(ctx, "tcp", addr)
	} else {
		conn, err = dialer.DialContext(ctx, "tcp", addr)
	}
	if err != nil {
		return fmt.Errorf("connect to SMTP server: %w", err)
	}
	if deadline, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(deadline)
	}
	c, err := smtp.NewClient(conn, s.cfg.Host)
	if err != nil {
		conn.Close()
		return fmt.Errorf("SMTP handshake: %w", err)
	}
	defer c.Close()

	if s.cfg.TLS == "starttls" {
		if ok, _ := c.Extension("STARTTLS"); !ok {
			return errors.New("SMTP server does not offer STARTTLS; set FUDISLTE_SMTP_TLS=tls or configure the server")
		}
		if err := c.StartTLS(tlsConfig); err != nil {
			return fmt.Errorf("STARTTLS: %w", err)
		}
	}
	if s.cfg.Username != "" {
		if err := c.Auth(smtp.PlainAuth("", s.cfg.Username, s.cfg.Password, s.cfg.Host)); err != nil {
			return fmt.Errorf("SMTP authentication: %w", err)
		}
	}
	if err := c.Mail(s.from.Address); err != nil {
		return fmt.Errorf("SMTP MAIL FROM: %w", err)
	}
	if err := c.Rcpt(m.To); err != nil {
		return fmt.Errorf("SMTP RCPT TO: %w", err)
	}
	w, err := c.Data()
	if err != nil {
		return fmt.Errorf("SMTP DATA: %w", err)
	}
	if _, err := w.Write(body); err != nil {
		return err
	}
	if err := w.Close(); err != nil {
		return fmt.Errorf("SMTP message rejected: %w", err)
	}
	return c.Quit()
}

// build renders a UTF-8 message: plain text, or multipart/alternative with an HTML
// version; each part is quoted-printable. With attachments, the text is the first part
// of a multipart/mixed message and each attachment follows, base64-encoded.
func (s *SMTPSender) build(m Message, now time.Time) ([]byte, error) {
	if strings.ContainsAny(m.To, "\r\n") || strings.ContainsAny(m.Subject, "\r\n") {
		return nil, errors.New("header values must not contain line breaks")
	}
	for _, a := range m.Attachments {
		if a.Name == "" || strings.ContainsAny(a.Name, "\r\n\"\\") || strings.ContainsAny(a.ContentType, "\r\n") {
			return nil, errors.New("attachment names and types must be single-line values")
		}
	}
	to, err := mail.ParseAddress(m.To)
	if err != nil {
		return nil, fmt.Errorf("invalid recipient: %w", err)
	}
	id := make([]byte, 12)
	_, _ = rand.Read(id)
	domain := s.from.Address[strings.LastIndexByte(s.from.Address, '@')+1:]

	var b bytes.Buffer
	header := func(k, v string) { fmt.Fprintf(&b, "%s: %s\r\n", k, v) }
	header("From", s.from.String())
	header("To", to.String())
	header("Subject", mime.QEncoding.Encode("utf-8", m.Subject))
	header("Date", now.Format(time.RFC1123Z))
	header("Message-ID", fmt.Sprintf("<%s@%s>", hex.EncodeToString(id), domain))
	header("MIME-Version", "1.0")
	header("Auto-Submitted", "auto-generated")
	boundary := "fudislte-" + hex.EncodeToString(id)
	if len(m.Attachments) == 0 {
		if err := writeText(&b, m, boundary); err != nil {
			return nil, err
		}
		return b.Bytes(), nil
	}
	mixed := "fudislte-mixed-" + hex.EncodeToString(id)
	header("Content-Type", fmt.Sprintf(`multipart/mixed; boundary="%s"`, mixed))
	fmt.Fprintf(&b, "\r\n--%s\r\n", mixed)
	if err := writeText(&b, m, boundary); err != nil {
		return nil, err
	}
	for _, a := range m.Attachments {
		fmt.Fprintf(&b, "\r\n--%s\r\nContent-Type: %s; name=\"%s\"\r\nContent-Disposition: attachment; filename=\"%s\"\r\nContent-Transfer-Encoding: base64\r\n\r\n",
			mixed, a.ContentType, a.Name, a.Name)
		writeBase64(&b, a.Data)
	}
	fmt.Fprintf(&b, "\r\n--%s--\r\n", mixed)
	return b.Bytes(), nil
}

// writeText appends the message text as a MIME entity — its content headers, a blank
// line and the body: plain text, or multipart/alternative with the HTML version.
func writeText(b *bytes.Buffer, m Message, boundary string) error {
	if m.HTML == "" {
		b.WriteString("Content-Type: text/plain; charset=\"utf-8\"\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n")
		return writeQP(b, m.Body)
	}
	fmt.Fprintf(b, "Content-Type: multipart/alternative; boundary=\"%s\"\r\n\r\n", boundary)
	for _, part := range []struct{ kind, body string }{{"text/plain", m.Body}, {"text/html", m.HTML}} {
		fmt.Fprintf(b, "--%s\r\nContent-Type: %s; charset=\"utf-8\"\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n", boundary, part.kind)
		if err := writeQP(b, part.body); err != nil {
			return err
		}
		b.WriteString("\r\n")
	}
	fmt.Fprintf(b, "--%s--\r\n", boundary)
	return nil
}

// writeBase64 appends data base64-encoded in lines of 76 characters (RFC 2045).
func writeBase64(b *bytes.Buffer, data []byte) {
	enc := base64.StdEncoding.EncodeToString(data)
	for len(enc) > 76 {
		b.WriteString(enc[:76] + "\r\n")
		enc = enc[76:]
	}
	b.WriteString(enc)
}

// writeQP appends s, with CRLF line endings, quoted-printable encoded.
func writeQP(b *bytes.Buffer, s string) error {
	qp := quotedprintable.NewWriter(b)
	body := strings.ReplaceAll(strings.ReplaceAll(s, "\r\n", "\n"), "\n", "\r\n")
	if _, err := qp.Write([]byte(body)); err != nil {
		return err
	}
	return qp.Close()
}
