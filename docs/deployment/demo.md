# Live demo

The live demo is the real web app (`apps/web`) built so it needs no server. Every request it
would send to `/api/v1`, and the live event stream, is answered inside the visitor's
browser by a small in-memory stand-in for the API (`apps/web/src/demo`). The visitor lands
in a sample workspace without signing in. Their changes stay in that browser tab, and a
reload starts the demo over. Nothing is stored or sent anywhere.

The demo cannot leak data or be abused, because no FUDISLTE server or database is behind it.
The cost is that it only shows what the stand-in imitates: chat, channels, direct messages,
threads, reactions, pins, search, presence and notifications so far. Projects, rooms,
meetings and whiteboards open empty. File uploads and voice and video are turned off, with
a message saying they work on your own server.

## Run it locally

```bash
pnpm --filter @fudislte/web dev:demo      # http://localhost:5175
pnpm --filter @fudislte/web build:demo    # static files in apps/web/dist-demo
```

`?lang=tr` or `?lang=en` in the address opens the demo in that language. The website's
demo buttons pass the visitor's language this way.

## Publish it on Cloudflare Pages

The demo is its own Pages project, next to the website's. Connect the repository in the
Cloudflare dashboard (*Workers & Pages → Create → Pages → Connect to Git*) with:

- Project name: **`fudislte-demo`**, which serves the demo at `https://fudislte-demo.pages.dev`
- Production branch: **`main`**
- Framework preset: **None**
- Root directory: *(empty, the repository root)*
- Build command: **`pnpm --filter @fudislte/web build:demo`**
- Build output directory: **`apps/web/dist-demo`**
- Environment variables:
  - `NODE_VERSION` = `24`
  - `PNPM_VERSION` = `12.5.1` (the `packageManager` in `package.json`)
  - `ELECTRON_SKIP_BINARY_DOWNLOAD` = `1` (the desktop app is not built here)

Pages installs the dependencies with pnpm and rebuilds the demo on every push to `main`,
so the demo always shows the current interface. Under *Settings → Build → Build watch
paths*, include `apps/web/*` and `packages/*` to skip builds for unrelated changes.

The build writes a `_headers` file with the same security headers the server sends
(`infrastructure/docker/Caddyfile`). Pages serves `index.html` for every other path, which
the app's routes need.

To publish from your own machine instead:

```bash
pnpm --filter @fudislte/web build:demo
npx wrangler pages deploy apps/web/dist-demo --project-name fudislte-demo
```

### A custom domain

Under the project's *Custom domains*, add a name such as `demo.<your domain>`. Then set
`DEMO_URL` at the top of `website/script.js` to that address. Every demo button on the
website uses it.

## Extending the demo

`seed.ts` holds the sample people, channels and messages in Turkish and English.
`backend.ts` answers the API, with routes written like the server's and responses shaped
by the types in `packages/api-client`. An endpoint it does not know answers a `GET` with
404 and anything else with a "turned off in the demo" error. When an endpoint changes in
`services/api`, update the stand-in too. Otherwise the demo shows the old behaviour, and
TypeScript catches only changes to the response types.
