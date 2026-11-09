package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

// defaultCookie is the session cookie of an API running with FUDISLTE_COOKIE_SECURE=false;
// with secure cookies it is "__Host-fudislte_session".
const defaultCookie = "fudislte_session"

// client sends JSON requests to the API, authenticated by a session cookie.
type client struct {
	base   string
	cookie string
	hc     *http.Client
	// retry429 retries rate-limited requests (populate); the load test counts them instead.
	retry429 bool
}

func newClient(base, cookie string, timeout time.Duration, maxConns int) *client {
	tr := &http.Transport{
		Proxy:               nil, // never send test traffic through a proxy from the environment
		MaxIdleConns:        maxConns,
		MaxIdleConnsPerHost: maxConns,
		IdleConnTimeout:     90 * time.Second,
		DisableCompression:  true,
	}
	return &client{base: strings.TrimRight(base, "/"), cookie: cookie, hc: &http.Client{Transport: tr, Timeout: timeout}}
}

// apiError is a response with a status code of 300 or more.
type apiError struct {
	Method, Path string
	Status       int
	Body         string
}

func (e *apiError) Error() string {
	return fmt.Sprintf("%s %s: HTTP %d: %s", e.Method, e.Path, e.Status, e.Body)
}

func statusOf(err error) int {
	var ae *apiError
	if errors.As(err, &ae) {
		return ae.Status
	}
	return 0
}

// send performs one request and returns the response with its body read.
func (c *client) send(ctx context.Context, method, path, token, contentType string, body []byte) (*http.Response, []byte, error) {
	for attempt := 0; ; attempt++ {
		var rd io.Reader
		if body != nil {
			rd = bytes.NewReader(body)
		}
		req, err := http.NewRequestWithContext(ctx, method, c.base+path, rd)
		if err != nil {
			return nil, nil, err
		}
		if contentType != "" {
			req.Header.Set("Content-Type", contentType)
		}
		req.Header.Set("Accept", "application/json")
		req.Header.Set("Accept-Language", "en")
		req.Header.Set("User-Agent", "fudislte-loadtest")
		if token != "" {
			req.AddCookie(&http.Cookie{Name: c.cookie, Value: token})
		}
		resp, err := c.hc.Do(req)
		if err != nil {
			return nil, nil, err
		}
		data, err := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
		resp.Body.Close()
		if err != nil {
			return nil, nil, err
		}
		if resp.StatusCode == http.StatusTooManyRequests && c.retry429 && attempt < 20 {
			select {
			case <-time.After(time.Duration(250*(attempt+1)) * time.Millisecond):
				continue
			case <-ctx.Done():
				return nil, nil, ctx.Err()
			}
		}
		if resp.StatusCode >= 300 {
			msg := strings.TrimSpace(string(data))
			if len(msg) > 300 {
				msg = msg[:300] + "…"
			}
			return resp, data, &apiError{Method: method, Path: path, Status: resp.StatusCode, Body: msg}
		}
		return resp, data, nil
	}
}

// json sends in (if not nil) as JSON and decodes the response into out (if not nil).
func (c *client) json(ctx context.Context, method, path, token string, in, out any) error {
	var body []byte
	ct := ""
	if in != nil {
		var err error
		if body, err = json.Marshal(in); err != nil {
			return err
		}
		ct = "application/json"
	}
	_, data, err := c.send(ctx, method, path, token, ct, body)
	if err != nil {
		return err
	}
	if out != nil && len(data) > 0 {
		if err := json.Unmarshal(data, out); err != nil {
			return fmt.Errorf("%s %s: decode response: %w", method, path, err)
		}
	}
	return nil
}

// account is one signed-in user of an accounts file.
type account struct {
	UserID, Email, Token string
}

func readAccounts(path string) ([]account, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var out []account
	sc := bufio.NewScanner(f)
	for line := 1; sc.Scan(); line++ {
		text := strings.TrimSpace(sc.Text())
		if text == "" || strings.HasPrefix(text, "#") {
			continue
		}
		parts := strings.Split(text, "\t")
		if len(parts) != 3 || parts[0] == "" || parts[2] == "" {
			return nil, fmt.Errorf("%s:%d: expected <user-id> TAB <email> TAB <token>", path, line)
		}
		out = append(out, account{UserID: parts[0], Email: parts[1], Token: parts[2]})
	}
	return out, sc.Err()
}

// writeAccounts writes (or appends) accounts to a file only the owner can read.
func writeAccounts(path string, accs []account, appendTo bool) error {
	flags := os.O_WRONLY | os.O_CREATE | os.O_TRUNC
	if appendTo {
		flags = os.O_WRONLY | os.O_CREATE | os.O_APPEND
	}
	f, err := os.OpenFile(path, flags, 0o600)
	if err != nil {
		return err
	}
	w := bufio.NewWriter(f)
	for _, a := range accs {
		fmt.Fprintf(w, "%s\t%s\t%s\n", a.UserID, a.Email, a.Token)
	}
	if err := w.Flush(); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

// newUUIDv7 returns a time-ordered UUID, the kind the API generates for its own rows.
func newUUIDv7() string {
	var b [16]byte
	ms := uint64(time.Now().UnixMilli())
	for i := 0; i < 6; i++ {
		b[i] = byte(ms >> (40 - 8*i))
	}
	_, _ = rand.Read(b[6:])
	b[6] = b[6]&0x0f | 0x70
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// newSessionToken mirrors auth.NewToken in the API: 256 random bits, base64url without
// padding, of which only the SHA-256 is stored in sessions.token_hash.
func newSessionToken() (token, hashHex string) {
	b := make([]byte, 32)
	_, _ = rand.Read(b)
	token = base64.RawURLEncoding.EncodeToString(b)
	sum := sha256.Sum256([]byte(token))
	return token, hex.EncodeToString(sum[:])
}

func randomHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func requireEnv(name string) (string, error) {
	v := os.Getenv(name)
	if v == "" {
		return "", fmt.Errorf("%s is not set", name)
	}
	return v, nil
}
