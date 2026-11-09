# ADR-0009: Attachments on the API server's disk

Status: Accepted · Phase 2

## Context
Messages need file attachments. The roadmap planned an S3-compatible object store
(Garage or SeaweedFS) with a license review still open (Garage is AGPL-3.0). Most
installations run one API node; another service adds setup, backups and upgrades to an
IT team's work for no benefit at that size.

## Decision
- Files are stored on the API server's disk under `FUDISLTE_DATA_DIR` (a Docker volume in
  the Compose stack), one file per attachment, named by its random ID and grouped by
  workspace: `files/{orgID}/{attachmentID}`. Metadata (name, size, type, SHA-256,
  uploader, channel, message) lives in PostgreSQL.
- Storage sits behind a small interface (put, open, delete). An S3-compatible backend can
  be added when several API replicas share files, after a license review.
- Upload: one file per request, streamed to disk, at most `FUDISLTE_MAX_UPLOAD_MB` (25 by
  default). The content type is detected from the bytes, never taken from the client.
  An attachment belongs to its channel and uploader until it is sent with a message;
  unsent uploads are removed after 24 hours.
- Download goes through the API and checks that the caller may see the channel.
  Responses carry `X-Content-Type-Options: nosniff` and a `sandbox` Content-Security-
  Policy; only raster images (PNG, JPEG, GIF, WebP) are shown inline, everything else is
  a download. SVG and HTML are never rendered.
- Deleting a message, a channel or a workspace deletes its files; retention (increment
  2.6) does too.

## Consequences
- Backups must include the data volume as well as the database (documented in the
  deployment guide).
- No new service, no license question for Phase 2.
- Several API replicas need the shared backend first (same trigger as ADR-0008).
