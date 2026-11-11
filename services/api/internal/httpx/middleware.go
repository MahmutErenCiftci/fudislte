package httpx

import (
	"log/slog"
	"net/http"
	"runtime/debug"
	"strings"
	"time"

	"github.com/go-chi/chi/v5/middleware"
)

// SecurityHeaders sets conservative headers for API responses. The web application's
// HTML is served by the reverse proxy, which sets its own Content-Security-Policy.
func SecurityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("Cross-Origin-Opener-Policy", "same-origin")
		h.Set("Cross-Origin-Resource-Policy", "same-origin")
		h.Set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'")
		h.Set("Cache-Control", "no-store")
		next.ServeHTTP(w, r)
	})
}

// RequestLogger logs one structured line per request. Query strings are omitted
// because they may contain tokens.
func RequestLogger(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		ww := middleware.NewWrapResponseWriter(w, r.ProtoMajor)
		next.ServeHTTP(ww, r)
		level := slog.LevelInfo
		if ww.Status() >= 500 {
			level = slog.LevelError
		}
		slog.Log(r.Context(), level, "http request",
			"method", r.Method,
			"path", redactPath(r.URL.Path),
			"status", ww.Status(),
			"bytes", ww.BytesWritten(),
			"duration_ms", time.Since(start).Milliseconds(),
			"client_ip", ClientIP(r.Context()).String(),
			"request_id", middleware.GetReqID(r.Context()),
		)
	})
}

// Recoverer turns panics into a logged 500 response.
func Recoverer(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rec := recover(); rec != nil {
				if rec == http.ErrAbortHandler {
					panic(rec)
				}
				slog.ErrorContext(r.Context(), "panic", "panic", rec, "stack", string(debug.Stack()))
				WriteError(w, r, NewError(http.StatusInternalServerError, "internal_error", "Something went wrong. Try again later."))
			}
		}()
		next.ServeHTTP(w, r)
	})
}

// redactPath hides secrets that travel in the path: an invitation token is a bearer
// credential, so anyone reading the logs could otherwise use the link.
func redactPath(p string) string {
	const prefix = "/api/v1/invitations/"
	if !strings.HasPrefix(p, prefix) {
		return p
	}
	rest := p[len(prefix):]
	if i := strings.IndexByte(rest, '/'); i >= 0 {
		return prefix + "REDACTED" + rest[i:]
	}
	return prefix + "REDACTED"
}
