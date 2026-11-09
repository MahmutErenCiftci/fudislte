package boards

import (
	"context"
	"encoding/json"
	"net/http"
	"regexp"
	"slices"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"fudislte/api/internal/auth"
	"fudislte/api/internal/database"
	"fudislte/api/internal/httpx"
	"fudislte/api/internal/realtime"
)

// The scene. Clients send the elements they changed in batches; the server keeps, per
// element, the copy with the higher version, and on equal versions the one with the
// lower versionNonce — Excalidraw's own reconciliation rule, so every client and the
// server converge on the same scene whatever order batches arrive in. Accepted elements
// go to the people viewing the board; rejected ones are already superseded there.

const (
	maxBatchBytes   = 4 << 20
	maxBatch        = 500
	maxElementBytes = 256 << 10
	maxElements     = 10000
)

var (
	errBoardFull = httpx.NewError(http.StatusConflict, "board_full", "A whiteboard can have at most 10000 shapes.")
	errElements  = httpx.Invalid(map[string]string{"elements": "Send at most 500 valid shapes at once."})
	errClientID  = httpx.Invalid(map[string]string{"clientId": "The client ID is not valid."})
	errTooFast   = httpx.NewError(http.StatusTooManyRequests, "rate_limited", "You are making changes too quickly. Wait a moment.")

	elementID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
	clientID  = regexp.MustCompile(`^[A-Za-z0-9_-]{8,64}$`)
)

// elementTypes are the shapes boards store. Images need file storage and embeds load
// other sites, so neither is accepted.
var elementTypes = []string{"rectangle", "diamond", "ellipse", "arrow", "line", "freedraw", "text", "frame"}

// header is the part of an element the server reads; the element's JSON is stored as is.
type header struct {
	ID           string `json:"id"`
	Type         string `json:"type"`
	Version      int64  `json:"version"`
	VersionNonce int64  `json:"versionNonce"`
	IsDeleted    bool   `json:"isDeleted"`
}

// wins reports whether incoming replaces current.
func wins(incoming, current header) bool {
	return incoming.Version > current.Version ||
		(incoming.Version == current.Version && incoming.VersionNonce < current.VersionNonce)
}

type element struct {
	header
	raw json.RawMessage
}

// parseElements validates a batch and keeps the winning copy of each element.
func parseElements(raws []json.RawMessage) ([]element, error) {
	if len(raws) == 0 || len(raws) > maxBatch {
		return nil, errElements
	}
	byID := make(map[string]int, len(raws))
	out := make([]element, 0, len(raws))
	for _, raw := range raws {
		var h header
		if len(raw) > maxElementBytes || len(raw) == 0 || raw[0] != '{' || json.Unmarshal(raw, &h) != nil ||
			!elementID.MatchString(h.ID) || !slices.Contains(elementTypes, h.Type) || h.Version < 1 {
			return nil, errElements
		}
		e := element{h, raw}
		if i, ok := byID[h.ID]; ok {
			if wins(h, out[i].header) {
				out[i] = e
			}
			continue
		}
		byID[h.ID] = len(out)
		out = append(out, e)
	}
	return out, nil
}

// SaveElements stores the caller's changed elements and sends the accepted ones to the
// board's viewers. clientId identifies the sending window, which ignores its own echo.
func (s *Service) SaveElements(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	m, b, err := s.editableBoard(r)
	if err != nil {
		return err
	}
	var in struct {
		ClientID string            `json:"clientId"`
		Elements []json.RawMessage `json:"elements"`
	}
	if err := httpx.DecodeJSONLimit(w, r, &in, maxBatchBytes); err != nil {
		return err
	}
	if !clientID.MatchString(in.ClientID) {
		return errClientID
	}
	elements, err := parseElements(in.Elements)
	if err != nil {
		return err
	}
	if !s.elementsByUser.Allow(m.UserID.String()) {
		return errTooFast
	}
	var accepted []json.RawMessage
	err = database.InTx(ctx, s.db, func(tx pgx.Tx) error {
		// The board row lock orders writes, so the size limit holds.
		if _, err := tx.Exec(ctx, `SELECT 1 FROM boards WHERE id = $1 FOR UPDATE`, b.ID); err != nil {
			return err
		}
		if err := checkSize(ctx, tx, b.ID, elements); err != nil {
			return err
		}
		var err error
		if accepted, err = upsert(ctx, tx, b.ID, m.UserID, elements); err != nil || len(accepted) == 0 {
			return err
		}
		_, err = tx.Exec(ctx, `UPDATE boards SET updated_at = now() WHERE id = $1`, b.ID)
		return err
	})
	if err != nil {
		return err
	}
	if len(accepted) > 0 {
		s.viewers.heartbeat(b.scope, b.ID, in.ClientID, s.person(r), now())
		s.toViewers(ctx, b.scope, b.ID, realtime.Event{Type: "board.elements", Data: map[string]any{
			"orgId": m.Org.ID, "boardId": b.ID, "clientId": in.ClientID, "user": s.person(r), "elements": accepted,
		}})
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"accepted": len(accepted)})
	return nil
}

func (s *Service) person(r *http.Request) Person {
	u := auth.MustIdentity(r.Context()).User
	return Person{ID: u.ID, DisplayName: u.DisplayName}
}

// checkSize fails when the new shapes would take the board over maxElements.
func checkSize(ctx context.Context, tx pgx.Tx, boardID uuid.UUID, elements []element) error {
	var live []string
	for _, e := range elements {
		if !e.IsDeleted {
			live = append(live, e.ID)
		}
	}
	var count int
	if err := tx.QueryRow(ctx, `
		SELECT (SELECT count(*) FROM board_elements WHERE board_id = $1 AND NOT deleted)
		     + (SELECT count(*) FROM unnest($2::text[]) AS n(id)
		        WHERE NOT EXISTS (SELECT 1 FROM board_elements e WHERE e.board_id = $1 AND e.element_id = n.id))`,
		boardID, live).Scan(&count); err != nil {
		return err
	}
	if count > maxElements {
		return errBoardFull
	}
	return nil
}

// upsert applies the merge rule in one statement and returns the accepted elements.
func upsert(ctx context.Context, tx pgx.Tx, boardID, userID uuid.UUID, elements []element) ([]json.RawMessage, error) {
	ids := make([]string, len(elements))
	versions := make([]int64, len(elements))
	nonces := make([]int64, len(elements))
	data := make([]string, len(elements))
	deleted := make([]bool, len(elements))
	byID := make(map[string]json.RawMessage, len(elements))
	for i, e := range elements {
		ids[i], versions[i], nonces[i], data[i], deleted[i] = e.ID, e.Version, e.VersionNonce, string(e.raw), e.IsDeleted
		byID[e.ID] = e.raw
	}
	rows, err := tx.Query(ctx, `
		INSERT INTO board_elements (board_id, element_id, version, version_nonce, data, deleted, updated_by)
		SELECT $1, n.id, n.version, n.nonce, n.data::jsonb, n.deleted, $2
		FROM unnest($3::text[], $4::bigint[], $5::bigint[], $6::text[], $7::boolean[]) AS n(id, version, nonce, data, deleted)
		ON CONFLICT (board_id, element_id) DO UPDATE
		SET version = EXCLUDED.version, version_nonce = EXCLUDED.version_nonce, data = EXCLUDED.data,
		    deleted = EXCLUDED.deleted, updated_by = EXCLUDED.updated_by, updated_at = now()
		WHERE EXCLUDED.version > board_elements.version
		   OR (EXCLUDED.version = board_elements.version AND EXCLUDED.version_nonce < board_elements.version_nonce)
		RETURNING element_id`, boardID, userID, ids, versions, nonces, data, deleted)
	if err != nil {
		return nil, err
	}
	won, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return nil, err
	}
	accepted := make([]json.RawMessage, len(won))
	for i, id := range won {
		accepted[i] = byID[id]
	}
	return accepted, nil
}

// GetBoard returns the board with its merged scene in z-order. ?deleted=true includes
// deleted elements, for clients merging after a reconnect.
func (s *Service) GetBoard(w http.ResponseWriter, r *http.Request) error {
	_, b, err := s.loadBoard(r)
	if err != nil {
		return err
	}
	rows, err := s.db.Query(r.Context(), `
		SELECT data FROM board_elements WHERE board_id = $1 AND ($2 OR NOT deleted)
		ORDER BY data->>'index' COLLATE "C" NULLS FIRST, element_id`, b.ID, r.URL.Query().Get("deleted") == "true")
	if err != nil {
		return err
	}
	elements, err := pgx.CollectRows(rows, pgx.RowTo[json.RawMessage])
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"board": b, "elements": elements})
	return nil
}
