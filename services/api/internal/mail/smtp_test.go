package mail

import (
	"bufio"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"math/big"
	"net"
	"net/netip"
	"strings"
	"sync"
	"testing"
	"time"

	"fudislte/api/internal/i18n"
)

// fakeSMTP is a minimal SMTP server that records one conversation. It speaks enough of
// RFC 5321 (EHLO, STARTTLS, AUTH PLAIN, MAIL, RCPT, DATA, QUIT) to exercise the client.
type fakeSMTP struct {
	addr      string
	cert      tls.Certificate
	startTLS  bool
	mu        sync.Mutex
	tlsActive bool
	authPlain string
	authInTLS bool
	mailFrom  string
	rcptTo    string
	data      string
}

func newFakeSMTP(t *testing.T, startTLS bool) (*fakeSMTP, *x509.CertPool) {
	t.Helper()
	cert, pool := selfSignedCert(t)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	s := &fakeSMTP{addr: ln.Addr().String(), cert: cert, startTLS: startTLS}
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		s.serve(conn)
	}()
	return s, pool
}

func (s *fakeSMTP) serve(conn net.Conn) {
	defer conn.Close()
	r := bufio.NewReader(conn)
	reply := func(line string) { _, _ = conn.Write([]byte(line + "\r\n")) }
	reply("220 fake ESMTP")
	for {
		line, err := r.ReadString('\n')
		if err != nil {
			return
		}
		line = strings.TrimRight(line, "\r\n")
		cmd := strings.ToUpper(strings.SplitN(line, " ", 2)[0])
		s.mu.Lock()
		switch cmd {
		case "EHLO", "HELO":
			if s.startTLS && !s.tlsActive {
				reply("250-fake\r\n250-STARTTLS\r\n250 8BITMIME")
			} else {
				reply("250-fake\r\n250-AUTH PLAIN\r\n250 8BITMIME")
			}
		case "STARTTLS":
			reply("220 go ahead")
			tlsConn := tls.Server(conn, &tls.Config{Certificates: []tls.Certificate{s.cert}})
			if err := tlsConn.Handshake(); err != nil {
				s.mu.Unlock()
				return
			}
			conn, r, s.tlsActive = tlsConn, bufio.NewReader(tlsConn), true
		case "AUTH":
			s.authPlain, s.authInTLS = strings.TrimPrefix(line, "AUTH PLAIN "), s.tlsActive
			reply("235 authenticated")
		case "MAIL":
			s.mailFrom = line
			reply("250 ok")
		case "RCPT":
			s.rcptTo = line
			reply("250 ok")
		case "DATA":
			reply("354 send data")
			var b strings.Builder
			for {
				l, err := r.ReadString('\n')
				if err != nil || l == ".\r\n" {
					break
				}
				b.WriteString(l)
			}
			s.data = b.String()
			reply("250 queued")
		case "QUIT":
			reply("221 bye")
			s.mu.Unlock()
			return
		default:
			reply("502 not implemented")
		}
		s.mu.Unlock()
	}
}

func selfSignedCert(t *testing.T) (tls.Certificate, *x509.CertPool) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "fake smtp"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(time.Hour),
		IPAddresses:           []net.IP{net.ParseIP("127.0.0.1")},
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
		IsCA:                  true,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	leaf, _ := x509.ParseCertificate(der)
	pool := x509.NewCertPool()
	pool.AddCert(leaf)
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key, Leaf: leaf}, pool
}

func senderFor(t *testing.T, addr, mode string, pool *x509.CertPool) *SMTPSender {
	t.Helper()
	ap := netip.MustParseAddrPort(addr)
	s, err := NewSMTPSender(SMTPConfig{
		Host: ap.Addr().String(), Port: int(ap.Port()), Username: "fudislte@example.com", Password: "s3cret",
		TLS: mode, From: "FUDISLTE <fudislte@example.com>",
	})
	if err != nil {
		t.Fatal(err)
	}
	s.rootCAs = pool
	return s
}

func TestSMTPSendWithSTARTTLSAndAuth(t *testing.T) {
	srv, pool := newFakeSMTP(t, true)
	s := senderFor(t, srv.addr, "starttls", pool)
	if err := s.Send(context.Background(), LoginCode(i18n.English, "dana@example.com", "12345678", "https://fudislte.example.com")); err != nil {
		t.Fatalf("send: %v", err)
	}
	srv.mu.Lock()
	defer srv.mu.Unlock()
	if !srv.authInTLS {
		t.Fatal("credentials were sent before TLS was established")
	}
	creds, _ := base64.StdEncoding.DecodeString(srv.authPlain)
	if string(creds) != "\x00fudislte@example.com\x00s3cret" {
		t.Fatalf("unexpected AUTH PLAIN payload %q", creds)
	}
	if srv.mailFrom != "MAIL FROM:<fudislte@example.com> BODY=8BITMIME" && srv.mailFrom != "MAIL FROM:<fudislte@example.com>" {
		t.Fatalf("MAIL FROM = %q", srv.mailFrom)
	}
	if srv.rcptTo != "RCPT TO:<dana@example.com>" {
		t.Fatalf("RCPT TO = %q", srv.rcptTo)
	}
	for _, want := range []string{"Subject: Your FUDISLTE sign-in code\r\n", "1234 5678"} {
		if !strings.Contains(srv.data, want) {
			t.Errorf("message lacks %q:\n%s", want, srv.data)
		}
	}
}

func TestSMTPRefusesServerWithoutSTARTTLS(t *testing.T) {
	srv, pool := newFakeSMTP(t, false)
	s := senderFor(t, srv.addr, "starttls", pool)
	err := s.Send(context.Background(), LoginCode(i18n.English, "dana@example.com", "12345678", "https://fudislte.example.com"))
	if err == nil || !strings.Contains(err.Error(), "STARTTLS") {
		t.Fatalf("expected a STARTTLS error, got %v", err)
	}
	srv.mu.Lock()
	defer srv.mu.Unlock()
	if srv.authPlain != "" || srv.data != "" {
		t.Fatal("credentials or message were sent over an unencrypted connection")
	}
}

func TestSMTPRejectsUntrustedCertificate(t *testing.T) {
	srv, _ := newFakeSMTP(t, true)
	s := senderFor(t, srv.addr, "starttls", nil) // system roots do not trust the test CA
	if err := s.Send(context.Background(), LoginCode(i18n.English, "dana@example.com", "12345678", "https://fudislte.example.com")); err == nil {
		t.Fatal("expected a certificate verification error")
	}
}
