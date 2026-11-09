-- +goose Up

-- Projects, workflows, tasks and sprints (docs/architecture/phase-5.md). Names, texts and
-- keys are validated and normalized in Go; the checks here are a last line of defence.
-- Every row is tied to one workspace through composite foreign keys.
CREATE TABLE projects (
    id          uuid PRIMARY KEY,
    org_id      uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    -- Task keys are "<key>-<number>", e.g. ENG-42.
    key         text NOT NULL,
    name        text NOT NULL,
    description text NOT NULL DEFAULT '',
    color       text NOT NULL DEFAULT 'blue',
    visibility  text NOT NULL,
    starts_on   date,
    ends_on     date,
    created_by  uuid REFERENCES users (id) ON DELETE SET NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    -- An archived project is read-only; its status is derived from this column.
    archived_at timestamptz,
    -- The last task number handed out; incrementing it locks the project row, so
    -- numbers are unique and gapless per project.
    task_seq    integer NOT NULL DEFAULT 0,
    CONSTRAINT projects_id_org_key UNIQUE (id, org_id),
    CONSTRAINT projects_org_key_key UNIQUE (org_id, key),
    CONSTRAINT projects_key_format CHECK (key ~ '^[A-Z]{2,6}$'),
    CONSTRAINT projects_name_length CHECK (char_length(name) BETWEEN 1 AND 80),
    CONSTRAINT projects_description_length CHECK (char_length(description) <= 2000),
    CONSTRAINT projects_color_check CHECK (color ~ '^[a-z]{1,16}$'),
    CONSTRAINT projects_visibility_check CHECK (visibility IN ('public', 'private')),
    CONSTRAINT projects_dates_check CHECK (ends_on IS NULL OR starts_on IS NULL OR ends_on >= starts_on),
    CONSTRAINT projects_task_seq_check CHECK (task_seq >= 0)
);

-- Leads manage the project; members create, edit and move tasks. Private projects are
-- visible to their members only. Leaving the workspace removes the membership.
CREATE TABLE project_members (
    project_id uuid NOT NULL,
    org_id     uuid NOT NULL,
    user_id    uuid NOT NULL,
    role       text NOT NULL DEFAULT 'member',
    added_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, user_id),
    CONSTRAINT project_members_project_fkey FOREIGN KEY (project_id, org_id)
        REFERENCES projects (id, org_id) ON DELETE CASCADE,
    CONSTRAINT project_members_membership_fkey FOREIGN KEY (org_id, user_id)
        REFERENCES memberships (org_id, user_id) ON DELETE CASCADE,
    CONSTRAINT project_members_role_check CHECK (role IN ('lead', 'member'))
);
CREATE INDEX project_members_user_idx ON project_members (org_id, user_id);

-- The workflow: a project's board columns, left to right by position. The category
-- says what a status means (done statuses complete their tasks).
CREATE TABLE task_statuses (
    id         uuid PRIMARY KEY,
    project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    name       text NOT NULL,
    category   text NOT NULL,
    color      text NOT NULL,
    position   integer NOT NULL,
    CONSTRAINT task_statuses_id_project_key UNIQUE (id, project_id),
    CONSTRAINT task_statuses_category_check CHECK (category IN ('todo', 'in_progress', 'review', 'done')),
    CONSTRAINT task_statuses_name_length CHECK (char_length(name) BETWEEN 1 AND 40),
    CONSTRAINT task_statuses_color_check CHECK (color ~ '^[a-z]{1,16}$')
);
CREATE UNIQUE INDEX task_statuses_name_key ON task_statuses (project_id, lower(name));

CREATE TABLE project_labels (
    id         uuid PRIMARY KEY,
    project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    name       text NOT NULL,
    color      text NOT NULL,
    CONSTRAINT project_labels_id_project_key UNIQUE (id, project_id),
    CONSTRAINT project_labels_name_length CHECK (char_length(name) BETWEEN 1 AND 30),
    CONSTRAINT project_labels_color_check CHECK (color ~ '^[a-z]{1,16}$')
);
CREATE UNIQUE INDEX project_labels_name_key ON project_labels (project_id, lower(name));

-- At most one active sprint per project. Completing a sprint moves its unfinished tasks
-- back to the backlog; finished ones keep it for history.
CREATE TABLE sprints (
    id           uuid PRIMARY KEY,
    project_id   uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    name         text NOT NULL,
    goal         text NOT NULL DEFAULT '',
    starts_on    date,
    ends_on      date,
    state        text NOT NULL DEFAULT 'planned',
    created_at   timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    CONSTRAINT sprints_id_project_key UNIQUE (id, project_id),
    CONSTRAINT sprints_state_check CHECK (state IN ('planned', 'active', 'completed')),
    CONSTRAINT sprints_completed_check CHECK ((state = 'completed') = (completed_at IS NOT NULL)),
    CONSTRAINT sprints_name_length CHECK (char_length(name) BETWEEN 1 AND 80),
    CONSTRAINT sprints_goal_length CHECK (char_length(goal) <= 500),
    CONSTRAINT sprints_dates_check CHECK (ends_on IS NULL OR starts_on IS NULL OR ends_on >= starts_on)
);
CREATE UNIQUE INDEX sprints_one_active_key ON sprints (project_id) WHERE state = 'active';

-- Tasks. The composite keys keep a task's status, sprint, labels and assignees inside
-- its own project. rank orders a status column: base-62 fractional keys compared byte
-- by byte (hence the C collation), so a move rewrites one row.
CREATE TABLE tasks (
    id           uuid PRIMARY KEY,
    org_id       uuid NOT NULL,
    project_id   uuid NOT NULL,
    number       integer NOT NULL,
    title        text NOT NULL,
    description  text NOT NULL DEFAULT '',
    status_id    uuid NOT NULL,
    priority     text NOT NULL DEFAULT 'none',
    due_on       date,
    sprint_id    uuid,
    rank         text COLLATE "C" NOT NULL,
    created_by   uuid REFERENCES users (id) ON DELETE SET NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    CONSTRAINT tasks_id_project_key UNIQUE (id, project_id),
    CONSTRAINT tasks_id_org_key UNIQUE (id, org_id),
    CONSTRAINT tasks_number_key UNIQUE (project_id, number),
    CONSTRAINT tasks_project_fkey FOREIGN KEY (project_id, org_id)
        REFERENCES projects (id, org_id) ON DELETE CASCADE,
    CONSTRAINT tasks_status_fkey FOREIGN KEY (status_id, project_id)
        REFERENCES task_statuses (id, project_id),
    CONSTRAINT tasks_sprint_fkey FOREIGN KEY (sprint_id, project_id)
        REFERENCES sprints (id, project_id) ON DELETE SET NULL (sprint_id),
    CONSTRAINT tasks_number_positive CHECK (number > 0),
    CONSTRAINT tasks_title_length CHECK (char_length(title) BETWEEN 1 AND 200),
    CONSTRAINT tasks_description_length CHECK (char_length(description) <= 10000),
    CONSTRAINT tasks_priority_check CHECK (priority IN ('none', 'low', 'medium', 'high', 'urgent')),
    CONSTRAINT tasks_rank_format CHECK (rank ~ '^[0-9A-Za-z]{1,128}$')
);
CREATE INDEX tasks_column_idx ON tasks (status_id, rank);
CREATE INDEX tasks_sprint_idx ON tasks (sprint_id) WHERE sprint_id IS NOT NULL;
CREATE INDEX tasks_project_idx ON tasks (project_id, number);

-- Only project members can be assigned: the foreign key to project_members also
-- unassigns people who leave the project or the workspace.
CREATE TABLE task_assignees (
    task_id     uuid NOT NULL,
    project_id  uuid NOT NULL,
    user_id     uuid NOT NULL,
    assigned_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (task_id, user_id),
    CONSTRAINT task_assignees_task_fkey FOREIGN KEY (task_id, project_id)
        REFERENCES tasks (id, project_id) ON DELETE CASCADE,
    CONSTRAINT task_assignees_member_fkey FOREIGN KEY (project_id, user_id)
        REFERENCES project_members (project_id, user_id) ON DELETE CASCADE
);
CREATE INDEX task_assignees_user_idx ON task_assignees (user_id, task_id);

CREATE TABLE task_labels (
    task_id    uuid NOT NULL,
    project_id uuid NOT NULL,
    label_id   uuid NOT NULL,
    PRIMARY KEY (task_id, label_id),
    CONSTRAINT task_labels_task_fkey FOREIGN KEY (task_id, project_id)
        REFERENCES tasks (id, project_id) ON DELETE CASCADE,
    CONSTRAINT task_labels_label_fkey FOREIGN KEY (label_id, project_id)
        REFERENCES project_labels (id, project_id) ON DELETE CASCADE
);
CREATE INDEX task_labels_label_idx ON task_labels (label_id);

CREATE TABLE task_checklist_items (
    id       uuid PRIMARY KEY,
    task_id  uuid NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
    text     text NOT NULL,
    done     boolean NOT NULL DEFAULT false,
    position integer NOT NULL,
    CONSTRAINT task_checklist_text_length CHECK (char_length(text) BETWEEN 1 AND 200)
);
CREATE INDEX task_checklist_task_idx ON task_checklist_items (task_id, position);

-- Comment IDs are UUIDv7, so ID order is time order. Bodies follow the message rules.
CREATE TABLE task_comments (
    id         uuid PRIMARY KEY,
    task_id    uuid NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
    author_id  uuid REFERENCES users (id) ON DELETE SET NULL,
    body       text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    edited_at  timestamptz,
    CONSTRAINT task_comments_body_length CHECK (char_length(body) BETWEEN 1 AND 4000)
);
CREATE INDEX task_comments_task_idx ON task_comments (task_id, id);

-- Tasks linked to a channel or a secure room ("Bağlantılı Görevler"). Rooms are
-- channels of kind 'room'; the API refuses direct conversations. Deleting the room or
-- the task removes the link.
CREATE TABLE task_links (
    task_id    uuid NOT NULL,
    org_id     uuid NOT NULL,
    channel_id uuid NOT NULL,
    created_by uuid REFERENCES users (id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (task_id, channel_id),
    CONSTRAINT task_links_task_fkey FOREIGN KEY (task_id, org_id)
        REFERENCES tasks (id, org_id) ON DELETE CASCADE,
    CONSTRAINT task_links_channel_fkey FOREIGN KEY (channel_id, org_id)
        REFERENCES channels (id, org_id) ON DELETE CASCADE
);
CREATE INDEX task_links_channel_idx ON task_links (channel_id, created_at DESC);

-- A task's activity: created, status changed, assigned and so on. IDs are UUIDv7.
CREATE TABLE task_events (
    id         uuid PRIMARY KEY,
    project_id uuid NOT NULL,
    task_id    uuid NOT NULL,
    actor_id   uuid REFERENCES users (id) ON DELETE SET NULL,
    kind       text NOT NULL,
    data       jsonb NOT NULL DEFAULT '{}',
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT task_events_task_fkey FOREIGN KEY (task_id, project_id)
        REFERENCES tasks (id, project_id) ON DELETE CASCADE,
    CONSTRAINT task_events_kind_check CHECK (kind IN (
        'created', 'status_changed', 'assigned', 'unassigned', 'priority_changed', 'due_changed',
        'sprint_changed', 'title_changed', 'description_changed', 'labels_changed', 'linked', 'unlinked'))
);
CREATE INDEX task_events_task_idx ON task_events (task_id, id);
CREATE INDEX task_events_project_idx ON task_events (project_id, id DESC);

-- Default roles: everyone but guests sees public projects and creates projects;
-- owners and administrators manage every project they can see. Guests take part only
-- in projects they are added to.
UPDATE roles SET permissions = permissions || ARRAY['projects.view', 'projects.create']
WHERE key <> 'guest';
UPDATE roles SET permissions = permissions || ARRAY['projects.manage']
WHERE key IN ('owner', 'administrator');

-- +goose Down
UPDATE roles SET permissions = ARRAY(
    SELECT p FROM unnest(permissions) AS p
    WHERE p NOT IN ('projects.view', 'projects.create', 'projects.manage'));
DROP TABLE task_events;
DROP TABLE task_links;
DROP TABLE task_comments;
DROP TABLE task_checklist_items;
DROP TABLE task_labels;
DROP TABLE task_assignees;
DROP TABLE tasks;
DROP TABLE sprints;
DROP TABLE project_labels;
DROP TABLE task_statuses;
DROP TABLE project_members;
DROP TABLE projects;
