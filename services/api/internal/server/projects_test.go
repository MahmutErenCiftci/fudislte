package server_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"testing"
)

type projectPerson struct {
	ID          string `json:"id"`
	DisplayName string `json:"displayName"`
}

type taskStatus struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Category string `json:"category"`
}

type sprint struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	State     string `json:"state"`
	TaskCount int    `json:"taskCount"`
	DoneCount int    `json:"doneCount"`
}

type project struct {
	ID         string `json:"id"`
	Key        string `json:"key"`
	Name       string `json:"name"`
	Visibility string `json:"visibility"`
	Status     string `json:"status"`
	Role       string `json:"role"`
	CanEdit    bool   `json:"canEdit"`
	CanManage  bool   `json:"canManage"`
	TaskCount  int    `json:"taskCount"`
	Members    []struct {
		User projectPerson `json:"user"`
		Role string        `json:"role"`
	} `json:"members"`
	Statuses []taskStatus `json:"statuses"`
	Labels   []struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	} `json:"labels"`
	Sprints []sprint `json:"sprints"`
}

type task struct {
	ID          string          `json:"id"`
	Number      int             `json:"number"`
	Key         string          `json:"key"`
	Title       string          `json:"title"`
	Status      taskStatus      `json:"status"`
	Priority    string          `json:"priority"`
	DueOn       *string         `json:"dueOn"`
	SprintID    *string         `json:"sprintId"`
	Rank        string          `json:"rank"`
	Assignees   []projectPerson `json:"assignees"`
	CompletedAt *string         `json:"completedAt"`
	Checklist   struct {
		Done  int `json:"done"`
		Total int `json:"total"`
	} `json:"checklist"`
	CommentCount int    `json:"commentCount"`
	Description  string `json:"description"`
	Comments     []struct {
		ID   string `json:"id"`
		Body string `json:"body"`
	} `json:"comments"`
	Links []struct {
		ID   string `json:"id"`
		Kind string `json:"kind"`
		Name string `json:"name"`
	} `json:"links"`
	Activity []struct {
		Kind string          `json:"kind"`
		Data json.RawMessage `json:"data"`
	} `json:"activity"`
}

func (c *client) createProject(orgID string, body map[string]any) project {
	c.t.Helper()
	var out struct {
		Project project `json:"project"`
	}
	c.must(http.StatusCreated, http.MethodPost, "/api/v1/orgs/"+orgID+"/projects", body).decode(c.t, &out)
	return out.Project
}

func (c *client) project(orgID, id string) project {
	c.t.Helper()
	var out struct {
		Project project `json:"project"`
	}
	c.must(http.StatusOK, http.MethodGet, "/api/v1/orgs/"+orgID+"/projects/"+id, nil).decode(c.t, &out)
	return out.Project
}

func (c *client) projects(orgID string) []project {
	c.t.Helper()
	var out struct {
		Projects []project `json:"projects"`
	}
	c.must(http.StatusOK, http.MethodGet, "/api/v1/orgs/"+orgID+"/projects", nil).decode(c.t, &out)
	return out.Projects
}

func taskPath(orgID, projectID string, rest ...string) string {
	return "/api/v1/orgs/" + orgID + "/projects/" + projectID + "/tasks" + strings.Join(rest, "")
}

func (c *client) createTask(orgID, projectID string, body map[string]any) task {
	c.t.Helper()
	var out struct {
		Task task `json:"task"`
	}
	c.must(http.StatusCreated, http.MethodPost, taskPath(orgID, projectID), body).decode(c.t, &out)
	return out.Task
}

func (c *client) patchTask(orgID, projectID, taskID string, body map[string]any) task {
	c.t.Helper()
	var out struct {
		Task task `json:"task"`
	}
	c.must(http.StatusOK, http.MethodPatch, taskPath(orgID, projectID, "/", taskID), body).decode(c.t, &out)
	return out.Task
}

func (c *client) task(orgID, projectID, taskID string) task {
	c.t.Helper()
	var out struct {
		Task task `json:"task"`
	}
	c.must(http.StatusOK, http.MethodGet, taskPath(orgID, projectID, "/", taskID), nil).decode(c.t, &out)
	return out.Task
}

func (c *client) tasks(orgID, projectID string) []task {
	c.t.Helper()
	var out struct {
		Tasks []task `json:"tasks"`
	}
	c.must(http.StatusOK, http.MethodGet, taskPath(orgID, projectID), nil).decode(c.t, &out)
	return out.Tasks
}

func statusNamed(p project, name string) taskStatus {
	for _, s := range p.Statuses {
		if s.Name == name {
			return s
		}
	}
	panic("no status " + name)
}

func activityKinds(t task) []string {
	var kinds []string
	for _, e := range t.Activity {
		kinds = append(kinds, e.Kind)
	}
	return kinds
}

func TestProjectAccess(t *testing.T) {
	ts := newServer(t)
	owner, orgID := ts.setupInstance()
	lead, _ := ts.join(owner, orgID, "lead@example.com", "team-leader")
	dev, devID := ts.join(owner, orgID, "dev@example.com", "developer")
	emp, _ := ts.join(owner, orgID, "emp@example.com", "employee")
	guest, guestID := ts.join(owner, orgID, "guest@example.com", "guest")
	base := "/api/v1/orgs/" + orgID + "/projects"

	// Validation.
	invalid := func(r response) map[string]string {
		t.Helper()
		expectError(t, r, http.StatusUnprocessableEntity, "validation_failed")
		var e apiError
		r.decode(t, &e)
		return e.Error.Fields
	}
	fields := invalid(lead.do(http.MethodPost, base, map[string]any{
		"key": "E", "name": " ", "visibility": "secret", "color": "plaid", "startsOn": "2026-12-01", "endsOn": "2026-11-01",
	}))
	for _, f := range []string{"key", "name", "visibility", "color", "endsOn"} {
		if fields[f] == "" {
			t.Errorf("no error for %s: %v", f, fields)
		}
	}
	expectError(t, guest.do(http.MethodPost, base, map[string]any{"key": "GST", "name": "Misafir"}), http.StatusForbidden, "forbidden")

	secret := lead.createProject(orgID, map[string]any{"key": "sec", "name": "  Gizli   Proje ", "visibility": "private", "memberIds": []string{devID}})
	if secret.Key != "SEC" || secret.Name != "Gizli Proje" || secret.Role != "lead" || !secret.CanManage || !secret.CanEdit ||
		len(secret.Members) != 2 || len(secret.Statuses) != 4 || secret.Statuses[0].Name != "Yapılacak" || secret.Statuses[3].Category != "done" {
		t.Fatalf("created = %+v", secret)
	}
	if f := invalid(emp.do(http.MethodPost, base, map[string]any{"key": "SEC", "name": "Kopya"})); f["key"] == "" {
		t.Fatalf("duplicate key accepted: %v", f)
	}
	todo := lead.createTask(orgID, secret.ID, map[string]any{"title": "Gizli görev"})

	// Exit criterion: private projects are invisible to non-members — the owner included.
	for _, c := range []*client{owner, emp, guest} {
		for _, path := range []string{"", "/tasks", "/tasks/" + todo.ID, "/activity"} {
			expectError(t, c.do(http.MethodGet, base+"/"+secret.ID+path, nil), http.StatusNotFound, "not_found")
		}
		expectError(t, c.do(http.MethodPatch, base+"/"+secret.ID, map[string]any{"name": "x"}), http.StatusNotFound, "not_found")
		expectError(t, c.do(http.MethodPost, base+"/"+secret.ID+"/join", nil), http.StatusNotFound, "not_found")
		for _, p := range c.projects(orgID) {
			if p.ID == secret.ID {
				t.Fatal("private project listed for a non-member")
			}
		}
	}
	if got := dev.project(orgID, secret.ID); got.Role != "member" || got.CanManage || !got.CanEdit {
		t.Fatalf("member's view = %+v", got)
	}

	// Public projects: everyone who may view projects sees them; changing tasks needs membership.
	open := lead.createProject(orgID, map[string]any{"key": "ENG", "name": "Engineering", "visibility": "public"})
	seen := emp.project(orgID, open.ID)
	if seen.Role != "" || seen.CanEdit || seen.CanManage {
		t.Fatalf("viewer's view = %+v", seen)
	}
	expectError(t, emp.do(http.MethodPost, taskPath(orgID, open.ID), map[string]any{"title": "x"}), http.StatusForbidden, "not_project_member")
	expectError(t, emp.do(http.MethodPatch, base+"/"+open.ID, map[string]any{"name": "x"}), http.StatusForbidden, "forbidden")
	emp.must(http.StatusOK, http.MethodPost, base+"/"+open.ID+"/join", nil)
	emp.createTask(orgID, open.ID, map[string]any{"title": "Katıldım"})
	// Project managers (projects.manage) manage public projects they can see.
	if p := owner.project(orgID, open.ID); !p.CanManage || p.CanEdit {
		t.Fatalf("owner's view of a public project = %+v", p)
	}
	owner.must(http.StatusOK, http.MethodPatch, base+"/"+open.ID, map[string]any{"description": "Platform ekibi"})

	// Guests see only projects they are added to, and then take part.
	expectError(t, guest.do(http.MethodGet, base+"/"+open.ID, nil), http.StatusNotFound, "not_found")
	expectError(t, guest.do(http.MethodPost, base+"/"+open.ID+"/join", nil), http.StatusNotFound, "not_found")
	lead.must(http.StatusOK, http.MethodPost, base+"/"+open.ID+"/members", map[string]any{"userIds": []string{guestID}})
	if got := guest.projects(orgID); len(got) != 1 || got[0].ID != open.ID || !got[0].CanEdit {
		t.Fatalf("guest projects = %+v", got)
	}
	guest.createTask(orgID, open.ID, map[string]any{"title": "Misafir görevi"})

	// Making a project private hides it from viewers at once.
	lead.must(http.StatusOK, http.MethodPatch, base+"/"+open.ID, map[string]any{"visibility": "private"})
	expectError(t, owner.do(http.MethodGet, base+"/"+open.ID, nil), http.StatusNotFound, "not_found")
	emp.project(orgID, open.ID) // a member

	// A project keeps a lead; members leave; archived projects are read-only.
	leadID := lead.me().User.ID
	expectError(t, lead.do(http.MethodDelete, base+"/"+open.ID+"/members/"+leadID, nil), http.StatusConflict, "last_lead")
	expectError(t, lead.do(http.MethodPatch, base+"/"+open.ID+"/members/"+leadID, map[string]any{"role": "member"}), http.StatusConflict, "last_lead")
	guest.must(http.StatusNoContent, http.MethodDelete, base+"/"+open.ID+"/members/"+guestID, nil)
	expectError(t, guest.do(http.MethodGet, base+"/"+open.ID, nil), http.StatusNotFound, "not_found")
	lead.must(http.StatusOK, http.MethodPost, base+"/"+open.ID+"/archive", nil)
	expectError(t, emp.do(http.MethodPost, taskPath(orgID, open.ID), map[string]any{"title": "x"}), http.StatusConflict, "project_archived")
	if p := emp.project(orgID, open.ID); p.Status != "archived" || p.CanEdit {
		t.Fatalf("archived = %+v", p)
	}
	lead.must(http.StatusOK, http.MethodPost, base+"/"+open.ID+"/unarchive", nil)

	// Projects never cross workspaces.
	var other struct {
		Organization struct {
			ID string `json:"id"`
		} `json:"organization"`
	}
	owner.must(http.StatusCreated, http.MethodPost, "/api/v1/orgs", map[string]string{"name": "Finance"}).decode(t, &other)
	otherBase := "/api/v1/orgs/" + other.Organization.ID + "/projects"
	expectError(t, owner.do(http.MethodGet, otherBase+"/"+open.ID, nil), http.StatusNotFound, "not_found")
	fin := owner.createProject(other.Organization.ID, map[string]any{"key": "ENG", "name": "Finans"}) // keys are per workspace
	if f := invalid(owner.do(http.MethodPost, otherBase+"/"+fin.ID+"/members", map[string]any{"userIds": []string{devID}})); f["userIds"] == "" {
		t.Fatalf("a member of another workspace was added: %v", f)
	}
	expectError(t, owner.do(http.MethodGet, base+"/"+fin.ID, nil), http.StatusNotFound, "not_found")

	// Membership changes and archiving are audited.
	var audit struct {
		Events []struct {
			Action string `json:"action"`
		} `json:"events"`
	}
	owner.must(http.StatusOK, http.MethodGet, "/api/v1/orgs/"+orgID+"/audit-events?limit=100", nil).decode(t, &audit)
	got := map[string]bool{}
	for _, e := range audit.Events {
		got[e.Action] = true
	}
	for _, a := range []string{"project.created", "project.updated", "project.members_changed", "project.archived", "project.restored"} {
		if !got[a] {
			t.Errorf("audit log lacks %s", a)
		}
	}
}

func TestDefaultWorkflowFollowsTheCreatorsLanguage(t *testing.T) {
	ts := newServer(t)
	owner, orgID := ts.setupInstance()
	var out struct {
		Project project `json:"project"`
	}
	r := owner.request(http.MethodPost, "/api/v1/orgs/"+orgID+"/projects", map[string]any{"key": "WEB", "name": "Web"}, lang("en-US"))
	r.decode(t, &out)
	names := []string{}
	for _, s := range out.Project.Statuses {
		names = append(names, s.Name)
	}
	if strings.Join(names, ",") != "To Do,In Progress,In Review,Done" {
		t.Fatalf("statuses = %v", names)
	}
}

func TestTaskNumberingMovesAndActivity(t *testing.T) {
	ts := newServer(t)
	owner, orgID := ts.setupInstance()
	emp, empID := ts.join(owner, orgID, "emp@example.com", "employee")
	guest, _ := ts.join(owner, orgID, "guest@example.com", "guest")
	p := owner.createProject(orgID, map[string]any{"key": "ENG", "name": "Engineering", "memberIds": []string{empID}})

	// Numbers are unique and gapless, even when tasks are created at once.
	var wg sync.WaitGroup
	numbers := make(chan int, 12)
	for i := range 12 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			c := owner
			if i%2 == 1 {
				c = emp
			}
			r := c.do(http.MethodPost, taskPath(orgID, p.ID), map[string]any{"title": fmt.Sprintf("Görev %d", i)})
			var out struct {
				Task task `json:"task"`
			}
			if r.status == http.StatusCreated && json.Unmarshal(r.body, &out) == nil {
				numbers <- out.Task.Number
			}
		}()
	}
	wg.Wait()
	close(numbers)
	seen := map[int]bool{}
	for n := range numbers {
		seen[n] = true
	}
	for n := 1; n <= 12; n++ {
		if !seen[n] {
			t.Fatalf("numbers = %v, want 1..12", seen)
		}
	}
	tasks := owner.tasks(orgID, p.ID)
	if len(tasks) != 12 || tasks[0].Key != fmt.Sprintf("ENG-%d", tasks[0].Number) {
		t.Fatalf("tasks = %+v", tasks)
	}

	// Validation.
	expectError(t, owner.do(http.MethodPost, taskPath(orgID, p.ID), map[string]any{"title": " ", "priority": "asap", "dueOn": "yarın"}),
		http.StatusUnprocessableEntity, "validation_failed")
	expectError(t, owner.do(http.MethodPatch, taskPath(orgID, p.ID, "/", tasks[0].ID), map[string]any{"rank": "a0-"}),
		http.StatusUnprocessableEntity, "validation_failed")

	// Moving to another status appends to that column, with an activity entry; a done
	// status completes the task, leaving it reopens it. Viewers hear about every change.
	doing, done := statusNamed(p, "Devam Ediyor"), statusNamed(p, "Tamamlandı")
	empEvents, guestEvents := emp.events(), guest.events()
	first := owner.createTask(orgID, p.ID, map[string]any{"title": "Ödeme akışı", "priority": "high", "dueOn": "2026-11-20"})
	empEvents.waitFor("task.updated", roomEvent(first.ID))
	moved := owner.patchTask(orgID, p.ID, first.ID, map[string]any{"statusId": doing.ID})
	if moved.Status.ID != doing.ID || moved.CompletedAt != nil || moved.Number != 13 || moved.DueOn == nil || *moved.DueOn != "2026-11-20" {
		t.Fatalf("moved = %+v", moved)
	}
	var ev struct {
		ProjectID string `json:"projectId"`
		Task      task   `json:"task"`
	}
	if err := json.Unmarshal(empEvents.waitFor("task.updated", roomEvent(first.ID)).Data, &ev); err != nil || ev.Task.Status.ID != doing.ID {
		t.Fatalf("task.updated = %+v, %v", ev, err)
	}
	guestEvents.quiet() // guests do not see the project
	second := owner.createTask(orgID, p.ID, map[string]any{"title": "İkinci", "statusId": doing.ID})
	if second.Rank <= moved.Rank {
		t.Fatalf("new task rank %q is not after %q", second.Rank, moved.Rank)
	}
	completed := emp.patchTask(orgID, p.ID, first.ID, map[string]any{"statusId": done.ID, "dueOn": nil})
	if completed.CompletedAt == nil || completed.DueOn != nil {
		t.Fatalf("completed = %+v", completed)
	}
	reopened := emp.patchTask(orgID, p.ID, first.ID, map[string]any{"statusId": doing.ID, "rank": "a0"})
	if reopened.CompletedAt != nil || reopened.Rank != "a0" {
		t.Fatalf("reopened = %+v", reopened)
	}
	// Within a column the client's rank decides the order.
	col := []string{}
	for _, tk := range owner.tasks(orgID, p.ID) {
		if tk.Status.ID == doing.ID {
			col = append(col, tk.Title)
		}
	}
	if strings.Join(col, "|") != "Ödeme akışı|İkinci" {
		t.Fatalf("column = %v", col)
	}
	detail := owner.task(orgID, p.ID, first.ID)
	kinds := strings.Join(activityKinds(detail), ",")
	if kinds != "status_changed,due_changed,status_changed,status_changed,created" {
		t.Fatalf("activity = %s", kinds)
	}
	var change struct {
		From struct{ Name string } `json:"from"`
		To   struct{ Name string } `json:"to"`
	}
	if err := json.Unmarshal(detail.Activity[0].Data, &change); err != nil || change.From.Name != "Tamamlandı" || change.To.Name != "Devam Ediyor" {
		t.Fatalf("status change = %s", detail.Activity[0].Data)
	}

	// Only the creator or a project manager deletes a task; deletions are audited.
	expectError(t, emp.do(http.MethodDelete, taskPath(orgID, p.ID, "/", first.ID), nil), http.StatusForbidden, "forbidden")
	owner.must(http.StatusNoContent, http.MethodDelete, taskPath(orgID, p.ID, "/", first.ID), nil)
	empEvents.waitFor("task.deleted", roomEvent(first.ID))
	expectError(t, owner.do(http.MethodGet, taskPath(orgID, p.ID, "/", first.ID), nil), http.StatusNotFound, "not_found")
	if next := owner.createTask(orgID, p.ID, map[string]any{"title": "Sonraki"}); next.Number != 15 {
		t.Fatalf("numbers are reused: %d", next.Number)
	}
}

func TestTaskAssignmentAndDetails(t *testing.T) {
	ts := newServer(t)
	owner, orgID := ts.setupInstance()
	lead, leadID := ts.join(owner, orgID, "lead@example.com", "team-leader")
	dev, devID := ts.join(owner, orgID, "dev@example.com", "developer")
	_, empID := ts.join(owner, orgID, "emp@example.com", "employee")
	p := lead.createProject(orgID, map[string]any{"key": "OPS", "name": "Operasyon", "visibility": "private", "memberIds": []string{devID}})
	base := "/api/v1/orgs/" + orgID + "/projects/" + p.ID

	// Only project members can be assigned.
	r := lead.do(http.MethodPost, taskPath(orgID, p.ID), map[string]any{"title": "Yedekleme", "assigneeIds": []string{empID}})
	expectError(t, r, http.StatusUnprocessableEntity, "validation_failed")
	tk := lead.createTask(orgID, p.ID, map[string]any{"title": "Yedekleme", "assigneeIds": []string{devID, leadID}})
	if len(tk.Assignees) != 2 {
		t.Fatalf("assignees = %+v", tk.Assignees)
	}
	tk = dev.patchTask(orgID, p.ID, tk.ID, map[string]any{"assigneeIds": []string{devID}})
	if len(tk.Assignees) != 1 || tk.Assignees[0].ID != devID {
		t.Fatalf("after unassigning = %+v", tk.Assignees)
	}
	kinds := strings.Join(activityKinds(dev.task(orgID, p.ID, tk.ID)), ",")
	if kinds != "unassigned,assigned,assigned,created" {
		t.Fatalf("activity = %s", kinds)
	}

	// My tasks lists assigned open tasks across projects.
	var mine struct {
		Tasks []task `json:"tasks"`
	}
	dev.must(http.StatusOK, http.MethodGet, "/api/v1/orgs/"+orgID+"/tasks", nil).decode(t, &mine)
	if len(mine.Tasks) != 1 || mine.Tasks[0].Key != "OPS-1" {
		t.Fatalf("my tasks = %+v", mine.Tasks)
	}
	var found struct {
		Tasks []task `json:"tasks"`
	}
	dev.must(http.StatusOK, http.MethodGet, "/api/v1/orgs/"+orgID+"/tasks?q=ops-1", nil).decode(t, &found)
	if len(found.Tasks) != 1 {
		t.Fatalf("search by key = %+v", found.Tasks)
	}
	owner.must(http.StatusOK, http.MethodGet, "/api/v1/orgs/"+orgID+"/tasks?q=yedek", nil).decode(t, &found)
	if len(found.Tasks) != 0 {
		t.Fatal("search found a task of a private project the caller is not in")
	}

	// Checklist, comments and labels.
	label := struct {
		Label struct {
			ID string `json:"id"`
		} `json:"label"`
	}{}
	lead.must(http.StatusCreated, http.MethodPost, base+"/labels", map[string]any{"name": "Altyapı", "color": "violet"}).decode(t, &label)
	expectError(t, lead.do(http.MethodPost, base+"/labels", map[string]any{"name": "altyapı"}), http.StatusUnprocessableEntity, "validation_failed")
	expectError(t, dev.do(http.MethodPost, base+"/labels", map[string]any{"name": "Yetkisiz"}), http.StatusForbidden, "forbidden")
	dev.patchTask(orgID, p.ID, tk.ID, map[string]any{"labelIds": []string{label.Label.ID}})
	dev.must(http.StatusCreated, http.MethodPost, taskPath(orgID, p.ID, "/", tk.ID, "/checklist"), map[string]any{"text": "Disk alanı"})
	var withItems struct {
		Task struct {
			Items []struct {
				ID string `json:"id"`
			} `json:"checklistItems"`
		} `json:"task"`
	}
	dev.must(http.StatusCreated, http.MethodPost, taskPath(orgID, p.ID, "/", tk.ID, "/checklist"), map[string]any{"text": "Geri yükleme"}).decode(t, &withItems)
	dev.must(http.StatusOK, http.MethodPatch, taskPath(orgID, p.ID, "/", tk.ID, "/checklist/", withItems.Task.Items[0].ID), map[string]any{"done": true})
	var commented struct {
		Task task `json:"task"`
	}
	dev.must(http.StatusCreated, http.MethodPost, taskPath(orgID, p.ID, "/", tk.ID, "/comments"), map[string]any{"body": "Gece 02:00\nçalışsın"}).decode(t, &commented)
	comment := commented.Task.Comments[0]
	if comment.Body != "Gece 02:00\nçalışsın" || commented.Task.CommentCount != 1 || commented.Task.Checklist.Done != 1 || commented.Task.Checklist.Total != 2 {
		t.Fatalf("details = %+v", commented.Task)
	}
	expectError(t, lead.do(http.MethodPatch, taskPath(orgID, p.ID, "/", tk.ID, "/comments/", comment.ID), map[string]any{"body": "x"}),
		http.StatusForbidden, "forbidden")
	expectError(t, dev.do(http.MethodPost, taskPath(orgID, p.ID, "/", tk.ID, "/comments"), map[string]any{"body": strings.Repeat("ş", 4001)}),
		http.StatusUnprocessableEntity, "validation_failed")
	lead.must(http.StatusOK, http.MethodDelete, taskPath(orgID, p.ID, "/", tk.ID, "/comments/", comment.ID), nil)

	// Leaving the project unassigns the person.
	lead.must(http.StatusOK, http.MethodDelete, base+"/members/"+devID, nil)
	if got := lead.task(orgID, p.ID, tk.ID); len(got.Assignees) != 0 {
		t.Fatalf("assignees after removal = %+v", got.Assignees)
	}
	expectError(t, dev.do(http.MethodGet, taskPath(orgID, p.ID, "/", tk.ID), nil), http.StatusNotFound, "not_found")
}

func TestSprintsAndWorkflow(t *testing.T) {
	ts := newServer(t)
	owner, orgID := ts.setupInstance()
	dev, devID := ts.join(owner, orgID, "dev@example.com", "developer")
	p := owner.createProject(orgID, map[string]any{"key": "APP", "name": "Uygulama", "memberIds": []string{devID}})
	base := "/api/v1/orgs/" + orgID + "/projects/" + p.ID
	done := statusNamed(p, "Tamamlandı")

	var created struct {
		Sprint sprint `json:"sprint"`
	}
	expectError(t, dev.do(http.MethodPost, base+"/sprints", map[string]any{"name": "Sprint 1"}), http.StatusForbidden, "forbidden")
	owner.must(http.StatusCreated, http.MethodPost, base+"/sprints", map[string]any{"name": "Sprint 1", "goal": "Ödeme", "startsOn": "2026-11-02", "endsOn": "2026-11-13"}).decode(t, &created)
	s1 := created.Sprint
	owner.must(http.StatusCreated, http.MethodPost, base+"/sprints", map[string]any{"name": "Sprint 2"}).decode(t, &created)
	s2 := created.Sprint

	open := dev.createTask(orgID, p.ID, map[string]any{"title": "Açık kalan", "sprintId": s1.ID})
	finished := dev.createTask(orgID, p.ID, map[string]any{"title": "Biten", "sprintId": s1.ID, "statusId": done.ID})
	if finished.CompletedAt == nil {
		t.Fatal("a task created in a done status is completed")
	}
	owner.must(http.StatusOK, http.MethodPost, base+"/sprints/"+s1.ID+"/start", nil)
	expectError(t, owner.do(http.MethodPost, base+"/sprints/"+s2.ID+"/start", nil), http.StatusConflict, "sprint_active")

	// Completing a sprint sends unfinished tasks back to the backlog.
	owner.must(http.StatusOK, http.MethodPost, base+"/sprints/"+s1.ID+"/complete", nil).decode(t, &created)
	if created.Sprint.State != "completed" || created.Sprint.TaskCount != 1 || created.Sprint.DoneCount != 1 {
		t.Fatalf("completed sprint = %+v", created.Sprint)
	}
	if got := dev.task(orgID, p.ID, open.ID); got.SprintID != nil || got.Activity[0].Kind != "sprint_changed" {
		t.Fatalf("unfinished task after completion = %+v", got)
	}
	if got := dev.task(orgID, p.ID, finished.ID); got.SprintID == nil || *got.SprintID != s1.ID {
		t.Fatalf("finished task lost its sprint: %+v", got)
	}
	expectError(t, dev.do(http.MethodPatch, taskPath(orgID, p.ID, "/", open.ID), map[string]any{"sprintId": s1.ID}),
		http.StatusUnprocessableEntity, "validation_failed")
	expectError(t, owner.do(http.MethodPatch, base+"/sprints/"+s1.ID, map[string]any{"name": "x"}), http.StatusConflict, "sprint_completed")
	owner.must(http.StatusOK, http.MethodPost, base+"/sprints/"+s2.ID+"/start", nil)

	// Workflow: add, reorder and delete statuses; tasks move to the status chosen.
	var st struct {
		Status taskStatus `json:"status"`
	}
	owner.must(http.StatusCreated, http.MethodPost, base+"/statuses", map[string]any{"name": "Test", "category": "review", "color": "pink"}).decode(t, &st)
	expectError(t, owner.do(http.MethodPost, base+"/statuses", map[string]any{"name": "test"}), http.StatusUnprocessableEntity, "validation_failed")
	moved := dev.patchTask(orgID, p.ID, open.ID, map[string]any{"statusId": st.Status.ID})
	second := dev.createTask(orgID, p.ID, map[string]any{"title": "İkinci", "statusId": st.Status.ID})
	expectError(t, owner.do(http.MethodDelete, base+"/statuses/"+st.Status.ID, nil), http.StatusUnprocessableEntity, "validation_failed")
	owner.must(http.StatusNoContent, http.MethodDelete, base+"/statuses/"+st.Status.ID+"?moveTo="+done.ID, nil)
	first, next := dev.task(orgID, p.ID, moved.ID), dev.task(orgID, p.ID, second.ID)
	if first.Status.ID != done.ID || first.CompletedAt == nil || first.Activity[0].Kind != "status_changed" {
		t.Fatalf("task of the deleted status = %+v", first)
	}
	// Moved tasks keep their order behind the target's existing tasks.
	if next.Status.ID != done.ID || next.Activity[0].Kind != "status_changed" || !(finished.Rank < first.Rank && first.Rank < next.Rank) {
		t.Fatalf("moved tasks = %+v, %+v (finished rank %q)", first, next, finished.Rank)
	}
	cur := owner.project(orgID, p.ID)
	order := []string{}
	for i := len(cur.Statuses) - 1; i >= 0; i-- {
		order = append(order, cur.Statuses[i].ID)
	}
	owner.must(http.StatusOK, http.MethodPut, base+"/statuses/order", map[string]any{"statusIds": order})
	if got := owner.project(orgID, p.ID); got.Statuses[0].ID != order[0] {
		t.Fatalf("order = %+v", got.Statuses)
	}
	expectError(t, owner.do(http.MethodPut, base+"/statuses/order", map[string]any{"statusIds": order[1:]}), http.StatusUnprocessableEntity, "validation_failed")
	// Reopening a done status's category reopens its tasks.
	owner.must(http.StatusOK, http.MethodPatch, base+"/statuses/"+done.ID, map[string]any{"category": "review"})
	if got := dev.task(orgID, p.ID, moved.ID); got.CompletedAt != nil {
		t.Fatalf("task still completed: %+v", got)
	}
	for _, s := range cur.Statuses[1:] {
		owner.must(http.StatusNoContent, http.MethodDelete, base+"/statuses/"+s.ID+"?moveTo="+cur.Statuses[0].ID, nil)
	}
	expectError(t, owner.do(http.MethodDelete, base+"/statuses/"+cur.Statuses[0].ID, nil), http.StatusConflict, "last_status")
}

func TestTaskLinksToRooms(t *testing.T) {
	ts := newServer(t)
	owner, orgID := ts.setupInstance()
	lead, _ := ts.join(owner, orgID, "lead@example.com", "team-leader")
	emp, _ := ts.join(owner, orgID, "emp@example.com", "employee")
	dev, devID := ts.join(owner, orgID, "dev@example.com", "developer")
	rm := lead.createRoom(orgID, map[string]any{"name": "Mühendislik", "access": "open"})
	emp.entered(orgID, rm.ID, "")
	secret := lead.createProject(orgID, map[string]any{"key": "SEC", "name": "Gizli", "visibility": "private", "memberIds": []string{devID}})
	open := lead.createProject(orgID, map[string]any{"key": "ENG", "name": "Açık"})
	hidden := lead.createTask(orgID, secret.ID, map[string]any{"title": "Gizli iş"})
	shown := lead.createTask(orgID, open.ID, map[string]any{"title": "Rate limiting modülü"})
	roomTasks := "/api/v1/orgs/" + orgID + "/channels/" + rm.ID + "/tasks"

	// Linking needs the caller to be in the room.
	expectError(t, dev.do(http.MethodPost, taskPath(orgID, secret.ID, "/", hidden.ID, "/links"), map[string]any{"channelId": rm.ID}),
		http.StatusUnprocessableEntity, "validation_failed")
	empEvents := emp.events()
	for _, tk := range []struct{ project, task string }{{secret.ID, hidden.ID}, {open.ID, shown.ID}} {
		var out struct {
			Task task `json:"task"`
		}
		lead.must(http.StatusOK, http.MethodPost, taskPath(orgID, tk.project, "/", tk.task, "/links"), map[string]any{"channelId": rm.ID}).decode(t, &out)
		if len(out.Task.Links) != 1 || out.Task.Links[0].Name != "Mühendislik" || out.Task.Links[0].Kind != "room" {
			t.Fatalf("links = %+v", out.Task.Links)
		}
	}
	empEvents.waitFor("channel.tasks", roomEvent(rm.ID))

	// People in the room see the linked tasks of projects they may see, nothing else.
	var listed struct {
		Tasks []task `json:"tasks"`
	}
	emp.must(http.StatusOK, http.MethodGet, roomTasks, nil).decode(t, &listed)
	if len(listed.Tasks) != 1 || listed.Tasks[0].ID != shown.ID {
		t.Fatalf("room tasks for a room member = %+v", listed.Tasks)
	}
	// Room links are room content: people not admitted get 404.
	expectError(t, dev.do(http.MethodGet, roomTasks, nil), http.StatusNotFound, "not_found")
	// Someone who may see the task but not the room does not learn the room's name.
	lead.must(http.StatusOK, http.MethodPut, "/api/v1/orgs/"+orgID+"/rooms/"+rm.ID+"/security", map[string]any{"access": "restricted"})
	if got := dev.task(orgID, secret.ID, hidden.ID); len(got.Links) != 0 || strings.Contains(string(got.Activity[0].Data), "Mühendislik") {
		t.Fatalf("a hidden room was named: %+v", got)
	}
	lead.must(http.StatusOK, http.MethodDelete, taskPath(orgID, open.ID, "/", shown.ID, "/links/", rm.ID), nil)
	lead.must(http.StatusOK, http.MethodGet, roomTasks, nil).decode(t, &listed)
	if len(listed.Tasks) != 1 || listed.Tasks[0].ID != hidden.ID {
		t.Fatalf("room tasks after unlinking = %+v", listed.Tasks)
	}
}
