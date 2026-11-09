# ADR-0014: Open source under the Apache License 2.0

Status: Superseded by [ADR-0016](0016-source-available-polyform-internal-use.md) · 2026-10-30 (never released under Apache-2.0)

## Context

FUDISLTE was first planned as a product sold two ways: hosted by the vendor, and as
licensed installs on customers' own servers. On 2026-10-30 the owner decided to publish
it as open source instead: anyone may use, change, host and redistribute it, and the
licensing has to be done properly.

| License | For | Against |
| --- | --- | --- |
| MIT | Short, permissive, well known | No explicit patent license; no contribution terms |
| **Apache-2.0** | Permissive; explicit patent license that ends for anyone who sues over patents; contributions licensed under the same terms (section 5); a NOTICE file for attributions; common for infrastructure software (Kubernetes, LiveKit, Zulip) | Longer; NOTICE has to be maintained |
| MPL-2.0 | File-level copyleft keeps changes to FUDISLTE's own files open | Obligations for everyone who ships modified files, against "do what you want" |
| AGPL-3.0 | Hosted modifications must be published (used by e.g. Mattermost's server, Synapse, Nextcloud) | Strong obligations for users and hosting companies; many companies do not allow AGPL software |
| Source-available (BSL, FSL) | Protects a future commercial offering | Not open source; protecting a sale is no longer the goal |

## Decision

Apache-2.0 for the whole repository: API, web app, desktop shell, AI worker, VS Code
extension, deployment files and documentation.

- `LICENSE` holds the license text. `NOTICE` holds the attributions that must accompany
  redistributions: "The FUDISLTE Authors" and the shadcn/ui components (MIT).
- Licensing is machine-readable under the REUSE specification (`REUSE.toml`,
  `LICENSES/`) and checked with `reuse lint`.
- Contributions are accepted under Apache-2.0 (inbound = outbound) with a Developer
  Certificate of Origin sign-off on every commit (`CONTRIBUTING.md`); no CLA.
- Apache-2.0 does not license the name (section 6). There is no separate trademark policy
  yet.

## Consequences

- Anyone may fork, sell and host FUDISLTE, modified or not, without publishing changes.
- Dependency policy ([dependencies.md](../dependencies.md)): everything shipped must allow
  redistribution inside an Apache-2.0 project — permissive licenses, MPL-2.0 files used
  unmodified, OFL fonts. No GPL or AGPL code in shipped components; LGPL only as a separate,
  dynamically linked component after review (the optional Whisper build of the AI worker).
- Every distribution carries its notices. The container images ship `/licenses`:
  FUDISLTE's `LICENSE` and `NOTICE`, plus a `THIRD_PARTY_NOTICES.txt` generated at build time
  for the Go modules or Python packages inside. The web app serves `/licenses.txt` for its
  bundled packages. The desktop installer carries `LICENSE.txt` and `NOTICE.txt` beside
  Electron's license files, and the VS Code extension ships `LICENSE.txt`.
- Released versions stay Apache-2.0. The license already permits proprietary or
  differently licensed products built on the code, so a commercial offering stays possible.
