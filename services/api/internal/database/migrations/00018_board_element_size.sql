-- +goose Up

-- The size of each whiteboard element's JSON, so the server can cap a board's total size
-- (deleted shapes included) without re-reading every element on each write. Without a
-- cap, one editor could fill a board until opening it exhausts the API's memory.
ALTER TABLE board_elements ADD COLUMN size integer NOT NULL DEFAULT 0;
UPDATE board_elements SET size = octet_length(data::text);
ALTER TABLE board_elements ADD CONSTRAINT board_elements_size_nonnegative CHECK (size >= 0);

-- +goose Down
ALTER TABLE board_elements DROP COLUMN size;
