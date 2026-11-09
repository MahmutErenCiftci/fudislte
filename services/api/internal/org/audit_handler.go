package org

import (
	"net/http"
	"strconv"

	"fudislte/api/internal/audit"
	"fudislte/api/internal/httpx"
)

// ListAuditEvents pages through the organization's audit log, newest first.
// ?before=<id> continues from the previous page's nextBefore.
func (s *Service) ListAuditEvents(w http.ResponseWriter, r *http.Request) error {
	m := mustMembership(r.Context())
	before, _ := strconv.ParseInt(r.URL.Query().Get("before"), 10, 64)
	before = max(before, 0)
	limit, err := strconv.Atoi(r.URL.Query().Get("limit"))
	if err != nil || limit < 1 || limit > 100 {
		limit = 50
	}
	events, err := audit.List(r.Context(), s.db, m.Org.ID, before, limit+1)
	if err != nil {
		return err
	}
	var next *int64
	if len(events) > limit {
		events = events[:limit]
		id := events[limit-1].ID
		next = &id
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"events": events, "nextBefore": next})
	return nil
}
