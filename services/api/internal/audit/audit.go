// Package audit records security-relevant events. Events are written with the same
// Querier (usually the same transaction) as the change they describe, so a change and
// its audit record commit or roll back together.
package audit

import (
	"context"
	"encoding/json"
	"net/http"
	"net/netip"
	"time"

	"github.com/google/uuid"

	"fudislte/api/internal/database"
	"fudislte/api/internal/httpx"
)

type Event struct {
	OrgID      *uuid.UUID
	ActorID    *uuid.UUID
	Action     string
	TargetType string
	TargetID   string
	Metadata   map[string]any
	IP         netip.Addr
	UserAgent  string
}

// FromRequest starts an event carrying the request's client address and user agent.
func FromRequest(r *http.Request, action string) Event {
	return Event{Action: action, IP: httpx.ClientIP(r.Context()), UserAgent: r.UserAgent()}
}

func Record(ctx context.Context, q database.Querier, e Event) error {
	meta := e.Metadata
	if meta == nil {
		meta = map[string]any{}
	}
	_, err := q.Exec(ctx, `
		INSERT INTO audit_events (org_id, actor_user_id, action, target_type, target_id, metadata, ip_address, user_agent)
		VALUES ($1, $2, $3, $4, $5, $6, $7::inet, $8)`,
		e.OrgID, e.ActorID, e.Action, e.TargetType, e.TargetID, meta, httpx.IPString(e.IP), truncate(e.UserAgent, 512))
	return err
}

type Actor struct {
	ID          uuid.UUID `json:"id"`
	DisplayName string    `json:"displayName"`
	Email       string    `json:"email"`
}

type Entry struct {
	ID         int64           `json:"id"`
	Action     string          `json:"action"`
	Actor      *Actor          `json:"actor"`
	TargetType string          `json:"targetType"`
	TargetID   string          `json:"targetId"`
	Metadata   json.RawMessage `json:"metadata"`
	IPAddress  string          `json:"ipAddress"`
	UserAgent  string          `json:"userAgent"`
	CreatedAt  time.Time       `json:"createdAt"`
}

// List returns an organization's events newest first. before is an exclusive event ID
// cursor; 0 starts from the newest event.
func List(ctx context.Context, q database.Querier, orgID uuid.UUID, before int64, limit int) ([]Entry, error) {
	rows, err := q.Query(ctx, `
		SELECT e.id, e.action, e.target_type, e.target_id, e.metadata,
		       coalesce(host(e.ip_address), ''), e.user_agent, e.created_at,
		       u.id, u.display_name, u.email
		FROM audit_events e
		LEFT JOIN users u ON u.id = e.actor_user_id
		WHERE e.org_id = $1 AND ($2 = 0 OR e.id < $2)
		ORDER BY e.id DESC
		LIMIT $3`, orgID, before, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	entries := []Entry{}
	for rows.Next() {
		var (
			e                 Entry
			actorID           *uuid.UUID
			actorName, actorE *string
		)
		if err := rows.Scan(&e.ID, &e.Action, &e.TargetType, &e.TargetID, &e.Metadata,
			&e.IPAddress, &e.UserAgent, &e.CreatedAt, &actorID, &actorName, &actorE); err != nil {
			return nil, err
		}
		if actorID != nil {
			e.Actor = &Actor{ID: *actorID, DisplayName: deref(actorName), Email: deref(actorE)}
		}
		entries = append(entries, e)
	}
	return entries, rows.Err()
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
