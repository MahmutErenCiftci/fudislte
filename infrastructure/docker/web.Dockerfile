# syntax=docker/dockerfile:1
# Builds the web app and serves it with Caddy, which also terminates TLS and proxies
# /api to the API container. Build context: repository root.
FROM node:24-alpine AS build
RUN npm install -g pnpm@12.5.1
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/web/package.json apps/web/
COPY apps/desktop/package.json apps/desktop/
COPY packages/ui/package.json packages/ui/
COPY packages/api-client/package.json packages/api-client/
COPY packages/platform/package.json packages/platform/
RUN pnpm install --frozen-lockfile --filter "@fudislte/web..."
COPY tsconfig.base.json ./
COPY packages packages
COPY apps/web apps/web
COPY scripts/licenses scripts/licenses
COPY LICENSE NOTICE ./
COPY LICENSES LICENSES
# FUDISLTE's license and notices are served beside the bundle's third-party notices:
# /LICENSE.txt, /NOTICE.txt and /licenses.txt.
RUN pnpm --filter @fudislte/web build \
 && node scripts/licenses/notices.mjs --filter "@fudislte/web..." --title "the FUDISLTE web app" > apps/web/dist/licenses.txt \
 && node scripts/licenses/font-notices.mjs apps/web/dist/excalidraw/fonts \
      apps/web/node_modules/@fontsource-variable/inter/LICENSE >> apps/web/dist/licenses.txt \
 && install -m 644 LICENSE apps/web/dist/LICENSE.txt \
 && install -m 644 NOTICE apps/web/dist/NOTICE.txt

FROM caddy:2-alpine
COPY infrastructure/docker/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /repo/apps/web/dist /srv
