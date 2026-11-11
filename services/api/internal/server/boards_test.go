package server_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"
)

type board struct {
	ID      string `json:"id"`
	Title   string `json:"title"`
	Project *struct {
		ID string `json:"id"`
	} `json:"project"`
	Room *struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	} `json:"room"`
	ElementCount int  `json:"elementCount"`
	CanEdit      bool `json:"canEdit"`
	CanManage    bool `json:"canManage"`
}

type sceneElement struct {
	ID           string `json:"id"`
	Version      int    `json:"version"`
	VersionNonce int    `json:"versionNonce"`
	IsDeleted    bool   `json:"isDeleted"`
	X            int    `json:"x"`
}

func shape(id string, version, nonce, x int, deleted bool) map[string]any {
	return map[string]any{
		"id": id, "type": "rectangle", "version": version, "versionNonce": nonce, "isDeleted": deleted,
		"x": x, "y": 10, "width": 100, "height": 50, "index": "a" + fmt.Sprint(x%10),
	}
}

func (c *client) createBoard(orgID string, body map[string]any) board {
	c.t.Helper()
	var out struct {
		Board board `json:"board"`
	}
	c.must(http.StatusCreated, http.MethodPost, "/api/v1/orgs/"+orgID+"/boards", body).decode(c.t, &out)
	return out.Board
}

func (c *client) scene(orgID, boardID, query string) (board, []sceneElement) {
	c.t.Helper()
	var out struct {
		Board    board          `json:"board"`
		Elements []sceneElement `json:"elements"`
	}
	c.must(http.StatusOK, http.MethodGet, "/api/v1/orgs/"+orgID+"/boards/"+boardID+query, nil).decode(c.t, &out)
	return out.Board, out.Elements
}

func (c *client) saveShapes(orgID, boardID, clientID string, shapes ...map[string]any) int {
	c.t.Helper()
	var out struct {
		Accepted int `json:"accepted"`
	}
	c.must(http.StatusOK, http.MethodPatch, "/api/v1/orgs/"+orgID+"/boards/"+boardID+"/elements",
		map[string]any{"clientId": clientID, "elements": shapes}).decode(c.t, &out)
	return out.Accepted
}

func TestBoardAccessAndMergeRules(t *testing.T) {
	ts := newServer(t)
	owner, orgID := ts.setupInstance()
	emp, empID := ts.join(owner, orgID, "emp@example.com", "employee")
	dev, _ := ts.join(owner, orgID, "dev@example.com", "developer")
	guest, _ := ts.join(owner, orgID, "guest@example.com", "guest")
	base := "/api/v1/orgs/" + orgID + "/boards"

	// Workspace boards are for everyone who may use them; guests get 404.
	expectError(t, guest.do(http.MethodPost, base, map[string]any{"title": "Misafir"}), http.StatusForbidden, "forbidden")
	expectError(t, emp.do(http.MethodPost, base, map[string]any{"title": " "}), http.StatusUnprocessableEntity, "validation_failed")
	ws := emp.createBoard(orgID, map[string]any{"title": "Platform  Mimarisi", "description": "Genel bakış"})
	if ws.Title != "Platform Mimarisi" || !ws.CanEdit || !ws.CanManage || ws.Project != nil {
		t.Fatalf("created = %+v", ws)
	}
	if b, _ := owner.scene(orgID, ws.ID, ""); !b.CanEdit || !b.CanManage {
		t.Fatalf("owner's view = %+v", b)
	}
	if b, _ := dev.scene(orgID, ws.ID, ""); !b.CanEdit || b.CanManage {
		t.Fatalf("developer's view = %+v", b)
	}
	expectError(t, guest.do(http.MethodGet, base+"/"+ws.ID, nil), http.StatusNotFound, "not_found")
	expectError(t, guest.do(http.MethodPost, base+"/"+ws.ID+"/presence", map[string]any{"clientId": "guest-window-1"}), http.StatusNotFound, "not_found")

	// Project boards follow the project: private ones are invisible to non-members, the
	// owner included; viewers of public projects see them read-only.
	private := emp.createProject(orgID, map[string]any{"key": "SEC", "name": "Gizli", "visibility": "private"})
	hidden := emp.createBoard(orgID, map[string]any{"title": "Gizli tahta", "projectId": private.ID})
	expectError(t, owner.do(http.MethodGet, base+"/"+hidden.ID, nil), http.StatusNotFound, "not_found")
	expectError(t, dev.do(http.MethodPost, base, map[string]any{"title": "x", "projectId": private.ID}), http.StatusUnprocessableEntity, "validation_failed")
	public := emp.createProject(orgID, map[string]any{"key": "ENG", "name": "Engineering"})
	pb := emp.createBoard(orgID, map[string]any{"title": "Akış", "projectId": public.ID})
	if b, _ := dev.scene(orgID, pb.ID, ""); b.CanEdit || b.Project == nil || b.Project.ID != public.ID {
		t.Fatalf("viewer's view = %+v", b)
	}
	expectError(t, dev.do(http.MethodPatch, base+"/"+pb.ID+"/elements", map[string]any{"clientId": "dev-window-1", "elements": []any{shape("a", 1, 1, 0, false)}}),
		http.StatusForbidden, "forbidden")
	expectError(t, dev.do(http.MethodPost, base, map[string]any{"title": "x", "projectId": public.ID}), http.StatusForbidden, "forbidden")
	var listed struct {
		Boards []board `json:"boards"`
	}
	owner.must(http.StatusOK, http.MethodGet, base, nil).decode(t, &listed)
	if len(listed.Boards) != 2 {
		t.Fatalf("owner sees %d boards, want the workspace board and the public project's", len(listed.Boards))
	}

	// Merge rules: a higher version wins; on equal versions the lower nonce wins; stale
	// and duplicate copies change nothing, so every order of arrival gives one scene.
	const win = "emp-window-1"
	if n := emp.saveShapes(orgID, ws.ID, win, shape("a", 1, 100, 1, false), shape("b", 1, 7, 2, false)); n != 2 {
		t.Fatalf("accepted %d of 2 new shapes", n)
	}
	if n := emp.saveShapes(orgID, ws.ID, win, shape("a", 3, 50, 3, false)); n != 1 {
		t.Fatal("a higher version was refused")
	}
	if n := owner.saveShapes(orgID, ws.ID, "owner-window-1", shape("a", 2, 1, 4, false)); n != 0 {
		t.Fatal("a lower version replaced a higher one")
	}
	if n := owner.saveShapes(orgID, ws.ID, "owner-window-1", shape("a", 3, 60, 5, false)); n != 0 {
		t.Fatal("an equal version with a higher nonce won")
	}
	if n := owner.saveShapes(orgID, ws.ID, "owner-window-1", shape("a", 3, 40, 6, false)); n != 1 {
		t.Fatal("an equal version with a lower nonce lost")
	}
	if n := emp.saveShapes(orgID, ws.ID, win, shape("a", 3, 40, 6, false)); n != 0 {
		t.Fatal("the same copy was applied twice")
	}
	_, scene := emp.scene(orgID, ws.ID, "")
	if a := byID(scene, "a"); len(scene) != 2 || a.Version != 3 || a.VersionNonce != 40 || a.X != 6 {
		t.Fatalf("scene = %+v", scene)
	}
	// Deleting leaves a tombstone that stale copies cannot undo.
	emp.saveShapes(orgID, ws.ID, win, shape("b", 2, 7, 2, true))
	if n := owner.saveShapes(orgID, ws.ID, "owner-window-1", shape("b", 1, 1, 9, false)); n != 0 {
		t.Fatal("a stale copy brought a deleted shape back")
	}
	if b, scene := owner.scene(orgID, ws.ID, ""); len(scene) != 1 || b.ElementCount != 1 {
		t.Fatalf("scene after delete = %+v (count %d)", scene, b.ElementCount)
	}
	if _, all := owner.scene(orgID, ws.ID, "?deleted=true"); len(all) != 2 || !byID(all, "b").IsDeleted {
		t.Fatalf("scene with tombstones = %+v", all)
	}

	// Invalid batches.
	for name, body := range map[string]map[string]any{
		"image":     {"clientId": win, "elements": []any{map[string]any{"id": "img", "type": "image", "version": 1, "versionNonce": 1}}},
		"client id": {"clientId": "x", "elements": []any{shape("c", 1, 1, 1, false)}},
		"no shapes": {"clientId": win, "elements": []any{}},
	} {
		if r := emp.do(http.MethodPatch, base+"/"+ws.ID+"/elements", body); r.status != http.StatusUnprocessableEntity {
			t.Errorf("%s: status %d", name, r.status)
		}
	}

	// A linked room shows only to people who may see the room.
	rm := emp.createRoom(orgID, map[string]any{"name": "Mimari Toplantısı", "access": "restricted", "memberIds": []string{empID}})
	expectError(t, dev.do(http.MethodPatch, base+"/"+ws.ID, map[string]any{"roomId": rm.ID}), http.StatusUnprocessableEntity, "validation_failed")
	var updated struct {
		Board board `json:"board"`
	}
	emp.must(http.StatusOK, http.MethodPatch, base+"/"+ws.ID, map[string]any{"roomId": rm.ID}).decode(t, &updated)
	if updated.Board.Room == nil || updated.Board.Room.Name != "Mimari Toplantısı" {
		t.Fatalf("linked room = %+v", updated.Board.Room)
	}
	if b, _ := dev.scene(orgID, ws.ID, ""); b.Room != nil {
		t.Fatalf("a restricted room was shown to someone off its list: %+v", b.Room)
	}

	// Deleting: creators and project managers only; it is audited.
	expectError(t, dev.do(http.MethodDelete, base+"/"+ws.ID, nil), http.StatusForbidden, "forbidden")
	owner.must(http.StatusNoContent, http.MethodDelete, base+"/"+ws.ID, nil)
	expectError(t, emp.do(http.MethodGet, base+"/"+ws.ID, nil), http.StatusNotFound, "not_found")
}

func TestBoardEventsReachOnlyCurrentViewers(t *testing.T) {
	ts := newServer(t)
	owner, orgID := ts.setupInstance()
	alex, alexID := ts.join(owner, orgID, "alex@example.com", "developer")
	dana, danaID := ts.join(owner, orgID, "dana@example.com", "developer")
	cem, cemID := ts.join(owner, orgID, "cem@example.com", "developer")
	eda, _ := ts.join(owner, orgID, "eda@example.com", "employee")
	p := alex.createProject(orgID, map[string]any{"key": "ARC", "name": "Mimari", "visibility": "private", "memberIds": []string{danaID, cemID}})
	b := alex.createBoard(orgID, map[string]any{"title": "Mimari", "projectId": p.ID})
	base := "/api/v1/orgs/" + orgID + "/boards/" + b.ID
	isBoard := roomEvent(b.ID)

	alexEvents, danaEvents, cemEvents := alex.events(), dana.events(), cem.events()
	var viewers struct {
		Viewers []struct {
			User projectPerson `json:"user"`
		} `json:"viewers"`
	}
	alex.must(http.StatusOK, http.MethodPost, base+"/presence", map[string]any{"clientId": "alex-window-1"})
	dana.must(http.StatusOK, http.MethodPost, base+"/presence", map[string]any{"clientId": "dana-window-1"}).decode(t, &viewers)
	if len(viewers.Viewers) != 2 || viewers.Viewers[0].User.ID != alexID {
		t.Fatalf("viewers = %+v", viewers)
	}
	alexEvents.waitFor("board.viewers", func(data json.RawMessage) bool { return isBoard(data) && strings.Contains(string(data), danaID) })
	// People who may not see the board cannot register as viewers.
	expectError(t, eda.do(http.MethodPost, base+"/presence", map[string]any{"clientId": "eda-window-1"}), http.StatusNotFound, "not_found")

	// Scene changes go to the viewers — the sender's other windows included — and not to
	// members who do not have the board open.
	alex.saveShapes(orgID, b.ID, "alex-window-1", shape("a", 1, 5, 1, false))
	var scene struct {
		ClientID string         `json:"clientId"`
		User     projectPerson  `json:"user"`
		Elements []sceneElement `json:"elements"`
	}
	if err := json.Unmarshal(danaEvents.waitFor("board.elements", isBoard).Data, &scene); err != nil ||
		scene.ClientID != "alex-window-1" || scene.User.ID != alexID || len(scene.Elements) != 1 || scene.Elements[0].ID != "a" {
		t.Fatalf("board.elements = %+v, %v", scene, err)
	}
	alexEvents.waitFor("board.elements", isBoard)
	cemEvents.quiet()

	// Cursors are relayed to viewers and never stored.
	var before struct{ updated time.Time }
	if err := ts.db.QueryRow(t.Context(), `SELECT updated_at FROM boards WHERE id = $1`, b.ID).Scan(&before.updated); err != nil {
		t.Fatal(err)
	}
	dana.must(http.StatusNoContent, http.MethodPost, base+"/cursor",
		map[string]any{"clientId": "dana-window-1", "x": 120.5, "y": -40, "tool": "pointer", "button": "up"})
	var cursor struct {
		User    projectPerson `json:"user"`
		Pointer struct {
			X, Y float64
			Tool string
		} `json:"pointer"`
	}
	if err := json.Unmarshal(alexEvents.waitFor("board.cursor", isBoard).Data, &cursor); err != nil ||
		cursor.User.ID != danaID || cursor.Pointer.X != 120.5 || cursor.Pointer.Y != -40 || cursor.Pointer.Tool != "pointer" {
		t.Fatalf("board.cursor = %+v, %v", cursor, err)
	}
	cemEvents.quiet()
	var after struct {
		updated time.Time
		count   int
	}
	if err := ts.db.QueryRow(t.Context(), `SELECT b.updated_at, (SELECT count(*) FROM board_elements WHERE board_id = b.id) FROM boards b WHERE b.id = $1`, b.ID).
		Scan(&after.updated, &after.count); err != nil {
		t.Fatal(err)
	}
	if !after.updated.Equal(before.updated) || after.count != 1 {
		t.Fatalf("a cursor changed the board: updated %v → %v, %d elements", before.updated, after.updated, after.count)
	}
	expectError(t, dana.do(http.MethodPost, base+"/cursor", map[string]any{"clientId": "dana-window-1", "x": 1, "y": 1, "tool": "pen", "button": "up"}),
		http.StatusUnprocessableEntity, "validation_failed")

	// Someone taken off the project stops receiving the board's events at once, before
	// their viewer entry expires.
	alex.must(http.StatusOK, http.MethodDelete, "/api/v1/orgs/"+orgID+"/projects/"+p.ID+"/members/"+danaID, nil)
	danaEvents.waitFor("project.updated", roomEvent(p.ID))
	cemEvents.waitFor("project.updated", roomEvent(p.ID))
	alex.saveShapes(orgID, b.ID, "alex-window-1", shape("a", 2, 5, 2, false))
	alexEvents.waitFor("board.elements", isBoard)
	danaEvents.quiet()
	expectError(t, dana.do(http.MethodPost, base+"/presence", map[string]any{"clientId": "dana-window-1"}), http.StatusNotFound, "not_found")

	// Leaving tells the remaining viewers.
	cem.must(http.StatusOK, http.MethodPost, base+"/presence", map[string]any{"clientId": "cem-window-1"})
	alexEvents.waitFor("board.viewers", func(data json.RawMessage) bool { return isBoard(data) && strings.Contains(string(data), cemID) })
	cem.must(http.StatusNoContent, http.MethodDelete, base+"/presence?clientId=cem-window-1", nil)
	var left struct {
		Viewers []struct {
			User projectPerson `json:"user"`
		} `json:"viewers"`
	}
	if err := json.Unmarshal(alexEvents.waitFor("board.viewers", func(data json.RawMessage) bool {
		return isBoard(data) && !strings.Contains(string(data), cemID)
	}).Data, &left); err != nil || len(left.Viewers) != 1 || left.Viewers[0].User.ID != alexID {
		// Dana's window is still registered, but she may no longer see the board.
		t.Fatalf("viewers after leaving = %+v, %v", left, err)
	}
}

func byID(elements []sceneElement, id string) sceneElement {
	for _, e := range elements {
		if e.ID == id {
			return e
		}
	}
	return sceneElement{}
}

// Boards stay bounded: shapes cannot be made permanent with outlandish versions, and the
// stored scene, deleted shapes included, has a size limit that old deletions make room
// for first.
func TestBoardLimits(t *testing.T) {
	ts := newServer(t)
	owner, orgID := ts.setupInstance()
	b := owner.createBoard(orgID, map[string]any{"title": "Sınırlar"})
	const win = "owner-window-1"

	// Versions may only grow by a bounded step, and new shapes start low.
	if n := owner.saveShapes(orgID, b.ID, win, shape("a", 1, 5, 0, false)); n != 1 {
		t.Fatalf("accepted %d", n)
	}
	if n := owner.saveShapes(orgID, b.ID, win, shape("a", 1+(1<<21), 5, 1, false)); n != 0 {
		t.Fatal("a version jump far beyond the last edit was accepted")
	}
	if n := owner.saveShapes(orgID, b.ID, win, shape("a", 2, 5, 2, false)); n != 1 {
		t.Fatal("a normal edit after a refused jump was not accepted")
	}
	if n := owner.saveShapes(orgID, b.ID, win, shape("huge", (1<<31)+1, 5, 0, false)); n != 0 {
		t.Fatal("a new shape with an outlandish version was accepted")
	}

	// Fill the board close to its size limit with large shapes, then delete them all:
	// the deletions are kept, but new shapes still fit because the oldest ones go first.
	big := func(id string, version int, deleted bool) map[string]any {
		s := shape(id, version, 7, 3, deleted)
		s["type"] = "freedraw"
		s["customData"] = map[string]string{"pad": strings.Repeat("x", 250<<10)}
		return s
	}
	const perBatch = 12
	var ids []string
	for i := range 130 {
		ids = append(ids, fmt.Sprintf("big%03d", i))
	}
	save := func(version int, deleted bool, list []string) {
		for start := 0; start < len(list); start += perBatch {
			var batch []map[string]any
			for _, id := range list[start:min(start+perBatch, len(list))] {
				batch = append(batch, big(id, version, deleted))
			}
			owner.saveShapes(orgID, b.ID, win, batch...)
			time.Sleep(60 * time.Millisecond) // stay under the write rate limit
		}
	}
	save(1, false, ids)
	// The board is now full: one more large shape does not fit while everything is live.
	r := owner.do(http.MethodPatch, "/api/v1/orgs/"+orgID+"/boards/"+b.ID+"/elements",
		map[string]any{"clientId": win, "elements": []any{big("extra", 1, false)}})
	expectError(t, r, http.StatusConflict, "board_too_large")
	save(2, true, ids)
	// After deleting, new large shapes fit: the oldest deleted ones make room.
	var fresh []string
	for i := range 24 {
		fresh = append(fresh, fmt.Sprintf("new%03d", i))
	}
	save(1, false, fresh)
	_, live := owner.scene(orgID, b.ID, "")
	if len(live) != 1+len(fresh) {
		t.Fatalf("live shapes = %d, want %d", len(live), 1+len(fresh))
	}
	var stored int
	if err := ts.db.QueryRow(t.Context(), `SELECT coalesce(sum(size), 0) FROM board_elements WHERE board_id = $1`, b.ID).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if stored > 32<<20 {
		t.Fatalf("stored %d bytes, over the limit", stored)
	}
}
