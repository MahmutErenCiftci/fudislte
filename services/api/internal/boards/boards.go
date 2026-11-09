// Package boards implements whiteboards with persistence and live collaboration
// (docs/architecture/phase-5.md). A board belongs to a project and follows its access —
// members edit, everyone who may see the project views — or to the workspace, open to
// members who may use workspace whiteboards (boards.create). Boards the caller may not
// see answer 404.
package boards

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"fudislte/api/internal/audit"
	"fudislte/api/internal/chat"
	"fudislte/api/internal/database"
	"fudislte/api/internal/httpx"
	"fudislte/api/internal/org"
	"fudislte/api/internal/projects"
	"fudislte/api/internal/realtime"
)

type Service struct {
	db      *pgxpool.Pool
	events  realtime.Publisher
	viewers *registry
	// elementsByUser limits scene writes; clients send a batch about every 100 ms.
	elementsByUser *httpx.Limiter
	// cursorsByUser drops cursor updates beyond about 25 a second.
	cursorsByUser *httpx.Limiter
}

func NewService(db *pgxpool.Pool, events realtime.Publisher) *Service {
	return &Service{
		db:             db,
		events:         events,
		viewers:        newRegistry(viewerTTL),
		elementsByUser: httpx.NewLimiter(50*time.Millisecond, 40),
		cursorsByUser:  httpx.NewLimiter(40*time.Millisecond, 25),
	}
}

var errRoomLink = httpx.Invalid(map[string]string{"roomId": "Choose a room you are in."})

type Person struct {
	ID          uuid.UUID `json:"id"`
	DisplayName string    `json:"displayName"`
}

// Board is what the caller sees of a board.
type Board struct {
	ID          uuid.UUID            `json:"id"`
	Title       string               `json:"title"`
	Description string               `json:"description"`
	Project     *projects.ProjectRef `json:"project"`
	// Room is the room linked for voice, shown only to people who may see it.
	Room         *chat.ChannelRef `json:"room"`
	CreatedBy    *Person          `json:"createdBy"`
	CreatedAt    time.Time        `json:"createdAt"`
	UpdatedAt    time.Time        `json:"updatedAt"`
	ElementCount int              `json:"elementCount"`
	// CanEdit: draw on the board. CanManage: delete it.
	CanEdit   bool `json:"canEdit"`
	CanManage bool `json:"canManage"`

	scope  scope
	roomID *uuid.UUID
}

// scope is what decides who may see a board: its project, or the workspace.
type scope struct {
	orgID     uuid.UUID
	projectID *uuid.UUID
}

const boardQuery = `
	SELECT b.id, b.title, b.description, b.project_id, b.room_id, b.created_by, u.display_name, b.created_at, b.updated_at,
	       (SELECT count(*) FROM board_elements e WHERE e.board_id = b.id AND NOT e.deleted)
	FROM boards b LEFT JOIN users u ON u.id = b.created_by
	WHERE b.org_id = $1`

// queryBoards loads boards of the caller's workspace and keeps those the caller may see.
func queryBoards(ctx context.Context, q database.Querier, m *org.Membership, filter string, args ...any) ([]Board, error) {
	rows, err := q.Query(ctx, boardQuery+filter, append([]any{m.Org.ID}, args...)...)
	if err != nil {
		return nil, err
	}
	boards, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (Board, error) {
		var (
			b           Board
			creatorID   *uuid.UUID
			creatorName *string
		)
		err := row.Scan(&b.ID, &b.Title, &b.Description, &b.scope.projectID, &b.roomID, &creatorID, &creatorName,
			&b.CreatedAt, &b.UpdatedAt, &b.ElementCount)
		if creatorID != nil && creatorName != nil {
			b.CreatedBy = &Person{ID: *creatorID, DisplayName: *creatorName}
		}
		b.scope.orgID = m.Org.ID
		return b, err
	})
	if err != nil {
		return nil, err
	}
	var projectIDs, roomIDs []uuid.UUID
	for _, b := range boards {
		if b.scope.projectID != nil {
			projectIDs = append(projectIDs, *b.scope.projectID)
		}
		if b.roomID != nil {
			roomIDs = append(roomIDs, *b.roomID)
		}
	}
	visibleProjects, err := projects.LoadMany(ctx, q, m, projectIDs)
	if err != nil {
		return nil, err
	}
	rooms, err := chat.VisibleChannels(ctx, q, m, roomIDs)
	if err != nil {
		return nil, err
	}
	out := boards[:0]
	for _, b := range boards {
		creator := b.CreatedBy != nil && b.CreatedBy.ID == m.UserID
		if b.scope.projectID != nil {
			p, ok := visibleProjects[*b.scope.projectID]
			if !ok {
				continue
			}
			ref := p.Ref()
			b.Project = &ref
			b.CanEdit = p.CanEdit
			b.CanManage = p.CanManage || (creator && p.Role != "")
		} else {
			if !m.Can(org.PermBoardsCreate) {
				continue
			}
			b.CanEdit = true
			b.CanManage = creator || m.Can(org.PermProjectsManage)
		}
		if b.roomID != nil {
			if ref, ok := rooms[*b.roomID]; ok && ref.Kind == chat.KindRoom {
				b.Room = &ref
			}
		}
		out = append(out, b)
	}
	return out, nil
}

// loadBoard returns the {boardID} board if the caller may see it.
func (s *Service) loadBoard(r *http.Request) (*org.Membership, *Board, error) {
	m := org.MembershipFrom(r.Context())
	id, err := uuid.Parse(chi.URLParam(r, "boardID"))
	if err != nil {
		return m, nil, httpx.ErrNotFound
	}
	boards, err := queryBoards(r.Context(), s.db, m, ` AND b.id = $2`, id)
	if err != nil {
		return m, nil, err
	}
	if len(boards) == 0 {
		return m, nil, httpx.ErrNotFound
	}
	return m, &boards[0], nil
}

func (s *Service) editableBoard(r *http.Request) (*org.Membership, *Board, error) {
	m, b, err := s.loadBoard(r)
	if err == nil && !b.CanEdit {
		err = httpx.ErrForbidden
	}
	return m, b, err
}

// ListBoards returns the boards the caller may see, most recently changed first;
// ?projectId= keeps one project's.
func (s *Service) ListBoards(w http.ResponseWriter, r *http.Request) error {
	m := org.MembershipFrom(r.Context())
	filter, args := ``, []any{}
	if v := r.URL.Query().Get("projectId"); v != "" {
		id, err := uuid.Parse(v)
		if err != nil {
			return httpx.ErrNotFound
		}
		filter, args = ` AND b.project_id = $2`, append(args, id)
	}
	boards, err := queryBoards(r.Context(), s.db, m, filter+` ORDER BY b.updated_at DESC, b.id`, args...)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"boards": boards})
	return nil
}

type boardInput struct {
	Title       *string `json:"title"`
	Description *string `json:"description"`
	// RoomID links a room for voice; null removes the link.
	RoomID roomField `json:"roomId"`
}

// roomField tells an absent roomId from null.
type roomField struct {
	Set   bool
	Value *uuid.UUID
}

func (f *roomField) UnmarshalJSON(b []byte) error {
	f.Set = true
	if string(b) == "null" {
		f.Value = nil
		return nil
	}
	var id uuid.UUID
	if err := json.Unmarshal(b, &id); err != nil {
		return err
	}
	f.Value = &id
	return nil
}

func (in boardInput) validate(title, description *string) error {
	fields := map[string]string{}
	var msg string
	if in.Title != nil {
		if *title, msg = projects.NormalizeLine(*in.Title, 120); msg != "" {
			fields["title"] = msg
		}
	}
	if in.Description != nil {
		if *description, msg = projects.NormalizeText(*in.Description, 500); msg != "" {
			fields["description"] = msg
		}
	}
	if *title == "" && fields["title"] == "" {
		fields["title"] = "Use 1 to 120 characters."
	}
	if len(fields) > 0 {
		return httpx.Invalid(fields)
	}
	return nil
}

// checkRoom accepts a room the caller is admitted to; rooms they cannot see answer like
// rooms that do not exist.
func checkRoom(ctx context.Context, q database.Querier, m *org.Membership, id *uuid.UUID) error {
	if id == nil {
		return nil
	}
	refs, err := chat.VisibleChannels(ctx, q, m, []uuid.UUID{*id})
	if err != nil {
		return err
	}
	if ref, ok := refs[*id]; !ok || ref.Kind != chat.KindRoom || !ref.Joined {
		return errRoomLink
	}
	return nil
}

// CreateBoard creates a workspace board (boards.create) or, with projectId, a board of a
// project the caller is a member of.
func (s *Service) CreateBoard(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	m := org.MembershipFrom(ctx)
	var in struct {
		boardInput
		ProjectID *uuid.UUID `json:"projectId"`
	}
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	var title, description string
	if in.Title == nil {
		in.Title = new(string)
	}
	if err := in.validate(&title, &description); err != nil {
		return err
	}
	if in.ProjectID != nil {
		p, err := projects.Load(ctx, s.db, m, *in.ProjectID)
		if err != nil {
			return httpx.Invalid(map[string]string{"projectId": "Choose a project you are a member of."})
		}
		if !p.CanEdit {
			return httpx.ErrForbidden
		}
	} else if !m.Can(org.PermBoardsCreate) {
		return httpx.ErrForbidden
	}
	if err := checkRoom(ctx, s.db, m, in.RoomID.Value); err != nil {
		return err
	}
	id := uuid.Must(uuid.NewV7())
	err := database.InTx(ctx, s.db, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `
			INSERT INTO boards (id, org_id, project_id, room_id, title, description, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
			id, m.Org.ID, in.ProjectID, in.RoomID.Value, title, description, m.UserID); err != nil {
			return err
		}
		ev := audit.FromRequest(r, "board.created")
		ev.OrgID, ev.ActorID = &m.Org.ID, &m.UserID
		ev.TargetType, ev.TargetID = "board", id.String()
		ev.Metadata = map[string]any{"board": title}
		if in.ProjectID != nil {
			ev.Metadata["projectId"] = *in.ProjectID
		}
		return audit.Record(ctx, tx, ev)
	})
	if err != nil {
		return err
	}
	boards, err := queryBoards(ctx, s.db, m, ` AND b.id = $2`, id)
	if err != nil || len(boards) == 0 {
		return err
	}
	httpx.WriteJSON(w, http.StatusCreated, map[string]any{"board": boards[0]})
	return nil
}

// UpdateBoard renames or describes a board, or links a room (editors).
func (s *Service) UpdateBoard(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	m, b, err := s.editableBoard(r)
	if err != nil {
		return err
	}
	var in boardInput
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	title, description := b.Title, b.Description
	if err := in.validate(&title, &description); err != nil {
		return err
	}
	roomID := b.roomID
	if in.RoomID.Set {
		if err := checkRoom(ctx, s.db, m, in.RoomID.Value); err != nil {
			return err
		}
		roomID = in.RoomID.Value
	}
	if _, err := s.db.Exec(ctx, `
		UPDATE boards SET title = $3, description = $4, room_id = $5, updated_at = now() WHERE id = $1 AND org_id = $2`,
		b.ID, m.Org.ID, title, description, roomID); err != nil {
		return err
	}
	s.toViewers(ctx, b.scope, b.ID, realtime.Event{Type: "board.updated", Data: map[string]any{"orgId": m.Org.ID, "boardId": b.ID}})
	boards, err := queryBoards(ctx, s.db, m, ` AND b.id = $2`, b.ID)
	if err != nil || len(boards) == 0 {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"board": boards[0]})
	return nil
}

// DeleteBoard removes a board with its scene: its creator, project leads and project
// managers. People viewing it are told.
func (s *Service) DeleteBoard(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	m, b, err := s.loadBoard(r)
	if err != nil {
		return err
	}
	if !b.CanManage {
		return httpx.ErrForbidden
	}
	err = database.InTx(ctx, s.db, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `DELETE FROM boards WHERE id = $1 AND org_id = $2`, b.ID, m.Org.ID); err != nil {
			return err
		}
		ev := audit.FromRequest(r, "board.deleted")
		ev.OrgID, ev.ActorID = &m.Org.ID, &m.UserID
		ev.TargetType, ev.TargetID = "board", b.ID.String()
		ev.Metadata = map[string]any{"board": b.Title, "elements": b.ElementCount}
		return audit.Record(ctx, tx, ev)
	})
	if err != nil {
		return err
	}
	s.toViewers(ctx, b.scope, b.ID, realtime.Event{Type: "board.deleted", Data: map[string]any{"orgId": m.Org.ID, "boardId": b.ID}})
	s.viewers.drop(b.ID)
	httpx.NoContent(w)
	return nil
}

// allowed returns those of userIDs who may see a board of scope now.
func (s *Service) allowed(ctx context.Context, sc scope, userIDs []uuid.UUID) ([]uuid.UUID, error) {
	if len(userIDs) == 0 {
		return nil, nil
	}
	if sc.projectID != nil {
		return projects.CanSee(ctx, s.db, sc.orgID, *sc.projectID, userIDs)
	}
	rows, err := s.db.Query(ctx, `
		SELECT m.user_id FROM memberships m JOIN roles r ON r.id = m.role_id
		WHERE m.org_id = $1 AND m.user_id = ANY ($2) AND 'boards.create' = ANY (r.permissions)`, sc.orgID, userIDs)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[uuid.UUID])
}

// toViewers sends ev to the people viewing the board who may still see it. Access is
// checked at every send, so someone removed from the project stops receiving the
// board's events at once, before their viewer entry expires.
func (s *Service) toViewers(ctx context.Context, sc scope, boardID uuid.UUID, ev realtime.Event) {
	ids, err := s.allowed(ctx, sc, s.viewers.users(boardID))
	if err != nil || len(ids) == 0 {
		return
	}
	s.events.Publish(ids, ev)
}
