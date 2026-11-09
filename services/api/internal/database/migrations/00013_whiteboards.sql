-- +goose Up

-- Whiteboards (docs/architecture/phase-5.md). A board belongs to a project — and then
-- follows the project's access — or to the whole workspace. room_id optionally names a
-- secure room for voice next to the board; the API shows it only to people who may see
-- that room.
CREATE TABLE boards (
    id          uuid PRIMARY KEY,
    org_id      uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    project_id  uuid,
    room_id     uuid,
    title       text NOT NULL,
    description text NOT NULL DEFAULT '',
    created_by  uuid REFERENCES users (id) ON DELETE SET NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT boards_id_org_key UNIQUE (id, org_id),
    CONSTRAINT boards_project_fkey FOREIGN KEY (project_id, org_id)
        REFERENCES projects (id, org_id) ON DELETE CASCADE,
    CONSTRAINT boards_room_fkey FOREIGN KEY (room_id, org_id)
        REFERENCES channels (id, org_id) ON DELETE SET NULL (room_id),
    CONSTRAINT boards_title_length CHECK (char_length(title) BETWEEN 1 AND 120),
    CONSTRAINT boards_description_length CHECK (char_length(description) <= 500)
);
CREATE INDEX boards_org_idx ON boards (org_id, updated_at DESC);
CREATE INDEX boards_project_idx ON boards (project_id) WHERE project_id IS NOT NULL;

-- The scene: one row per Excalidraw element, with the element's own JSON. Writes keep
-- the higher version per element; on equal versions the lower version_nonce wins
-- (Excalidraw's rule), so every client converges on the same scene. Deleted elements
-- stay as tombstones so stale copies cannot bring them back.
CREATE TABLE board_elements (
    board_id      uuid NOT NULL REFERENCES boards (id) ON DELETE CASCADE,
    element_id    text NOT NULL,
    version       bigint NOT NULL,
    version_nonce bigint NOT NULL,
    data          jsonb NOT NULL,
    deleted       boolean NOT NULL DEFAULT false,
    updated_by    uuid REFERENCES users (id) ON DELETE SET NULL,
    updated_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (board_id, element_id),
    CONSTRAINT board_elements_id_format CHECK (element_id ~ '^[A-Za-z0-9_-]{1,64}$'),
    CONSTRAINT board_elements_version_positive CHECK (version > 0)
);

-- Default roles: everyone but guests creates whiteboards and works on the workspace's
-- boards; project boards follow project membership, guests included.
UPDATE roles SET permissions = permissions || ARRAY['boards.create']
WHERE key <> 'guest';

-- +goose Down
UPDATE roles SET permissions = ARRAY(
    SELECT p FROM unnest(permissions) AS p WHERE p <> 'boards.create');
DROP TABLE board_elements;
DROP TABLE boards;
