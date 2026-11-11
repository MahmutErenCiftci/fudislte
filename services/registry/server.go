package main

import (
	"crypto/subtle"
	"encoding/csv"
	"encoding/json"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"net/mail"
	"net/netip"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"
)

// Report is what a FUDISLTE server sends when its administrator opted in, once at the
// start and then daily so the user count stays current.
type Report struct {
	InstanceID       string `json:"instanceId"`
	Secret           string `json:"secret"`
	OrganizationName string `json:"organizationName"`
	ContactEmail     string `json:"contactEmail"`
	UserCount        int    `json:"userCount"`
	Version          string `json:"version"`
}

var (
	uuidPattern    = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	secretPattern  = regexp.MustCompile(`^[A-Za-z0-9_-]{32,128}$`)
	versionPattern = regexp.MustCompile(`^[0-9A-Za-z.+-]{1,40}$`)
)

const maxUserCount = 10_000_000

// normalize cleans the report in place and returns what is wrong with it, if anything.
func (r *Report) normalize() string {
	r.InstanceID = strings.ToLower(strings.TrimSpace(r.InstanceID))
	r.OrganizationName = strings.Join(strings.Fields(r.OrganizationName), " ")
	r.ContactEmail = strings.ToLower(strings.TrimSpace(r.ContactEmail))
	switch {
	case !uuidPattern.MatchString(r.InstanceID):
		return "instanceId must be a UUID"
	case !secretPattern.MatchString(r.Secret):
		return "secret must be 32 to 128 URL-safe characters"
	case r.OrganizationName == "" || utf8.RuneCountInString(r.OrganizationName) > 80 ||
		strings.IndexFunc(r.OrganizationName, unicode.IsControl) >= 0:
		return "organizationName must be 1 to 80 characters"
	case !validEmail(r.ContactEmail):
		return "contactEmail must be an email address"
	case r.UserCount < 0 || r.UserCount > maxUserCount:
		return "userCount is out of range"
	case !versionPattern.MatchString(r.Version):
		return "version is invalid"
	}
	return ""
}

func validEmail(s string) bool {
	if len(s) < 3 || len(s) > 254 {
		return false
	}
	addr, err := mail.ParseAddress(s)
	return err == nil && addr.Name == "" && addr.Address == s
}

type Server struct {
	store      *Store
	password   string
	trustProxy bool
	now        func() time.Time
	// reports limits registrations per client address; logins limits wrong passwords.
	reports       *limiter
	logins        *limiter
	registrations *limiter
	loginNetworks *limiter
}

func NewServer(store *Store, password string, trustProxy bool) *Server {
	return &Server{
		store: store, password: password, trustProxy: trustProxy, now: time.Now,
		reports: newLimiter(10*time.Second, 30),
		logins:  newLimiter(10*time.Second, 20),
		// New instances per IPv4 /24 or IPv6 /48: one network cannot fill the registry with
		// made-up servers, and many /64s do not multiply password guesses.
		registrations: newWideLimiter(6*time.Minute, 10),
		loginNetworks: newWideLimiter(10*time.Second, 40),
	}
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/instances", s.report)
	mux.HandleFunc("DELETE /v1/instances/{id}", s.withdraw)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
	mux.HandleFunc("GET /{$}", s.admin(s.page))
	mux.HandleFunc("GET /instances.csv", s.admin(s.exportCSV))
	return securityHeaders(mux)
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'")
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("Cache-Control", "no-store")
		next.ServeHTTP(w, r)
	})
}

// clientIP is the connecting address, or the last X-Forwarded-For entry — the one our
// own reverse proxy added — when the registry runs behind one.
func (s *Server) clientIP(r *http.Request) string {
	if s.trustProxy {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			parts := strings.Split(xff, ",")
			return strings.TrimSpace(parts[len(parts)-1])
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func writeError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

func (s *Server) report(w http.ResponseWriter, r *http.Request) {
	if !s.reports.allow(s.clientIP(r), s.now()) {
		writeError(w, http.StatusTooManyRequests, "too many requests")
		return
	}
	var in Report
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&in); err != nil {
		writeError(w, http.StatusBadRequest, "body must be a JSON report")
		return
	}
	if msg := in.normalize(); msg != "" {
		writeError(w, http.StatusUnprocessableEntity, msg)
		return
	}
	if !s.store.Has(in.InstanceID) && !s.registrations.allow(s.clientIP(r), s.now()) {
		writeError(w, http.StatusTooManyRequests, "too many new registrations from this network")
		return
	}
	switch err := s.store.Upsert(in, s.now().UTC()); {
	case errors.Is(err, errWrongSecret):
		writeError(w, http.StatusForbidden, err.Error())
	case errors.Is(err, errFull):
		writeError(w, http.StatusServiceUnavailable, err.Error())
	case err != nil:
		slog.Error("saving a report failed", "error", err)
		writeError(w, http.StatusInternalServerError, "could not save the report")
	default:
		w.WriteHeader(http.StatusNoContent)
	}
}

func (s *Server) withdraw(w http.ResponseWriter, r *http.Request) {
	if !s.reports.allow(s.clientIP(r), s.now()) {
		writeError(w, http.StatusTooManyRequests, "too many requests")
		return
	}
	secret, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	if !ok || !secretPattern.MatchString(secret) {
		writeError(w, http.StatusUnauthorized, "send the instance secret as a bearer token")
		return
	}
	switch err := s.store.Delete(strings.ToLower(r.PathValue("id")), secret); {
	case errors.Is(err, errWrongSecret):
		writeError(w, http.StatusForbidden, err.Error())
	case err != nil:
		slog.Error("deleting an instance failed", "error", err)
		writeError(w, http.StatusInternalServerError, "could not delete the instance")
	default:
		w.WriteHeader(http.StatusNoContent)
	}
}

// admin protects the list with HTTP Basic authentication; any user name works. Every
// request that carries a password spends a token, so guessing stays slow even when a
// guess is right.
func (s *Server) admin(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if _, password, ok := r.BasicAuth(); ok {
			if !s.logins.allow(s.clientIP(r), s.now()) || !s.loginNetworks.allow(s.clientIP(r), s.now()) {
				http.Error(w, "too many attempts", http.StatusTooManyRequests)
				return
			}
			if subtle.ConstantTimeCompare([]byte(password), []byte(s.password)) == 1 {
				next(w, r)
				return
			}
		}
		w.Header().Set("WWW-Authenticate", `Basic realm="FUDISLTE registry", charset="UTF-8"`)
		http.Error(w, "authentication required", http.StatusUnauthorized)
	}
}

func (s *Server) exportCSV(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="fudislte-instances.csv"`)
	cw := csv.NewWriter(w)
	_ = cw.Write([]string{"organization", "contact_email", "users", "version", "first_seen", "last_seen"})
	for _, in := range s.store.List() {
		_ = cw.Write([]string{
			csvSafe(in.OrganizationName), csvSafe(in.ContactEmail), strconv.Itoa(in.UserCount), csvSafe(in.Version),
			in.FirstSeen.Format(time.RFC3339), in.LastSeen.Format(time.RFC3339),
		})
	}
	cw.Flush()
}

// csvSafe keeps spreadsheets from treating a reported value as a formula. Every text
// column goes through it: an email's local part or a version may start with + or -.
func csvSafe(s string) string {
	if s != "" && strings.ContainsRune("=+-@\t\r", rune(s[0])) {
		return "'" + s
	}
	return s
}

// limiter is a token bucket per key: burst requests at once, then one per interval.
type limiter struct {
	mu        sync.Mutex
	interval  time.Duration
	burst     float64
	buckets   map[string]bucket
	lastSweep time.Time
	key       func(string) string
}

const (
	// Past sweepThreshold keys, idle buckets are dropped at most once per sweepEvery, so
	// a crowd of fresh addresses does not rescan the map on every request; maxBuckets
	// bounds memory when addresses rotate faster than that.
	sweepThreshold = 10_000
	sweepEvery     = time.Minute
	maxBuckets     = 100_000
)

// rateKey limits an IPv6 client by its /64 network, which one subscriber usually holds
// whole, and an IPv4 client by its address.
func rateKey(ip string) string {
	addr, err := netip.ParseAddr(ip)
	if err != nil || !addr.Is6() || addr.Is4In6() {
		return ip
	}
	p, err := addr.Prefix(64)
	if err != nil {
		return ip
	}
	return p.String()
}

// wideKey groups clients by IPv4 /24 or IPv6 /48, the size of network one party
// commonly holds.
func wideKey(ip string) string {
	addr, err := netip.ParseAddr(ip)
	if err != nil {
		return ip
	}
	addr = addr.Unmap()
	bits := 24
	if addr.Is6() {
		bits = 48
	}
	p, err := addr.Prefix(bits)
	if err != nil {
		return ip
	}
	return p.String()
}

type bucket struct {
	tokens float64
	at     time.Time
}

func newLimiter(interval time.Duration, burst int) *limiter {
	return &limiter{interval: interval, burst: float64(burst), buckets: map[string]bucket{}, key: rateKey}
}

// newWideLimiter keys by IPv4 /24 or IPv6 /48 instead.
func newWideLimiter(interval time.Duration, burst int) *limiter {
	return &limiter{interval: interval, burst: float64(burst), buckets: map[string]bucket{}, key: wideKey}
}

func (l *limiter) allow(key string, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	key = l.key(key)
	if len(l.buckets) > sweepThreshold && now.Sub(l.lastSweep) >= sweepEvery {
		l.lastSweep = now
		for k, b := range l.buckets {
			if now.Sub(b.at) > time.Duration(l.burst)*l.interval {
				delete(l.buckets, k)
			}
		}
	}
	if len(l.buckets) >= maxBuckets {
		// Map iteration order is random, so this forgets an arbitrary tenth.
		drop := maxBuckets / 10
		for k := range l.buckets {
			if drop == 0 {
				break
			}
			delete(l.buckets, k)
			drop--
		}
	}
	b, ok := l.buckets[key]
	if !ok {
		b = bucket{tokens: l.burst, at: now}
	}
	b.tokens = min(l.burst, b.tokens+float64(now.Sub(b.at))/float64(l.interval))
	b.at = now
	if b.tokens < 1 {
		l.buckets[key] = b
		return false
	}
	b.tokens--
	l.buckets[key] = b
	return true
}
