# ADR-0015: Whiteboard collaboration over the existing event stream

Status: Accepted · Phase 5

## Context
Phase 5 adds whiteboards with persistence and live collaboration; the exit check is "two
users edit one board". Boards belong to a project (and must follow its access, private
projects included) or to the workspace. The roadmap planned Excalidraw, "plus Yjs only
if required".

Options considered:
- **Excalidraw's own collaboration** (excalidraw-room over Socket.IO, scenes encrypted
  with a key in the URL fragment, persistence in Firebase): a separate service with its
  own notion of access — whoever has the link — and an external store.
- **Yjs with y-websocket or Hocuspocus**: a CRDT document per board on another service
  speaking WebSockets; the document is an opaque blob the API cannot authorize element by
  element, and Excalidraw would need a binding layer.
- **tldraw**: production use requires a license key (docs/dependencies.md).

## Decision
- Excalidraw (MIT) is the editor, loaded lazily on board pages only. Its fonts are served
  by FUDISLTE itself (`EXCALIDRAW_ASSET_PATH`), and its links to external services — the
  library browser, live-collaboration button, Excalidraw+, social links — are left out.
  Images and embeds are disabled until they can be stored with the board's access rules.
- The scene is stored per element (`board_elements`: id, version, versionNonce, the
  element's JSON, tombstone flag). Clients send the elements they changed in batches
  (`PATCH /boards/{id}/elements`, about every 100 ms). The server keeps the copy with the
  higher version and, on equal versions, the lower versionNonce — Excalidraw's own
  reconciliation rule — in one SQL statement, so the order in which batches arrive does
  not matter and every client converges on the same scene.
- Accepted elements go out as `board.elements` events on the existing Server-Sent Events
  stream (ADR-0008), to the people currently viewing the board. Viewing is tracked in
  memory with heartbeats (30-second expiry), and every send re-checks who may still see
  the board, so someone removed from the project stops receiving it at once.
- Cursors are relayed the same way (`board.cursor`) and never stored.
- After a reconnect the client merges the stored scene, deleted elements included, with
  the same rule.

## Consequences
- No new service and no WebSocket server: board writes use the normal REST API with its
  authentication, CSRF protection, body limits and rate limits.
- Per-element last-writer-wins: two people changing the same shape at the same moment end
  with one of the two versions (as on excalidraw.com); different shapes never conflict.
- Latency is one batch interval plus a round trip (typically 100–300 ms on a LAN).
- Deleted elements stay as tombstones so stale copies cannot bring them back; there is no
  compaction yet. A board holds at most 10,000 live shapes.
- Viewer lists and rate limits are per API process: like the rest of the live events,
  several replicas need the shared transport ADR-0008 describes.
- Undo history is per client, as in Excalidraw itself.
