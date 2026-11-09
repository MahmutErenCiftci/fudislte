// Package config loads the API configuration from environment variables.
package config

import (
	"errors"
	"fmt"
	"log/slog"
	"net/mail"
	"net/netip"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"fudislte/api/internal/i18n"
)

type Config struct {
	// Env is "production" (default) or "development". Development allows plain-HTTP
	// public URLs and the log mail transport.
	Env         string
	HTTPAddr    string
	DatabaseURL string
	// PublicURL is the address people use to open FUDISLTE; it appears in emails.
	PublicURL      string
	CookieSecure   bool
	SetupToken     string
	TrustedProxies []netip.Prefix
	MigrateOnStart bool
	// SessionIdleTTL ends unused sessions. How long a session lasts at most is set by
	// instance administrators in the app (48 hours by default).
	SessionIdleTTL time.Duration
	LogLevel       slog.Level
	LogFormat      string
	Mail           Mail
	// DefaultLocale is used when a request names no supported language.
	DefaultLocale i18n.Locale
	// DataDir holds attachments (ADR-0009); back it up together with the database.
	DataDir        string
	MaxUploadBytes int64
	// Media is optional: without it, rooms have no voice or video.
	Media Media
	// RegistryURL is where servers whose administrators opt in report themselves to the
	// FUDISLTE project; empty means the option is not offered.
	RegistryURL string
}

// DefaultRegistryURL is the FUDISLTE project's registry (services/registry). Set it
// here, or at build time with -ldflags "-X fudislte/api/internal/config.DefaultRegistryURL=…",
// once the registry is deployed. FUDISLTE_REGISTRY_URL overrides it; "off" disables it.
var DefaultRegistryURL = ""

// Media configures voice and video through a self-hosted LiveKit server (ADR-0011).
type Media struct {
	// URL is what clients connect to: wss://… (ws:// in development), for example
	// wss://fudislte.example.com/livekit behind the bundled Caddy.
	URL string
	// APIURL is how the API reaches LiveKit's server API, e.g. http://livekit:7880.
	APIURL    string
	APIKey    string
	APISecret string
}

func (m Media) Enabled() bool { return m.URL != "" }

// Mail configures outgoing email, which carries sign-in codes and invitations.
type Mail struct {
	// Transport is "smtp" (default) or "log" (development only: emails are written
	// to the API log instead of being delivered).
	Transport    string
	SMTPHost     string
	SMTPPort     int
	SMTPUsername string
	SMTPPassword string
	// SMTPTLS is "starttls" (default), "tls" (implicit TLS, usually port 465) or
	// "none" (only for relays on the same host).
	SMTPTLS string
	From    string
}

func (c Config) IsDevelopment() bool { return c.Env == "development" }

// MinSetupTokenLength protects operator-provided setup tokens from being guessable.
const MinSetupTokenLength = 16

func Load() (Config, error) {
	return load(os.Getenv)
}

func load(getenv func(string) string) (Config, error) {
	var errs []error
	c := Config{
		Env:         valueOr(getenv("FUDISLTE_ENV"), "production"),
		HTTPAddr:    valueOr(getenv("FUDISLTE_HTTP_ADDR"), ":8080"),
		DatabaseURL: getenv("FUDISLTE_DATABASE_URL"),
		SetupToken:  strings.TrimSpace(getenv("FUDISLTE_SETUP_TOKEN")),
		LogFormat:   valueOr(getenv("FUDISLTE_LOG_FORMAT"), "json"),
	}

	if l, ok := i18n.Parse(valueOr(getenv("FUDISLTE_DEFAULT_LOCALE"), "tr")); ok {
		c.DefaultLocale = l
	} else {
		errs = append(errs, errors.New("FUDISLTE_DEFAULT_LOCALE must be tr or en"))
	}

	if c.Env != "production" && c.Env != "development" {
		errs = append(errs, errors.New("FUDISLTE_ENV must be production or development"))
	}
	if c.DatabaseURL == "" {
		errs = append(errs, errors.New("FUDISLTE_DATABASE_URL is required"))
	}
	var err error
	if c.PublicURL, err = parsePublicURL(getenv("FUDISLTE_PUBLIC_URL"), c.IsDevelopment()); err != nil {
		errs = append(errs, err)
	}
	if c.Mail, err = loadMail(getenv, c.IsDevelopment()); err != nil {
		errs = append(errs, err)
	}
	if c.SetupToken != "" && len(c.SetupToken) < MinSetupTokenLength {
		errs = append(errs, fmt.Errorf("FUDISLTE_SETUP_TOKEN must be at least %d characters", MinSetupTokenLength))
	}
	if c.LogFormat != "json" && c.LogFormat != "text" {
		errs = append(errs, errors.New("FUDISLTE_LOG_FORMAT must be json or text"))
	}

	if c.CookieSecure, err = parseBool(getenv, "FUDISLTE_COOKIE_SECURE", true); err != nil {
		errs = append(errs, err)
	}
	if c.MigrateOnStart, err = parseBool(getenv, "FUDISLTE_MIGRATE_ON_START", true); err != nil {
		errs = append(errs, err)
	}
	if getenv("FUDISLTE_SESSION_TTL") != "" {
		slog.Warn("FUDISLTE_SESSION_TTL is no longer used: instance administrators set the session lifetime in Settings → Security (48 hours by default)")
	}
	if c.SessionIdleTTL, err = parseDuration(getenv, "FUDISLTE_SESSION_IDLE_TTL", 7*24*time.Hour); err != nil {
		errs = append(errs, err)
	}
	if err := c.LogLevel.UnmarshalText([]byte(valueOr(getenv("FUDISLTE_LOG_LEVEL"), "info"))); err != nil {
		errs = append(errs, fmt.Errorf("FUDISLTE_LOG_LEVEL: %w", err))
	}
	if c.TrustedProxies, err = parsePrefixes(getenv("FUDISLTE_TRUSTED_PROXIES")); err != nil {
		errs = append(errs, err)
	}
	c.DataDir = valueOr(getenv("FUDISLTE_DATA_DIR"), "/var/lib/fudislte")
	if mb, err := strconv.Atoi(valueOr(getenv("FUDISLTE_MAX_UPLOAD_MB"), "25")); err != nil || mb < 1 || mb > 1024 {
		errs = append(errs, errors.New("FUDISLTE_MAX_UPLOAD_MB must be a number of megabytes between 1 and 1024"))
	} else {
		c.MaxUploadBytes = int64(mb) << 20
	}

	if c.Media, err = loadMedia(getenv, c.IsDevelopment()); err != nil {
		errs = append(errs, err)
	}
	if c.RegistryURL, err = parseRegistryURL(valueOr(getenv("FUDISLTE_REGISTRY_URL"), DefaultRegistryURL), c.IsDevelopment()); err != nil {
		errs = append(errs, err)
	}

	return c, errors.Join(errs...)
}

// loadMedia reads the LiveKit settings; all of them, or none.
func loadMedia(getenv func(string) string, development bool) (Media, error) {
	m := Media{
		URL:       strings.TrimRight(getenv("FUDISLTE_LIVEKIT_URL"), "/"),
		APIURL:    strings.TrimRight(getenv("FUDISLTE_LIVEKIT_API_URL"), "/"),
		APIKey:    getenv("FUDISLTE_LIVEKIT_API_KEY"),
		APISecret: getenv("FUDISLTE_LIVEKIT_API_SECRET"),
	}
	if m.URL == "" {
		return Media{}, nil
	}
	u, err := url.Parse(m.URL)
	if err != nil || u.Host == "" || (u.Scheme != "wss" && !(development && u.Scheme == "ws")) {
		return Media{}, errors.New("FUDISLTE_LIVEKIT_URL must be a wss:// URL")
	}
	if m.APIURL == "" {
		m.APIURL = strings.Replace(m.URL, "ws", "http", 1)
	}
	if a, err := url.Parse(m.APIURL); err != nil || a.Host == "" || (a.Scheme != "http" && a.Scheme != "https") {
		return Media{}, errors.New("FUDISLTE_LIVEKIT_API_URL must be an http(s):// URL")
	}
	if m.APIKey == "" || len(m.APISecret) < 32 {
		return Media{}, errors.New("FUDISLTE_LIVEKIT_API_KEY and a FUDISLTE_LIVEKIT_API_SECRET of at least 32 characters are required with FUDISLTE_LIVEKIT_URL")
	}
	return m, nil
}

// parsePublicURL requires an absolute https URL (http is accepted in development) and
// returns it without a trailing slash.
func parsePublicURL(v string, development bool) (string, error) {
	if v == "" {
		if development {
			return "http://localhost:5173", nil
		}
		return "", errors.New("FUDISLTE_PUBLIC_URL is required, e.g. https://fudislte.example.com")
	}
	u, err := url.Parse(v)
	if err != nil || u.Host == "" || (u.Scheme != "https" && !(development && u.Scheme == "http")) ||
		u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return "", errors.New("FUDISLTE_PUBLIC_URL must be an absolute https:// URL")
	}
	return strings.TrimRight(u.String(), "/"), nil
}

// parseRegistryURL accepts an https URL (http in development), or "off".
func parseRegistryURL(v string, development bool) (string, error) {
	if v == "" || v == "off" {
		return "", nil
	}
	u, err := url.Parse(v)
	if err != nil || u.Host == "" || (u.Scheme != "https" && !(development && u.Scheme == "http")) ||
		u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return "", errors.New("FUDISLTE_REGISTRY_URL must be an https:// URL or off")
	}
	return strings.TrimRight(u.String(), "/"), nil
}

func loadMail(getenv func(string) string, development bool) (Mail, error) {
	m := Mail{
		Transport:    valueOr(getenv("FUDISLTE_MAIL_TRANSPORT"), "smtp"),
		SMTPHost:     getenv("FUDISLTE_SMTP_HOST"),
		SMTPUsername: getenv("FUDISLTE_SMTP_USERNAME"),
		SMTPPassword: getenv("FUDISLTE_SMTP_PASSWORD"),
		SMTPTLS:      valueOr(getenv("FUDISLTE_SMTP_TLS"), "starttls"),
		From:         getenv("FUDISLTE_SMTP_FROM"),
	}
	var errs []error
	switch m.Transport {
	case "log":
		if !development {
			errs = append(errs, errors.New("FUDISLTE_MAIL_TRANSPORT=log is only allowed with FUDISLTE_ENV=development"))
		}
		return m, errors.Join(errs...)
	case "smtp":
	default:
		return m, errors.New("FUDISLTE_MAIL_TRANSPORT must be smtp or log")
	}

	port, err := strconv.Atoi(valueOr(getenv("FUDISLTE_SMTP_PORT"), "587"))
	if err != nil || port < 1 || port > 65535 {
		errs = append(errs, errors.New("FUDISLTE_SMTP_PORT must be a port number"))
	}
	m.SMTPPort = port
	if m.SMTPHost == "" {
		errs = append(errs, errors.New("FUDISLTE_SMTP_HOST is required: sign-in codes are delivered by email"))
	}
	if addr, err := mail.ParseAddress(m.From); m.From == "" || err != nil || addr.Address == "" {
		errs = append(errs, errors.New(`FUDISLTE_SMTP_FROM must be an address such as "FUDISLTE <fudislte@example.com>"`))
	}
	switch m.SMTPTLS {
	case "starttls", "tls":
	case "none":
		if m.SMTPUsername != "" && !isLoopback(m.SMTPHost) {
			errs = append(errs, errors.New("FUDISLTE_SMTP_TLS=none would send SMTP credentials unencrypted; use starttls or tls"))
		}
	default:
		errs = append(errs, errors.New("FUDISLTE_SMTP_TLS must be starttls, tls or none"))
	}
	return m, errors.Join(errs...)
}

func isLoopback(host string) bool {
	if host == "localhost" {
		return true
	}
	addr, err := netip.ParseAddr(host)
	return err == nil && addr.IsLoopback()
}

func valueOr(v, fallback string) string {
	if v == "" {
		return fallback
	}
	return v
}

func parseBool(getenv func(string) string, key string, fallback bool) (bool, error) {
	v := getenv(key)
	if v == "" {
		return fallback, nil
	}
	b, err := strconv.ParseBool(v)
	if err != nil {
		return fallback, fmt.Errorf("%s must be true or false", key)
	}
	return b, nil
}

func parseDuration(getenv func(string) string, key string, fallback time.Duration) (time.Duration, error) {
	v := getenv(key)
	if v == "" {
		return fallback, nil
	}
	d, err := time.ParseDuration(v)
	if err != nil || d <= 0 {
		return fallback, fmt.Errorf("%s must be a positive duration such as 720h", key)
	}
	return d, nil
}

// parsePrefixes accepts a comma-separated list of CIDR ranges or single addresses.
func parsePrefixes(v string) ([]netip.Prefix, error) {
	var out []netip.Prefix
	for _, part := range strings.Split(v, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		if !strings.Contains(part, "/") {
			addr, err := netip.ParseAddr(part)
			if err != nil {
				return nil, fmt.Errorf("FUDISLTE_TRUSTED_PROXIES: invalid address %q", part)
			}
			out = append(out, netip.PrefixFrom(addr.Unmap(), addr.Unmap().BitLen()))
			continue
		}
		p, err := netip.ParsePrefix(part)
		if err != nil {
			return nil, fmt.Errorf("FUDISLTE_TRUSTED_PROXIES: invalid CIDR %q", part)
		}
		out = append(out, p.Masked())
	}
	return out, nil
}
