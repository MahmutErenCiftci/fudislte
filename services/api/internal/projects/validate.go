package projects

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"fudislte/api/internal/database"
)

// Input rules shared by projects, tasks, sprints and whiteboards.

// workspaceMembers fails unless every ID belongs to a member of the workspace.
func workspaceMembers(ctx context.Context, q database.Querier, orgID uuid.UUID, ids []uuid.UUID) error {
	if len(ids) == 0 {
		return nil
	}
	var known int
	if err := q.QueryRow(ctx, `SELECT count(*) FROM memberships WHERE org_id = $1 AND user_id = ANY ($2)`, orgID, ids).Scan(&known); err != nil {
		return err
	}
	if known != len(ids) {
		return errNotMembers
	}
	return nil
}

// normalizeKey upper-cases a project key and accepts 2 to 6 letters A–Z.
func normalizeKey(s string) (string, string) {
	s = strings.ToUpper(strings.TrimSpace(s))
	if n := len(s); n < 2 || n > 6 || strings.IndexFunc(s, func(r rune) bool { return r < 'A' || r > 'Z' }) >= 0 {
		return "", "Use 2 to 6 letters from A to Z."
	}
	return s, ""
}

// lineLimits and textLimits are the lengths the API uses, with their messages (each
// translated in the i18n catalog).
var (
	lineLimits = map[int]string{
		30: "Use 1 to 30 characters.", 40: "Use 1 to 40 characters.", 80: "Use 1 to 80 characters.",
		120: "Use 1 to 120 characters.", 200: "Use 1 to 200 characters.",
	}
	textLimits = map[int]string{
		500: "Use at most 500 characters.", 2000: "Use at most 2000 characters.", 10000: "Use at most 10000 characters.",
	}
)

// NormalizeLine collapses whitespace into one line of 1 to max characters, max being
// one of lineLimits.
func NormalizeLine(s string, max int) (string, string) {
	s = strings.Join(strings.Fields(s), " ")
	if n := utf8.RuneCountInString(s); n < 1 || n > max || strings.IndexFunc(s, unicode.IsControl) >= 0 {
		return "", lineLimits[max]
	}
	return s, ""
}

// NormalizeText keeps line breaks and tabs, drops other control characters and trims
// surrounding blank space; the text may be empty. max is one of textLimits.
func NormalizeText(s string, max int) (string, string) {
	s = strings.ReplaceAll(s, "\r\n", "\n")
	s = strings.Map(func(r rune) rune {
		if r == '\n' || r == '\t' || !unicode.IsControl(r) {
			return r
		}
		return -1
	}, s)
	s = strings.TrimSpace(s)
	if utf8.RuneCountInString(s) > max {
		return "", textLimits[max]
	}
	return s, ""
}

// normalizeDate accepts nil (no date) or a calendar date such as 2026-11-30.
func normalizeDate(s *string) (*string, string) {
	if s == nil || *s == "" {
		return nil, ""
	}
	d, err := time.Parse(time.DateOnly, *s)
	if err != nil || d.Year() < 2000 || d.Year() > 2100 {
		return nil, "Use a date such as 2026-11-30."
	}
	out := d.Format(time.DateOnly)
	return &out, ""
}

// optional is a JSON field that tells "absent" (Set false) from null (Set, Value nil),
// so PATCH bodies can clear a value.
type optional[T any] struct {
	Set   bool
	Value *T
}

func (o *optional[T]) UnmarshalJSON(b []byte) error {
	o.Set = true
	if string(b) == "null" {
		o.Value = nil
		return nil
	}
	var v T
	if err := json.Unmarshal(b, &v); err != nil {
		return err
	}
	o.Value = &v
	return nil
}

func unique(ids []uuid.UUID) []uuid.UUID {
	seen := make(map[uuid.UUID]bool, len(ids))
	out := make([]uuid.UUID, 0, len(ids))
	for _, id := range ids {
		if !seen[id] {
			seen[id] = true
			out = append(out, id)
		}
	}
	return out
}

func isNoRows(err error) bool { return errors.Is(err, pgx.ErrNoRows) }
