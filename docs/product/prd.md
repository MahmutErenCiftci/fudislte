# FUDISLTE — Product Requirements (concise)

## Problem
Companies that need to own their communication data (regulated industries, public
sector, security-sensitive engineering teams) must stitch together chat, meetings, task
tracking, whiteboards and docs from SaaS vendors, or self-host several unrelated tools
with separate identities, permissions and backups.

## Product
FUDISLTE is one self-hosted workspace: channels and direct messages, persistent voice
rooms and meetings, secure password-protected rooms, tasks and projects, whiteboards,
documents, Git activity and (optionally) local AI — under a single identity,
permission model, audit log and backup.

**Design principle: simple on the surface, powerful underneath.**

## Users
- **Owner / administrators** — deploy, configure roles, invite people, audit.
- **Security administrators** — review audit trails, enforce policies.
- **Team leads, project and product managers** — organise teams, projects, meetings.
- **Developers and employees** — communicate, collaborate, track work.
- **Guests** — limited access to explicitly shared spaces.

## Non-negotiables
1. Runs entirely on infrastructure the organization controls; no mandatory third-party cloud.
2. Authorization is enforced by the backend for every resource.
3. Browser and desktop clients share one UI and one business-logic layer.
4. No hidden monitoring: developer presence is opt-in and never includes code or keystrokes.
5. AI is optional, local-first, permission-aware, and never invents decisions.

## MVP definition (end of Phase 4)
A 5–50 person company can deploy FUDISLTE with Docker Compose and:
- sign in from browser and desktop, see workspaces and role-grouped members (Phase 1);
- chat in public/private channels and DMs in real time with files (Phase 2);
- create password-protected and restricted rooms where a password never bypasses
  authorization (Phase 3);
- talk in persistent voice rooms, run video meetings and share screens through
  self-hosted LiveKit, staying connected while navigating (Phase 4).

Acceptance criteria 1–11 of the master plan map to these phases; the remaining criteria
belong to Phases 5–10 (see [roadmap](../roadmap.md)).

## Phase 1 feature specification
| Feature | Behaviour |
| --- | --- |
| First-run setup | Setup token + a code emailed to the owner (proves mail works). Creates the instance admin, the first workspace and its nine default roles. |
| Sign in / out | **No usernames or passwords.** Work email → one-time 8-digit code by email (10 min, single use). Same response for unknown addresses. Rate limited. |
| Email domains | Admins register company domains (e.g. firma.com) with a join role. New people from that domain sign in with a code and join automatically. Public providers and management roles are blocked. |
| Sessions | List own sessions with device and last activity; revoke one or all others. |
| Profile | Change display name. New people from a domain confirm their name after the first sign-in. |
| Workspaces | Switcher for every workspace the user belongs to; instance admins can create more. |
| Invitations | Admins pick email + role; FUDISLTE emails a single-use link (7-day expiry) that can also be copied; pending invites can be revoked. |
| Accept invitation | New people enter their name and a code sent to the invited address; existing users sign in, and the email must match. |
| Members | Directory grouped by role in the right panel; managers change roles or remove members within hierarchy rules. |
| Roles | Default roles editable; custom roles with chosen permissions and rank; Owner immutable. |
| Audit log | Chronological, paginated list of workspace security events. |
| Theme | Light, dark, follow system. |
