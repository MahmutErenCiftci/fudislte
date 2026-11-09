package httpx

import (
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestIPResolverIgnoresForwardedHeaderFromUntrustedPeer(t *testing.T) {
	res := NewIPResolver([]netip.Prefix{netip.MustParsePrefix("10.0.0.0/8")})
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.RemoteAddr = "203.0.113.7:5000"
	r.Header.Set("X-Forwarded-For", "1.2.3.4")
	if got := res.Resolve(r); got.String() != "203.0.113.7" {
		t.Fatalf("got %v, want the direct peer", got)
	}
}

func TestIPResolverWalksTrustedProxies(t *testing.T) {
	res := NewIPResolver([]netip.Prefix{netip.MustParsePrefix("10.0.0.0/8")})
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.RemoteAddr = "10.0.0.2:5000"
	// The left-most entry is client supplied and must not win.
	r.Header.Set("X-Forwarded-For", "6.6.6.6, 198.51.100.9, 10.0.0.3")
	if got := res.Resolve(r); got.String() != "198.51.100.9" {
		t.Fatalf("got %v, want 198.51.100.9", got)
	}
}

func TestLimiter(t *testing.T) {
	l := NewLimiter(time.Hour, 2)
	if !l.Allow("a") || !l.Allow("a") {
		t.Fatal("burst should be allowed")
	}
	if l.Allow("a") {
		t.Fatal("third event should be limited")
	}
	if !l.Allow("b") {
		t.Fatal("keys must be independent")
	}
}

func TestLimiterStaysBounded(t *testing.T) {
	l := NewLimiter(time.Hour, 1)
	for i := range maxBuckets + 5_000 {
		l.Allow(strconv.Itoa(i))
	}
	if n := len(l.buckets); n > maxBuckets {
		t.Fatalf("%d buckets, want at most %d", n, maxBuckets)
	}
}

func TestRateKeyGroupsIPv6Networks(t *testing.T) {
	for addr, want := range map[string]string{
		"203.0.113.7":          "203.0.113.7",
		"2001:db8:1:2:aaaa::1": "2001:db8:1:2::/64",
		"2001:db8:1:2:bbbb::9": "2001:db8:1:2::/64",
		"::ffff:198.51.100.1":  "::ffff:198.51.100.1",
		"2001:db8:1:3::1":      "2001:db8:1:3::/64",
	} {
		if got := RateKey(netip.MustParseAddr(addr)); got != want {
			t.Errorf("RateKey(%s) = %s, want %s", addr, got, want)
		}
	}
}

func TestDecodeJSONRejectsUnknownFieldsAndTrailingData(t *testing.T) {
	var dst struct {
		Name string `json:"name"`
	}
	for _, body := range []string{`{"name":"a","admin":true}`, `{"name":"a"} {}`, `not json`} {
		r := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body))
		err := DecodeJSON(httptest.NewRecorder(), r, &dst)
		if err == nil {
			t.Errorf("body %q: expected an error", body)
		}
	}
}
