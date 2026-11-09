# Phase 5 Architecture — Projects, Tasks and Whiteboards

Status: **Done** — verified by tests and in two browsers with two people (section 7).

Projects with tasks on a Kanban board, a list and a calendar, sprints, editable
workflows, tasks linked to rooms, and Excalidraw whiteboards that several people edit at
once (mockups "Yeni 07" and "Yeni 08", the "Bağlantılı Görevler" panel of "Yeni 05", the
"Görevlerim" card of "Yeni 03"). The Wiki and Documents tabs of "Yeni 07" belong to
Phase 7 and Git activity to Phase 6; they are not shown. Collaboration design: ADR-0015.

## 1. Data model (migrations 00012 and 00013)

```
projects             id, org_id, key (A–Z, 2–6, unique per workspace), name, description, color,
                     visibility (public|private), starts_on, ends_on, created_by, created_at,
                     archived_at, task_seq
project_members      (project_id, user_id), org_id, role (lead|member), added_at
task_statuses        id, project_id, name (unique per project, case-insensitive), category
                     (todo|in_progress|review|done), color, position
project_labels       id, project_id, name (unique per project, case-insensitive), color
sprints              id, project_id, name, goal, starts_on, ends_on, state (planned|active|completed),
                     created_at, completed_at — at most one active sprint per project
tasks                id, org_id, project_id, number (unique per project), title, description,
                     status_id, priority (none|low|medium|high|urgent), due_on, sprint_id,
                     rank (COLLATE "C"), created_by, created_at, updated_at, completed_at
task_assignees       (task_id, user_id), project_id — references project_members
task_labels          (task_id, label_id), project_id
task_checklist_items id, task_id, text, done, position
task_comments        id (UUIDv7), task_id, author_id, body (1–4000), created_at, edited_at
task_links           (task_id, channel_id), org_id, created_by, created_at — channels and rooms
task_events          id (UUIDv7), project_id, task_id, actor_id, kind, data (jsonb), created_at
boards               id, org_id, project_id (null: workspace board), room_id, title, description,
                     created_by, created_at, updated_at
board_elements       (board_id, element_id), version, version_nonce, data (jsonb), deleted,
                     updated_by, updated_at
```

- Composite foreign keys keep everything inside one workspace and one project: a task's
  status, sprint, labels and assignees must belong to its own project
  (`(status_id, project_id)` and so on), a link's task and channel the same workspace,
  a board's project and room the board's workspace. Deleting a project, task, room or
  board cascades; a deleted sprint leaves its tasks in the backlog
  (`ON DELETE SET NULL (sprint_id)`).
- `task_assignees` references `project_members`, so only members can be assigned and
  leaving the project — or the workspace — unassigns at once.
- A project's status is derived from `archived_at`. Task numbers come from `task_seq`,
  incremented under the project row lock: unique, gapless and never reused.
- Ranks are fractional-indexing keys compared byte by byte ("a0", "a1", … "az", "b00"),
  the algorithm Excalidraw also uses: moving a card rewrites that card only, appending
  keeps keys short (100,000 appends stay under five characters).
- New projects get Yapılacak, Devam Ediyor, İncelemede, Tamamlandı — or To Do, In
  Progress, In Review, Done when the creating request is English — like the default
  channel.
- New permissions: `projects.view`, `projects.create` and `boards.create` for every
  default role except Guest, `projects.manage` for Owner and Administrator (existing roles
  backfilled). `projects.manage` is a management permission: email-domain join roles
  cannot carry it.

## 2. Access rules

| Who | Public project | Private project |
| --- | --- | --- |
| Sees the project, its tasks, sprints, activity and boards | Members; everyone with `projects.view` | Members only — everyone else gets 404, workspace owners and administrators included |
| Creates, edits, moves, comments on tasks; draws on project boards | Members of an active project | same |
| Settings, workflow, labels, members, sprints, archiving | Leads; `projects.manage` | Leads; `projects.manage` holders who are members |

- Guests have no `projects.view`: they see only projects they are added to, and then take
  part like any member. Anyone who may view a public project may join it; everyone may
  leave. A project keeps at least one lead (409 `last_lead`).
- Viewers of a public project who are not members get 403 `not_project_member` on task
  changes; archived projects answer 409 `project_archived` to every change but restoring.
- Tasks are deleted by their creator or a lead/project manager (audited). Comment authors
  edit their comments; authors and leads delete them.
- A task may be linked only to a channel the person joined or a room they are in. Links
  name only channels and rooms the viewer may see; link entries in the activity show the
  name under the same rule. A room's linked tasks are room content: only admitted people
  get them, and only tasks of projects they may see.
- Whiteboards:

  | | Project board | Workspace board |
  | --- | --- | --- |
  | Sees | Whoever may see the project | `boards.create` holders (not guests) |
  | Draws, renames, links a room | Project members of an active project | `boards.create` holders |
  | Deletes | Creator (still a member), leads, `projects.manage` | Creator, `projects.manage` |

  A board's voice room is shown only to people who may see that room, and can be linked
  only by someone admitted to it.

## 3. API (all under `/api/v1/orgs/{orgID}`)

| Method and path | Purpose |
| --- | --- |
| `GET /projects[?archived=true]` · `POST /projects` | Projects the caller may see (active, or archived); create (`projects.create`; `key`, `name`, `description`, `color`, `visibility`, `startsOn`, `endsOn`, `memberIds`) — the caller leads it |
| `GET /projects/{id}` · `PATCH /projects/{id}` | Project with members, statuses, labels and sprints; change settings (absent fields stay, null clears a date) |
| `POST /projects/{id}/archive` · `/unarchive` · `/join` | Archive or restore (managers); join a public project |
| `POST /projects/{id}/members` · `PATCH`/`DELETE …/members/{userID}` | Add people with a role; change a role; remove someone, or leave |
| `POST …/statuses` · `PATCH`/`DELETE …/statuses/{id}[?moveTo=]` · `PUT …/statuses/order` | Workflow: add (at most 12), rename, recolor, recategorize, delete moving its tasks, reorder |
| `POST …/labels` · `PATCH`/`DELETE …/labels/{id}` | Labels (at most 50) |
| `POST …/sprints` · `PATCH`/`DELETE …/sprints/{id}` · `POST …/sprints/{id}/start` · `/complete` | Sprints; completing moves unfinished tasks to the backlog |
| `GET`/`POST /projects/{id}/tasks` | Every task of the project (each column in rank order, at most 5,000); create (`title`, `description`, `statusId`, `priority`, `dueOn`, `sprintId`, `assigneeIds`, `labelIds`) |
| `GET`/`PATCH`/`DELETE …/tasks/{taskID}` | Task with checklist, comments, links and activity; change (a `statusId` without `rank` appends to that column; null clears the due date or sprint); delete |
| `POST …/tasks/{id}/checklist` · `PATCH`/`DELETE …/checklist/{itemID}` | Checklist (at most 50 items) |
| `POST …/tasks/{id}/comments` · `PATCH`/`DELETE …/comments/{commentID}` | Comments |
| `POST …/tasks/{id}/links` · `DELETE …/links/{channelID}` | Link to a channel or room (at most 20) |
| `GET /projects/{id}/activity` | The project's latest 50 activity entries |
| `GET /tasks` · `GET /tasks?q=` | The caller's assigned tasks (open, or completed in the last 7 days); search by title or key ("ENG-42") in projects the caller may see |
| `GET /channels/{channelID}/tasks` | Tasks linked to a channel, or to a room the caller is in |
| `GET /boards[?projectId=]` · `POST /boards` | Boards the caller may see; create (`title`, `description`, `projectId`, `roomId`) |
| `GET /boards/{id}[?deleted=true]` · `PATCH`/`DELETE /boards/{id}` | Board with its scene in z-order (tombstones on request); rename, describe, link a room; delete |
| `PATCH /boards/{id}/elements` | `{clientId, elements}`: changed Excalidraw elements; answers `{accepted}` |
| `POST /boards/{id}/presence` · `DELETE /boards/{id}/presence?clientId=` | Heartbeat (returns the viewers); leave |
| `POST /boards/{id}/cursor` | `{clientId, x, y, tool, button, selectedElementIds}`, relayed only |

A project carries the caller's `role` (lead, member or empty), `canEdit` and
`canManage`; a board `canEdit` and `canManage`. A task's `key` is `<project key>-<number>`;
it carries its status (name, category, color), assignees, labels, checklist progress and
comment count. Activity kinds: `created`, `status_changed`, `assigned`, `unassigned`,
`priority_changed`, `due_changed`, `sprint_changed`, `title_changed`,
`description_changed`, `labels_changed`, `linked`, `unlinked`.

Limits: titles 200 characters, descriptions 10,000, comments 4,000 (message rules: plain
text with line breaks, rendered as text); 10 assignees and 10 labels per task; 1,000
members per project. Task changes are limited per person (burst 60, then 10 a second),
comments like messages (burst 20, then 5 a second).

Audit: `project.created`, `project.updated` (name, key, visibility from/to),
`project.members_changed` (added, removed, changed, role), `project.archived`,
`project.restored`, `task.deleted` (project, key, title), `board.created`,
`board.deleted`.

## 4. Live events

| Event | Goes to | Data |
| --- | --- | --- |
| `task.updated` | Everyone who may see the project | `orgId, projectId, task` (as list views show it) |
| `task.deleted` | same | `orgId, projectId, taskId` |
| `project.updated` | Everyone who may see the project, and people who just lost access | `orgId, projectId` — refetch |
| `channel.tasks` | The channel's members, a room's admitted people | `orgId, channelId` — refetch; no task data |
| `board.elements` | Current viewers of the board who may see it | `orgId, boardId, clientId, user, elements` |
| `board.cursor` | same | `orgId, boardId, clientId, user, pointer {x, y, tool}, button, selectedElementIds` |
| `board.viewers` | same | `orgId, boardId, viewers [{user, since}]` |
| `board.updated` · `board.deleted` | same | `orgId, boardId` |

Recipients are computed when the event is sent (ADR-0008): project events from current
membership and roles, board events from the in-memory viewer list filtered through the
same access check, so removing someone from a project stops both at once.

## 5. Whiteboard collaboration (ADR-0015)

- The scene is stored per element with Excalidraw's `version` and `versionNonce`. A write
  keeps the copy with the higher version, and on equal versions the lower nonce — one
  `INSERT … ON CONFLICT … DO UPDATE … WHERE` statement under the board row lock, which also
  enforces at most 10,000 live shapes. Only accepted elements are broadcast.
- Batches: at most 500 elements, 256 KiB each, 4 MiB per request; element IDs
  `[A-Za-z0-9_-]{1,64}`; types limited to rectangle, diamond, ellipse, arrow, line,
  freedraw, text and frame — images (no board-scoped file storage yet) and embeds (they
  load other sites) are refused. Scene writes are limited per person (burst 40, then 20 a
  second); cursors beyond 25 a second are dropped.
- Viewers: each board window sends a heartbeat every 10 seconds with a random window ID;
  entries are keyed by person and window, expire after 30 seconds (a sweep every 5 seconds
  tells the others) and are removed on leaving. Nothing about viewers or cursors is
  stored.
- Deleted elements stay as tombstones, so stale copies cannot bring them back;
  `?deleted=true` returns them for clients merging after a reconnect.

## 6. Client

- Navigation: "Görevler", "Projeler" and "Beyaz Tahta" after "Toplantılar", for everyone
  (guests take part in projects they are added to). The new pages are lazy routes, and
  Excalidraw loads only on a board page (`React.lazy`), so the main bundle carries only
  the shared hooks, the room panel and the translations.
- Projects page: active and archived tabs, cards with key, visibility, progress, people
  and the caller's role; "Proje oluştur" suggests a key from the name.
- Project page (`/p/:id`, with `?tab=`, `?view=` and `?task=` in the URL): header with
  name, description, people, "Paylaş" (copy link), join, leave, archive; tabs Görevler,
  Genel Bakış, Sprintler and — for managers — Ayarlar.
  - Görevler: filters (all, assigned to me, unassigned; search by title or key; labels;
    assignees; sprint or backlog; priority), the Kanban board, a list and a month
    calendar by due date, "Görev ekle", and the "Proje Hakkında" panel (details and
    project activity). Cards show labels, key, priority, due date (red when overdue),
    checklist progress, comment count, assignees and a done mark.
  - Moving cards: drag and drop with the mouse, or with the keyboard on each card's handle
    (Space to pick up, arrows, Space to drop, Escape to cancel) with screen-reader
    announcements (@dnd-kit), or the card menu's "Şuraya taşı". The new rank is computed
    between the neighbours (ties left by simultaneous moves skipped) and applied
    optimistically.
  - Task dialog: title, description, status, assignees (project members), labels,
    priority, due date, sprint, checklist, comments, links to channels and rooms,
    activity, copy link, delete.
  - Genel Bakış: counts, tasks by status and priority, the active sprint's progress,
    workload per person, overdue tasks and tasks due within a week.
  - Sprintler: create, edit, start, complete (with confirmation), delete; each sprint's
    tasks and the backlog with a sprint selector per task; "Panoda göster" filters the
    board to the active sprint; completed sprints listed.
  - Ayarlar: general settings (key change preview, warning when going private),
    workflow (rename, category, color, reorder, delete moving tasks), labels, members
    (roles, remove, add), archive.
- Görevler page (`/tasks`): the caller's tasks grouped into overdue, today, this week,
  later, no date and recently completed. Home: "Görevlerim" with the next five tasks,
  ticked off in place. Room page: "Bağlantılı Görevler" with the room's linked tasks,
  ticked off in place, and a task search to link more. The command palette finds
  projects and tasks.
- Boards page (`/boards`) and board page (`/b/:id`): header with title, description,
  viewers, copy link, edit (title, description, voice room) and delete; the canvas; a
  side panel with participants ("Düzenliyor" for a few seconds after someone's change,
  otherwise "Beyaz tahtada"), the voice room ("Sese katıl" for people in the room) and
  linked items. Viewers without edit rights get Excalidraw's view mode.
- Canvas sync: changed elements are sent every 100 ms (one request at a time, retried
  with back-off, dropped with a message when the board is full or no longer editable);
  remote elements are merged with the same rule as the server, keeping what is being
  drawn or typed locally; cursors are sent at most every 80 ms and shown with the
  person's name and a stable colour; a reconnect merges the stored scene, tombstones
  included. Pasted or dropped images are taken off the canvas with a notice.
- Self-hosting: Excalidraw's fonts are served from `/excalidraw/fonts/` — the Vite dev
  server answers from the package and the build copies them into `dist`; the menu keeps
  only local actions (export image, search, help, clear canvas, background); the library
  browser is hidden, and the collaboration button and Excalidraw+ links are not
  rendered.
- `task.updated` patches the project's task list and linked-task panels in place;
  `project.updated` refetches the project; reconnects refetch every project and task
  query and merge the open board.

## 7. Verification

Excalidraw ships Liberation Sans 1.05 for its legacy "Helvetica" family. That version is
GPL-2.0 with a font exception, so FUDISLTE does not serve it (`apps/web/vite.config.ts`);
drawings in that family use the viewer's own fonts. The other 233 font files are OFL-1.1 or
MIT, and their notices are added to `/licenses.txt` from the fonts' own name tables
(`scripts/licenses/font-notices.mjs`).

Excalidraw lists a public CDN (esm.sh) as every font's second source. The production CSP
blocks it, but browsers report each blocked source as soon as a font is registered — about
230 console errors per board. The app removes those CDN sources before fonts reach the
browser (`features/boards/excalidraw-assets.ts`), so a board never refers to the CDN, with
or without a CSP. Checked in the Docker build: no CSP report on opening a board, and text
in Excalifont loads it from `/excalidraw/fonts/`.

Run 2026-11-03, Windows 11, API and PostgreSQL 17 in WSL2.

| Check | Result |
| --- | --- |
| `pnpm check:api` | gofmt and vet clean; 111 Go tests pass (15 new). Unit: rank cases of the reference implementation, 2,000 random inserts staying ordered and unique, 100,000 appends under five characters, rank validation; merge rule (higher version, lower nonce, identical copy changes nothing); batch parsing (duplicates keep the winner; images, embeds, bad IDs, version 0, oversized elements and more than 500 refused); viewer registry (windows per person, someone else's window ID cannot replace an entry, expiry). Integration: validation; **a private project answers 404 to non-members, the workspace owner included**, for the project, its tasks, a task, its activity, changes and joining, and is missing from their lists; public projects visible with `projects.view`, task changes need membership until joining; `projects.manage` manages public projects; **guests get 404 until added, then create tasks**; making a project private hides it at once; last lead protected; leaving; archived projects read-only; **cross-workspace access 404 and people of another workspace refused**; keys unique per workspace; audit entries; English default workflow; **12 concurrent creations numbered 1–12**; moving to another status appends to that column with `status_changed` activity, done completes, reopening clears it, client ranks order the column; `task.updated` reaches members and not guests; deletion by creator or manager only, audited, numbers not reused; **only project members can be assigned**, with activity; my tasks; search by key, hiding private projects; labels; checklist; comment rules; **removing someone from the project unassigns them**; **sprints: one active at a time, completing returns unfinished tasks to the backlog**, finished ones keep the sprint, completed sprints closed; statuses: delete needs and applies `moveTo`, reorder, category change reopens tasks, last status protected; links only to rooms the caller is in, room members see linked tasks of visible projects only, people outside the room 404, hidden rooms never named; boards: workspace boards 404 for guests, private project boards 404 for the owner, viewers read-only; **merge: higher version wins, lower nonce breaks ties, stale and duplicate copies change nothing, tombstones resist stale copies**; invalid batches 422; linked rooms hidden from people off their list; delete rules; **board events reach only current viewers who may see the board** (a member without the board open gets nothing; someone removed from the project stops at once and can no longer register); **cursor events relayed and never stored** (board row and element count unchanged); leaving updates the viewer list |
| `pnpm typecheck` | Pass (all packages) |
| `pnpm test` | 62 Vitest tests pass: web 42 (14 new: ranks matching the Go cases, placement between neighbours and past equal ranks, 500 random inserts; filters; columns and list order; overdue; month grid and due dates; merge rules mirroring the server and converging in any order of arrival; locally edited elements kept; z-order; changes to send skip images; batching; stable colours), api-client 7, desktop 9, platform 4 |
| Web build | Pass. Main chunk 1,403.96 kB (393.69 kB gzip), of which Phase 5 code is 13.6 kB and its Turkish and English strings about 32 kB. Lazy: project page 121.13 kB (33.39 kB gzip, @dnd-kit included), board page 10.52 kB, projects list 3.97 kB, boards list 3.44 kB, my tasks 2.23 kB; Excalidraw canvas 1,057.35 kB (332.29 kB gzip) plus 142.15 kB CSS (22.41 kB gzip); Excalidraw's font subsetting 1,821.00 kB (744.20 kB gzip), loaded only when a board is exported. `index.html` preloads only the runtime chunks. 234 font files (14 MB) copied to `dist/excalidraw/fonts`, fetched on demand. With the new pages loaded eagerly the main chunk was 1,562.91 kB |
| Browser, two people (lead, 2026-11-03; dev API restarted, migrations 12 and 13 applied) | Alex (Owner, in-app browser) creates the private project "Mimari" with Dana as member: the key MIM is suggested, the board shows Yapılacak, Devam Ediyor, İncelemede and Tamamlandı. The new task "Gateway" offers only Alex and Dana as assignees; MIM-1 is assigned to Dana with priority Yüksek. Dana (second browser, headless Edge) finds MIM-1 on her *Görevler* page and in the home *Görevlerim* card, focuses the card's grip ("Gateway görevini taşı") and moves it with Space, Right arrow, Space; the live region announces "Gateway bırakıldı: Devam Ediyor, 1. sıra." Alex's open board and task dialog switch to Devam Ediyor without reloading; the Aktivite tab lists creation, assignment and Dana's status change. Deniz, an Employee outside the project, gets 404 for it and an empty project list; Dana, a member but not a lead, sees no Ayarlar tab. Alex creates the board "Mimari taslak" linked to the project; the Excalidraw chunk loads only then, and every request goes to the FUDISLTE origin (fonts included, Turkish locale chunk). With Dana on the board both see *Katılımcılar (2)*; Dana's ellipse and Alex's rectangle each appear in the other's window within moments, with the other person's named cursor, and the editor shows *Düzenliyor*; reopening the board brings back the saved shapes |
| Licenses | 223 npm packages added (Excalidraw 0.18.1, @dnd-kit and their dependencies): MIT 167, ISC 35, Apache-2.0 10, BSD-3-Clause 6, CC0-1.0, Unlicense, MIT AND Zlib, MPL-2.0 OR Apache-2.0 (one each); no copyleft |

## Not verified

- By hand: drag and drop with the mouse, the list and calendar views, sprints, project
  settings, the room's linked tasks, the command palette results, English and dark mode,
  removing someone from a project while their board is open (covered by an integration
  test), dropping an image on a board, and the desktop shell.
- Excalidraw under the production Content Security Policy (Caddy) — notably its
  font-subsetting worker on export.
- Several API replicas (viewer lists and rate limits are per process), very large boards,
  many simultaneous editors, and slow clients flooded with cursor events (the stream
  buffer holds 64 events; an overflow reconnects the client, which then resyncs).
