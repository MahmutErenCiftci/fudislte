# Dependency and License Review

FUDISLTE itself is source-available under the PolyForm Internal Use License 1.0.0 ([ADR-0016](decisions/0016-source-available-polyform-internal-use.md)).

Policy: every dependency's license is checked before adoption (attribution,
redistribution, source-disclosure obligations, paid feature boundaries) and recorded
here in the same pull request. Anything linked into or shipped with FUDISLTE must allow
redistribution inside a source-available product: permissive licenses (MIT, BSD, ISC,
Apache-2.0, 0BSD, Zlib, Unlicense, CC0), MPL-2.0 for files used unmodified, OFL-1.1 for
fonts. GPL and AGPL code is never shipped; LGPL only as a separate, dynamically linked
component after review. Copyleft network services (AGPL) are acceptable only when
deployed separately and unmodified, and only after an explicit decision.

## Notices in distributions

Redistributed code must carry its license texts. Every FUDISLTE distribution does:

| Distribution | Carries |
| --- | --- |
| `fudislte/api` image | `/licenses`: `LICENSE`, `NOTICE`, and `THIRD_PARTY_NOTICES.txt` for the Go standard library and every linked module, generated at build time (a module without a license file fails the build) |
| `fudislte/web` image | Served at `/LICENSE.txt`, `/NOTICE.txt` and `/licenses.txt`; the last lists every production npm package of the web app with its license files (`scripts/licenses/notices.mjs`) and the copyright notices and licenses of the whiteboard fonts (`scripts/licenses/font-notices.mjs`) |
| `fudislte/ai` image | `/licenses`: `LICENSE`, `NOTICE`, and `THIRD_PARTY_NOTICES.txt` for Python and every installed package (`scripts/licenses/python_notices.py`) |
| Desktop installer | `LICENSE.txt` and `NOTICE.txt` beside Electron's `LICENSE.electron.txt` and `LICENSES.chromium.html`; the shell bundles no other third-party code |
| VS Code extension | `LICENSE.txt`; the bundle contains no third-party code |

The repository's own licensing is machine-readable under the REUSE specification
(`REUSE.toml`, `LICENSES/`) and checked in CI with `reuse lint` (GPL-3.0-or-later, run as
a tool, never shipped).

Last reviewed: 2026-11-03 (Phases 1–5, 1.x, the VS Code extension, the operations tooling and the AI worker).

## In use

### Go API (linked into the binary)

| Module | License | Notes |
| --- | --- | --- |
| github.com/go-chi/chi/v5 | MIT | Router |
| github.com/jackc/pgx/v5 (+ puddle, pgpassfile, pgservicefile) | MIT | PostgreSQL driver and pool |
| github.com/pressly/goose/v3 (+ mfridman/interpolate) | MIT | Migrations |
| github.com/sethvargo/go-retry | Apache-2.0 | goose dependency; NOTICE handling required on redistribution |
| go.uber.org/multierr | MIT | goose dependency |
| github.com/google/uuid | BSD-3-Clause | UUIDv7 |
| golang.org/x/crypto, x/time, x/sync, x/sys, x/text | BSD-3-Clause | Argon2id room passwords (Phase 3), rate limiting |

Verified from each module's LICENSE file in the module cache.

### Web and shared packages (bundled into the web app)

| Package | License | Notes |
| --- | --- | --- |
| react, react-dom | MIT | |
| react-router | MIT | |
| @tanstack/react-query | MIT | |
| radix-ui | MIT | Accessible primitives under the shadcn/ui-style components |
| class-variance-authority | Apache-2.0 | |
| clsx, tailwind-merge | MIT | |
| lucide-react | ISC | Icons |
| @fontsource-variable/inter | OFL-1.1 (font), MIT (package) | Font is self-hosted; OFL permits bundling with attribution |
| tailwindcss, @tailwindcss/vite | MIT | Build time |
| vite, @vitejs/plugin-react, vitest, typescript | MIT / MIT / MIT / Apache-2.0 | Build and test time only |

shadcn/ui (MIT) is used as a pattern: components are written in this repository, not
installed as a package.

### Desktop shell

| Package | License | Notes |
| --- | --- | --- |
| electron | MIT | Ships Chromium and Node.js; their notices (`LICENSES.chromium.html`) must accompany installers — electron-builder includes them |
| esbuild | MIT | Build time |
| electron-builder, @electron/fuses | MIT | Packaging (build time); installed in 1.x. Its optional Squirrel dependency (electron-winstaller, MIT) keeps its install script blocked; NSIS is used |

Outgoing email uses Go's standard library (`net/smtp`, `crypto/tls`); no mail dependency
was added.

### Infrastructure images

| Image | License |
| --- | --- |
| postgres | PostgreSQL License (permissive) |
| caddy | Apache-2.0 |
| gcr.io/distroless/static | Apache-2.0 (image tooling); contains only ca-certificates, tzdata |
| livekit/livekit-server:v1.9.4 | Apache-2.0 — voice and video SFU (Phase 4, optional `media` profile); LiveKit's built-in TURN replaces coturn |
| python:3.12-slim | PSF-2.0 plus Debian packages — base of the optional `fudislte/ai` image |
| pgvector/pgvector:0.8.7-pg17 | PostgreSQL License — the AI worker's own vector database (optional overlay) |
| ollama/ollama:0.40.4 | MIT — optional local model server (`ollama` profile of the AI overlay) |

### Voice and video (Phase 4)

| Package | License | Notes |
| --- | --- | --- |
| livekit-client 2.23.0 | Apache-2.0 | Bundled into the web app |
| @livekit/protocol, @livekit/mutex | Apache-2.0 | livekit-client dependencies |
| @bufbuild/protobuf | Apache-2.0 AND BSD-3-Clause | |
| webrtc-adapter | BSD-3-Clause | |
| jose, events, loglevel, machina, sdp, sdp-transform, typed-emitter | MIT | |
| tslib | 0BSD | |

The API talks to LiveKit with the standard library only (HS256 JWTs, Twirp over JSON);
no LiveKit server SDK is linked.

Meeting invitations (4.3) added no dependency either: MIME attachments and iCalendar files
are written with the standard library, and the API embeds Go's time zone database
(`time/tzdata`, part of the Go distribution, BSD-3-Clause; the IANA data is public domain;
about 450 KB), so time zone names validate the same on every system image.

### Projects and whiteboards (Phase 5, bundled into the web app)

| Package | License | Notes |
| --- | --- | --- |
| @excalidraw/excalidraw 0.18.1 | MIT | Whiteboard editor, loaded lazily on board pages; library browser, collaboration server, Excalidraw+ and social links not used |
| Excalidraw's fonts: Excalifont, Virgil, Nunito, Lilita One, Cascadia Code, Assistant, Xiaolai; Comic Shanns | OFL-1.1 (Cascadia: Microsoft's OFL-based terms); Comic Shanns MIT | Copied into `dist/excalidraw/fonts` and served by FUDISLTE; their copyright notices and license texts are added to `/licenses.txt` from the fonts' own name tables (`scripts/licenses/font-notices.mjs`). Excalifont and Xiaolai state no license in the files; their authors publish them under OFL-1.1 |
| Liberation Sans 1.05 (inside the Excalidraw package) | GPL-2.0 with font exception | **Not shipped**: excluded from the build and the dev server (`apps/web/vite.config.ts`); drawings in Excalidraw's legacy "Helvetica" family use the viewer's own fonts |
| jotai, roughjs, perfect-freehand, pica, nanoid, clsx, tunnel-rat, @excalidraw/laser-pointer, @excalidraw/random-username and other Excalidraw dependencies | MIT | `sass` (MIT) is a declared dependency; installed, not bundled |
| @excalidraw/mermaid-to-excalidraw 2.2.2, mermaid 11.17.2 (+ cytoscape, katex, khroma, marked, dagre-d3-es) | MIT | "Text to diagram"; separate lazy chunks |
| d3 7.9 and its modules, delaunator, internmap | ISC | mermaid dependencies |
| d3-array 2, d3-path 1, d3-shape 1, d3-sankey, d3-ease, rw | BSD-3-Clause | mermaid dependencies |
| chevrotain 11 (+ @chevrotain/*), browser-fs-access 0.29.1, pwacompat 2.0.17, crc-32 0.3.0 | Apache-2.0 | Their NOTICE files, where present, are included in `/licenses.txt` |
| dompurify 3.4.17 | MPL-2.0 OR Apache-2.0 | Used under Apache-2.0 |
| pako 2.0.3 | MIT AND Zlib | |
| fractional-indexing 3.2.0 | CC0-1.0 | |
| robust-predicates 3.0.3 | Unlicense | |
| @dnd-kit/core 6.3.1, @dnd-kit/sortable 10.0.0, @dnd-kit/utilities 3.2.2, @dnd-kit/accessibility 3.1.1 | MIT | Kanban drag and drop with keyboard support and screen-reader announcements |

223 packages in all (MIT 167, ISC 35, Apache-2.0 10, BSD-3-Clause 6, one each CC0-1.0,
Unlicense, MIT AND Zlib, MPL-2.0 OR Apache-2.0), checked with `pnpm licenses list --prod`.
Excalidraw pins @radix-ui/react-tabs 1.0.2, whose peer range ends at React 18; boards
render and work with React 19 (checked in the browser). The API added no Go module.

### AI worker (`services/ai`, optional; shipped in the `fudislte/ai` image)

| Package | License | Notes |
| --- | --- | --- |
| fastapi 0.162.0, starlette 1.10.0 | MIT, BSD-3-Clause | HTTP framework |
| uvicorn 0.54.0 (no extras), h11, click | BSD-3-Clause, MIT, BSD-3-Clause | ASGI server |
| pydantic 2.14.2, pydantic_core, annotated-types, typing-inspection, annotated-doc | MIT | Validation |
| typing_extensions 4.16.0 | PSF-2.0 | Permissive; pydantic dependency |
| opentelemetry-api 1.45.2 | Apache-2.0 | FastAPI dependency, unused |
| anyio 4.15.1 | MIT | |
| httpx 0.28.1, httpcore, idna | BSD-3-Clause | Calls to the model server and the API |
| certifi | MPL-2.0 | httpx's CA bundle, used unmodified (file-level copyleft: obligations only when modified) |
| asyncpg 0.32.0 | Apache-2.0 | PostgreSQL driver, chosen over LGPL psycopg |
| python-multipart 0.0.32 | Apache-2.0 | Multipart uploads |
| pytest and plugins | MIT / BSD / Apache-2.0 | Tests only |
| faster-whisper 1.2.1 (optional extra) | MIT | Pulls ctranslate2 and onnxruntime (MIT), tokenizers and huggingface-hub (Apache-2.0), tqdm (MPL-2.0 AND MIT) and PyAV (BSD-3-Clause, whose wheels bundle LGPL FFmpeg libraries). Not in the default image; review before distributing an image built with `WITH_WHISPER=true` |

Exact versions are pinned in `services/ai/requirements.lock`, verified from each installed
package's metadata.

### VS Code extension (`extensions/vscode`, build time only)

Nothing from third parties ships in the `.vsix`: `dist/extension.js` contains only the
extension's own code, and the VS Code API comes from the editor.

| Package | License | Notes |
| --- | --- | --- |
| esbuild 0.28 | MIT | Bundling |
| typescript 6.0 | Apache-2.0 | Type checking |
| @types/vscode 1.90, @types/node 20.19 | MIT | Types |
| @vscode/vsce 4.1 | MIT | Packaging |

`@vscode/vsce` brings build-time dependencies under other licenses, none of them shipped:
`@vscode/vsce-sign` and its platform binary (Microsoft Software License Terms, which allow
use with VS Code to develop and test; vsce uses it only for signing), `istextorbinary`,
`binaryextensions`, `textextensions`, `editions`, `version-range` (Artistic-2.0) and
`minimatch`, `sax` (BlueOak-1.0.0, permissive). Accepted for packaging only. The
extension is under FUDISLTE's license and ships `LICENSE.txt`; it is packaged with
`--allow-missing-repository` until the public repository URL is set in its `package.json`.

### Operations tooling (`scripts/ops`, `tools/loadtest`)

`tools/loadtest` is a separate Go module that uses only the standard library. The backup
and restore scripts call programs on the Docker host that FUDISLTE does not ship: bash, GNU
tar and coreutils (GPL-3.0, run as separate programs, no obligations for FUDISLTE), the
PostgreSQL client tools inside the postgres image, and optionally
[age](https://github.com/FiloSottile/age) (BSD-3-Clause) for encryption.

## Evaluated for later phases

| Project | License | Decision |
| --- | --- | --- |
| Casbin (Go) | Apache-2.0 | Deferred; relational RBAC chosen (ADR-0005) |
| Centrifugo | Apache-2.0 (OSS); Centrifugo PRO is commercial | Phase 2 candidate; use OSS features only |
| Redis | RSALv2/SSPL (7.4–7.8), AGPL-3.0 option since 8.0 | Prefer **Valkey** (BSD-3-Clause) as the Redis-compatible store |
| MinIO | AGPL-3.0; community edition distribution has been reduced | Not adopted. Candidates: **SeaweedFS** (Apache-2.0), **Garage** (AGPL-3.0, separate service) — decide in Phase 2 |
| LiveKit components-js, egress, agents | Apache-2.0 | Not needed for Phase 4 (own UI); egress/agents may serve Phase 8 |
| coturn | BSD-3-Clause | Not adopted: LiveKit's built-in TURN suffices (ADR-0011) |
| Excalidraw | MIT | Adopted (Phase 5) |
| Yjs, Hocuspocus | MIT | Not adopted: the API merges Excalidraw's element versions (ADR-0015) |
| tldraw | tldraw license — production use requires a license key | Not adopted without a commercial decision |
| Tiptap (core, open extensions) | MIT; Pro extensions and Tiptap Cloud are commercial | Phase 7: open-source extensions only |
| Ollama | MIT | Adopted as the optional `ollama` profile of the AI overlay (ADR-0012) |
| vLLM | Apache-2.0 | Supported through its OpenAI-compatible API, not bundled |
| pgvector | PostgreSQL License | Adopted for the AI index (ADR-0012) |
| faster-whisper | MIT; Whisper model weights MIT | Optional extra of the AI worker (see its table) |
| pyannote.audio | MIT code; pretrained pipelines are gated and require accepting terms on Hugging Face | Phase 8; review model terms before shipping |
| Playwright | Apache-2.0 | Phase 9 browser automation |
| Mattermost | Source-available mix (AGPL-3.0 / Apache-2.0 / commercial EE) | Reference for UX and architecture only; no code copied |
| Plane | AGPL-3.0 | Reference only; no code copied |
| Zulip | Apache-2.0 | Reference only |

Every new dependency added in a later phase gets a row here in the same pull request.
