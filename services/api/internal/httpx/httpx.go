// Package httpx contains HTTP helpers shared by every API module: JSON encoding,
// typed API errors, client IP resolution, rate limiting and middleware.
package httpx

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5/middleware"

	"fudislte/api/internal/i18n"
)

// Error is an error that is safe to show to API clients.
type Error struct {
	Status  int               `json:"-"`
	Code    string            `json:"code"`
	Message string            `json:"message"`
	Fields  map[string]string `json:"fields,omitempty"`
}

func (e *Error) Error() string { return e.Code + ": " + e.Message }

func NewError(status int, code, message string) *Error {
	return &Error{Status: status, Code: code, Message: message}
}

// Invalid reports field-level validation failures.
func Invalid(fields map[string]string) *Error {
	return &Error{
		Status:  http.StatusUnprocessableEntity,
		Code:    "validation_failed",
		Message: "Some fields are invalid.",
		Fields:  fields,
	}
}

var (
	ErrUnauthorized = NewError(http.StatusUnauthorized, "unauthorized", "Sign in to continue.")
	ErrForbidden    = NewError(http.StatusForbidden, "forbidden", "You do not have permission to do that.")
	ErrNotFound     = NewError(http.StatusNotFound, "not_found", "Not found.")
	ErrRateLimited  = NewError(http.StatusTooManyRequests, "rate_limited", "Too many attempts. Wait a minute and try again.")
)

// HandlerFunc is an http.HandlerFunc that returns an error instead of writing it.
type HandlerFunc func(w http.ResponseWriter, r *http.Request) error

// Handle adapts a HandlerFunc, turning returned errors into JSON error responses.
func Handle(h HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := h(w, r); err != nil {
			WriteError(w, r, err)
		}
	}
}

func WriteJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if v != nil {
		_ = json.NewEncoder(w).Encode(v)
	}
}

func NoContent(w http.ResponseWriter) {
	w.WriteHeader(http.StatusNoContent)
}

// WriteError writes err as a JSON error. Errors that are not *Error are logged and
// reported as a generic internal error so details never leak to clients.
func WriteError(w http.ResponseWriter, r *http.Request, err error) {
	var apiErr *Error
	if !errors.As(err, &apiErr) {
		slog.ErrorContext(r.Context(), "request failed",
			"error", err,
			"method", r.Method,
			"path", r.URL.Path,
			"request_id", middleware.GetReqID(r.Context()),
		)
		apiErr = NewError(http.StatusInternalServerError, "internal_error", "Something went wrong. Try again later.")
	}
	WriteJSON(w, apiErr.Status, map[string]any{"error": translate(apiErr, i18n.FromContext(r.Context()))})
}

// translate returns a copy of e in locale l; package-level errors are never modified.
func translate(e *Error, l i18n.Locale) *Error {
	out := &Error{Status: e.Status, Code: e.Code, Message: i18n.T(l, e.Message)}
	if len(e.Fields) > 0 {
		out.Fields = make(map[string]string, len(e.Fields))
		for k, v := range e.Fields {
			out.Fields[k] = i18n.T(l, v)
		}
	}
	return out
}

const maxBodyBytes = 1 << 20

// DecodeJSON decodes a single JSON object into dst, rejecting unknown fields,
// trailing data and bodies larger than 1 MiB.
func DecodeJSON(w http.ResponseWriter, r *http.Request, dst any) error {
	return DecodeJSONLimit(w, r, dst, maxBodyBytes)
}

// DecodeJSONLimit is DecodeJSON for endpoints that accept bodies up to limit bytes.
func DecodeJSONLimit(w http.ResponseWriter, r *http.Request, dst any, limit int64) error {
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			return NewError(http.StatusRequestEntityTooLarge, "body_too_large", "Request body is too large.")
		}
		return NewError(http.StatusBadRequest, "invalid_json", "Request body must be a valid JSON object with known fields.")
	}
	if dec.More() {
		return NewError(http.StatusBadRequest, "invalid_json", "Request body must contain a single JSON object.")
	}
	return nil
}
