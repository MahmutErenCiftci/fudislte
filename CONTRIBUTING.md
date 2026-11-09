# Contributing to FUDISLTE

Thank you for helping. This page covers where to start, what every change needs, and the
terms under which contributions are accepted.

## Before you start

- **Bugs and small fixes:** open a pull request directly.
- **Features, larger changes, new dependencies:** open an issue first so the design can be
  agreed. The plan is in [docs/roadmap.md](docs/roadmap.md), the reasoning behind the
  architecture in [docs/decisions](docs/decisions).
- **Security problems:** never in a public issue; see [SECURITY.md](SECURITY.md).

## Development setup

The [README](README.md#development-windows) describes the setup: the Go API and
PostgreSQL run in WSL2 on Windows (or directly on Linux and macOS); the web app and the
desktop shell need Node.js 24 and pnpm 12.

## What every change needs

- **Passing checks**, the same ones CI runs:

  ```bash
  pnpm check:api                      # gofmt, go vet, unit and PostgreSQL integration tests
  pnpm typecheck
  pnpm test
  pnpm --filter @fudislte/web build
  ```

  For the AI worker run `scripts/wsl/ai-test.sh`; for the VS Code extension run
  `npm test` in `extensions/vscode`.
- **Code that reads like its surroundings:** naming, structure and comment density follow
  the existing code. Code, comments and documentation are in English.
- **Both languages:** every user-facing string exists in Turkish and English
  (`apps/web/src/i18n/tr.ts` and `en.ts`; API messages also in
  `services/api/internal/i18n/catalog_tr.go`).
- **The security model** ([threat model](docs/security/threat-model.md)): the API authorizes
  every request; anything the caller may not see answers 404; rows are tied to one
  workspace with composite foreign keys; security-relevant changes write audit events.
- **No placeholder UI:** no buttons, tabs or pages for features that do not work yet.
- **Documentation** updated in the same pull request: the architecture document of the
  area, the roadmap, and the threat model when the attack surface changes.
- **Dependencies** reviewed and recorded in [docs/dependencies.md](docs/dependencies.md) in
  the same pull request. Anything shipped must allow redistribution inside a
  source-available product (MIT, BSD, ISC, Apache-2.0 and similar; MPL-2.0 files
  unmodified; OFL for fonts). GPL and AGPL code is not accepted into shipped components.

## License of contributions

FUDISLTE is source-available under the
[PolyForm Internal Use License 1.0.0](LICENSE) ([ADR-0016](docs/decisions/0016-source-available-polyform-internal-use.md)).
Contributions are accepted under the [Contributor License Agreement](CLA.md): you keep
the copyright in your work and license it to the project, including the right to offer
FUDISLTE under other terms.

Agree to it once, by commenting on your first pull request:

> I have read the FUDISLTE Contributor License Agreement (CLA.md, version 1.0) and I agree
> to it for this and all my future Contributions.

Pull requests are not merged before their author has agreed. If you contribute for your
employer, name the organization in the comment and make sure you may do so.

## Pull requests

- One topic per pull request. Describe what changed and why, and link the issue.
- Keep commits focused and squash fix-ups before review.
- CI must pass. Say what you verified by hand (for example in the browser) and what you
  could not verify.
