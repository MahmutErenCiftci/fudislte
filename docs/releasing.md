# Releasing FUDISLTE

A checklist for maintainers. Versions follow [Semantic Versioning](https://semver.org/);
while the version is 0.x, minor versions may break things and say so in the changelog.

## Before tagging

1. CI is green on `main` ([.github/workflows/ci.yml](../.github/workflows/ci.yml)): Go API,
   load-test tool, web app and packages, AI worker, VS Code extension, container images,
   REUSE licensing.
2. Set the version everywhere it appears: the `version` fields of the `package.json` files,
   `services/ai/pyproject.toml`, `extensions/vscode/package.json`, and `FUDISLTE_VERSION`
   in `infrastructure/docker/.env.example` (the API takes it from the build argument).
3. Move the `Unreleased` entries of [CHANGELOG.md](../CHANGELOG.md) under the new version
   with today's date. Call out database migrations and anything an operator must do.
4. Every new dependency has a row in [dependencies.md](dependencies.md), and the
   [threat model](security/threat-model.md) reflects new surfaces.
5. Run a restore drill with the release's images
   ([backup-restore.md](deployment/backup-restore.md#restore-drills)): back up a filled
   deployment of the previous release, upgrade it, restore the backup into the new one.

## Building the artifacts

- **Container images** (build context: repository root):

  ```bash
  docker build -f services/api/Dockerfile --build-arg VERSION=<version> -t fudislte/api:<version> .
  docker build -f infrastructure/docker/web.Dockerfile -t fudislte/web:<version> .
  docker build -f services/ai/Dockerfile -t fudislte/ai:<version> .
  ```

  Each image carries its notices: `/licenses` in the api and ai images, `/licenses.txt`,
  `/LICENSE.txt` and `/NOTICE.txt` served by the web image. A build fails when a Go module
  or a whiteboard font has no recognisable license.
- **Desktop installers:** built by [.github/workflows/release.yml](../.github/workflows/release.yml)
  when the tag is pushed — Windows (NSIS), macOS (DMG, Apple Silicon) and Linux
  (AppImage) — and attached to the GitHub release with `SHA256SUMS.txt`. The asset names
  are fixed (`FUDISLTE-Setup.exe`, `FUDISLTE-arm64.dmg`, `FUDISLTE-x86_64.AppImage`)
  because the website's download buttons link to `/releases/latest/download/<name>`.
  The workflow signs when the repository secrets exist: `WIN_CSC_LINK` and
  `WIN_CSC_KEY_PASSWORD` (Windows), `MAC_CSC_LINK` and `MAC_CSC_KEY_PASSWORD` (macOS,
  Developer ID). Without them the installers are unsigned and Windows SmartScreen and
  macOS Gatekeeper warn when they are opened. Locally:
  `pnpm --filter @fudislte/desktop dist`.
- **VS Code extension:** `npm run package` and `npm run check:vsix` in
  `extensions/vscode`; set the `repository` field first so `--allow-missing-repository`
  can be dropped.

## Publishing

1. Tag the commit `v<version>` (signed tag) and push it.
2. The release workflow creates the GitHub release from the tag with the changelog
   section, the installers and their SHA-256 checksums. Attach the `.vsix` if it ships.
3. Push the images to the registry, if the project publishes images.
4. Announce breaking changes and required operator steps prominently.
