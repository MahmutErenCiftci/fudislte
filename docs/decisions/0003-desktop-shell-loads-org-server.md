# ADR-0003: Electron desktop shell that loads the organization's server

Status: Accepted · Phase 1

## Context
The desktop client must not be the company server, must share the web application, and
needs reliable WebRTC and screen capture (Phase 4). Options considered:

| Option | Pros | Cons |
| --- | --- | --- |
| **A. Shell loads the org server origin** (Mattermost Desktop model) | Same origin and cookie session as the browser; no version skew; tiny shell | Needs the server reachable at startup; remote content must be treated as untrusted |
| B. Bundle the web build in the app, call the API cross-origin (Element model) | Starts offline; code is signed with the app | CORS, bearer tokens in renderer memory, client/server version skew across many self-hosted versions |
| C. Tauri / Wails | Smaller binaries | System webviews differ per OS; WebRTC and screen capture are inconsistent (notably WebKitGTK on Linux) |

## Decision
Option A with Electron. The shell owns only: the server address, window management,
navigation/permission policy, and a minimal preload bridge (`window.fudislteDesktop`,
contract in `packages/platform`). The renderer is sandboxed and treated as untrusted.
Tauri and Wails remain possible later because the React app has no Electron imports.

## Consequences
- Every bridge method is reviewed as a security boundary: sender-origin checks and
  argument validation in the main process.
- The connect page is bundled locally and served via a custom `fudislte://` protocol.
- Offline-first desktop behaviour is out of scope until there is a concrete need.
- The bridge itself can still skew: the page comes from the server and is often newer
  than the installed shell. Bridge methods added after the first release are optional
  in the contract, and `packages/platform` gives the page a harmless fallback when one is
  missing, so an older shell only lacks that feature. Phase 4 found this: a shell from
  before screen sharing crashed the whole page on the missing `onDisplayPick`. Removing
  or changing an existing method needs a compatibility plan.
