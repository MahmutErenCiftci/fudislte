// Package i18n translates user-facing API messages and emails. English source strings
// are the message IDs (gettext style): a missing translation falls back to English.
package i18n

import (
	"context"
	"fmt"
	"net/http"
	"strings"
)

type Locale string

const (
	Turkish Locale = "tr"
	English Locale = "en"
)

var catalogs = map[Locale]map[string]string{
	Turkish: turkish,
}

// Parse returns the supported locale for a language tag such as "tr" or "en-US".
func Parse(tag string) (Locale, bool) {
	base, _, _ := strings.Cut(strings.ToLower(strings.TrimSpace(tag)), "-")
	switch Locale(base) {
	case Turkish:
		return Turkish, true
	case English:
		return English, true
	}
	return "", false
}

// FromAcceptLanguage picks the first supported language in an Accept-Language header.
// Quality values are ignored: clients list languages in order of preference.
func FromAcceptLanguage(header string, fallback Locale) Locale {
	for part := range strings.SplitSeq(header, ",") {
		tag, _, _ := strings.Cut(part, ";")
		if l, ok := Parse(tag); ok {
			return l
		}
	}
	return fallback
}

type ctxKey struct{}

// Middleware stores the request's preferred locale in its context.
func Middleware(fallback Locale) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			l := FromAcceptLanguage(r.Header.Get("Accept-Language"), fallback)
			next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), ctxKey{}, l)))
		})
	}
}

// FromContext returns the locale stored by Middleware, or Turkish.
func FromContext(ctx context.Context) Locale {
	if l, ok := ctx.Value(ctxKey{}).(Locale); ok {
		return l
	}
	return Turkish
}

// T translates an English source message.
func T(l Locale, msg string) string {
	if s, ok := catalogs[l][msg]; ok {
		return s
	}
	return msg
}

// Tf translates a format string, then fills it in. Translations keep the verbs in the
// same order as the English source.
func Tf(l Locale, format string, args ...any) string {
	return fmt.Sprintf(T(l, format), args...)
}
