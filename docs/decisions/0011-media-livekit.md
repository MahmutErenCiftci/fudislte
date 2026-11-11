# ADR-0011: Voice and video through self-hosted LiveKit

Status: Accepted · Phase 4

## Context
Phase 4 adds persistent voice rooms, video, screen sharing and meetings. Media must stay
on infrastructure the organization runs (non-negotiable 1), and losing access to a room
must cut media as well as messages and files (ADR-0010). Building an SFU is out of scope.

## Decision
- **LiveKit server** (Apache-2.0, `livekit/livekit-server:v1.9.4`) is the SFU, run beside
  FUDISLTE: an optional `media` Compose profile in production, `scripts/wsl/dev-livekit.sh`
  in development. Clients use **livekit-client** (Apache-2.0). LiveKit's built-in TURN
  (UDP 3478) serves restrictive networks; coturn is not needed.
- **The API decides who may connect.** It signs LiveKit access tokens itself (HS256 JWT
  with the shared API key and secret; no SDK dependency) only for people admitted to the
  room, with publish rights limited to microphone, camera and screen share, and an
  expiry no later than their admission's. LiveKit room names are `fudislte-<roomID>`.
- **Revocation reaches media.** Whatever ends an admission (new password, access-list
  change, expiry, manager action, room deletion) also calls LiveKit's `RemoveParticipant`.
  A sweep every 30 seconds removes anyone in a FUDISLTE LiveKit room who is no longer
  admitted or whose account is disabled, and the API checks every `participant_joined`
  webhook. Room managers mute or remove participants through the API (audited).
- **Webhooks** are verified like LiveKit signs them: a JWT signed with the API secret
  carrying the SHA-256 of the body. They relay who is in voice to the room's members.
- **Same origin.** Behind the bundled Caddy, signalling is `wss://<domain>/livekit`
  (path stripped), so no second certificate or CSP exception is needed; media uses UDP
  7882 (one port), TCP 7881 as a fallback and TURN on UDP 3478.
- **The connection lives outside the pages.** The web app keeps one LiveKit connection
  per window in a store outside React routes, so voice survives navigation; a dock in the
  sidebar shows and controls it on every page.
- **Desktop:** the Electron shell grants microphone, camera and screen capture only to the
  connected server's origin, and screen sharing always goes through the app's own picker
  window (screens and windows with thumbnails), like a browser's picker; the server's page
  receives only the stream that was picked and nothing is shared without a choice. (Until
  2026-11 the picker was drawn by the page, which then saw every window's title and
  thumbnail and could answer for the person.)

## Consequences
- Without LiveKit settings voice and video are simply absent (`503 media_unavailable`, no
  voice panel); the rest of FUDISLTE is unaffected.
- One LiveKit node serves one installation; several API replicas or LiveKit nodes need a
  shared limiter and LiveKit's Redis-based routing (ADR-0008 applies).
- Media is encrypted in transit (DTLS-SRTP) but the SFU sees it; end-to-end encryption is
  not claimed.
