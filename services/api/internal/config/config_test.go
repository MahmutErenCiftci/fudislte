package config

import (
	"net/netip"
	"testing"
	"time"
)

func env(m map[string]string) func(string) string {
	return func(k string) string { return m[k] }
}

var productionMinimum = map[string]string{
	"FUDISLTE_DATABASE_URL": "postgres://x",
	"FUDISLTE_PUBLIC_URL":   "https://fudislte.example.com/",
	"FUDISLTE_SMTP_HOST":    "smtp.example.com",
	"FUDISLTE_SMTP_FROM":    "FUDISLTE <fudislte@example.com>",
}

func TestLoadDefaults(t *testing.T) {
	c, err := load(env(productionMinimum))
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if c.Env != "production" || c.PublicURL != "https://fudislte.example.com" {
		t.Fatalf("unexpected env/public url: %q %q", c.Env, c.PublicURL)
	}
	if c.Mail.Transport != "smtp" || c.Mail.SMTPPort != 587 || c.Mail.SMTPTLS != "starttls" {
		t.Fatalf("unexpected mail defaults: %+v", c.Mail)
	}
	if c.HTTPAddr != ":8080" || !c.CookieSecure || !c.MigrateOnStart {
		t.Fatalf("unexpected defaults: %+v", c)
	}
	if c.SessionIdleTTL != 7*24*time.Hour {
		t.Fatalf("unexpected session idle default: %v", c.SessionIdleTTL)
	}
}

func TestLoadRejectsInvalidValues(t *testing.T) {
	_, err := load(env(map[string]string{
		"FUDISLTE_COOKIE_SECURE":    "maybe",
		"FUDISLTE_SETUP_TOKEN":      "short",
		"FUDISLTE_SESSION_IDLE_TTL": "-1h",
		"FUDISLTE_TRUSTED_PROXIES":  "10.0.0.0/8,not-an-ip",
		"FUDISLTE_LOG_FORMAT":       "xml",
		"FUDISLTE_REGISTRY_URL":     "http://registry.example.com",
	}))
	if err == nil {
		t.Fatal("expected an error")
	}
	for _, want := range []string{"FUDISLTE_DATABASE_URL", "FUDISLTE_COOKIE_SECURE", "FUDISLTE_SETUP_TOKEN", "FUDISLTE_SESSION_IDLE_TTL", "FUDISLTE_TRUSTED_PROXIES", "FUDISLTE_LOG_FORMAT", "FUDISLTE_REGISTRY_URL"} {
		if !contains(err.Error(), want) {
			t.Errorf("error %q does not mention %s", err, want)
		}
	}
}

func TestProductionRequiresMailAndHTTPS(t *testing.T) {
	_, err := load(env(map[string]string{
		"FUDISLTE_DATABASE_URL":   "postgres://x",
		"FUDISLTE_PUBLIC_URL":     "http://fudislte.example.com",
		"FUDISLTE_MAIL_TRANSPORT": "log",
	}))
	if err == nil {
		t.Fatal("expected an error")
	}
	for _, want := range []string{"FUDISLTE_PUBLIC_URL", "FUDISLTE_MAIL_TRANSPORT=log"} {
		if !contains(err.Error(), want) {
			t.Errorf("error %q does not mention %s", err, want)
		}
	}

	_, err = load(env(map[string]string{"FUDISLTE_DATABASE_URL": "postgres://x", "FUDISLTE_PUBLIC_URL": "https://n.example.com"}))
	for _, want := range []string{"FUDISLTE_SMTP_HOST", "FUDISLTE_SMTP_FROM"} {
		if err == nil || !contains(err.Error(), want) {
			t.Errorf("error %v does not mention %s", err, want)
		}
	}
}

func TestSMTPWithoutTLSRejectsRemoteCredentials(t *testing.T) {
	m := map[string]string{"FUDISLTE_SMTP_TLS": "none", "FUDISLTE_SMTP_USERNAME": "user"}
	for k, v := range productionMinimum {
		m[k] = v
	}
	if _, err := load(env(m)); err == nil || !contains(err.Error(), "unencrypted") {
		t.Fatalf("expected an unencrypted-credentials error, got %v", err)
	}
	m["FUDISLTE_SMTP_HOST"] = "127.0.0.1"
	if _, err := load(env(m)); err != nil {
		t.Fatalf("loopback relay without TLS should be allowed: %v", err)
	}
}

func TestDevelopmentDefaults(t *testing.T) {
	c, err := load(env(map[string]string{
		"FUDISLTE_DATABASE_URL":   "postgres://x",
		"FUDISLTE_ENV":            "development",
		"FUDISLTE_MAIL_TRANSPORT": "log",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if c.PublicURL != "http://localhost:5173" || c.Mail.Transport != "log" {
		t.Fatalf("unexpected development config: %+v", c)
	}
}

func TestParsePrefixes(t *testing.T) {
	got, err := parsePrefixes(" 10.0.0.0/8, 172.18.0.5 ,::1")
	if err != nil {
		t.Fatal(err)
	}
	want := []netip.Prefix{
		netip.MustParsePrefix("10.0.0.0/8"),
		netip.MustParsePrefix("172.18.0.5/32"),
		netip.MustParsePrefix("::1/128"),
	}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("prefix %d: got %v, want %v", i, got[i], want[i])
		}
	}
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
