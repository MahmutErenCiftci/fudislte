package org

import (
	"context"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"fudislte/api/internal/auth"
	"fudislte/api/internal/httpx"
)

type membershipKey struct{}

// MembershipFrom returns the membership loaded by RequireMember.
func MembershipFrom(ctx context.Context) *Membership {
	m, _ := ctx.Value(membershipKey{}).(*Membership)
	return m
}

func mustMembership(ctx context.Context) *Membership {
	m := MembershipFrom(ctx)
	if m == nil {
		panic("org: handler used on a route without RequireMember")
	}
	return m
}

// RequireMember loads the caller's membership in the {orgID} organization. Callers who
// are not members get 404 so the organization's existence is not disclosed.
func (s *Service) RequireMember(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := auth.MustIdentity(r.Context())
		orgID, err := uuid.Parse(chi.URLParam(r, "orgID"))
		if err != nil {
			httpx.WriteError(w, r, httpx.ErrNotFound)
			return
		}
		m, err := LoadMembership(r.Context(), s.db, orgID, id.User.ID)
		if err != nil {
			httpx.WriteError(w, r, err)
			return
		}
		if m == nil {
			httpx.WriteError(w, r, httpx.ErrNotFound)
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), membershipKey{}, m)))
	})
}

// RequirePermission rejects members whose role lacks p.
func RequirePermission(p Permission) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if m := MembershipFrom(r.Context()); m == nil || !m.Can(p) {
				httpx.WriteError(w, r, httpx.ErrForbidden)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
