# syntax=docker/dockerfile:1
# Build context: repository root (services/api/Dockerfile.dockerignore keeps it small).
#   docker build -f services/api/Dockerfile -t fudislte/api:dev .
FROM golang:1.27-alpine AS build
WORKDIR /src
COPY services/api/go.mod services/api/go.sum ./
RUN go mod download
COPY services/api/ .
ARG VERSION=0.1.1
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w -X main.version=${VERSION}" -o /out/fudislte-api ./cmd/fudislte-api \
 && mkdir -p /out/data
# Licenses that travel with the binary: FUDISLTE's own, the Go standard library's and those
# of every module linked into it. A module without a license file fails the build.
COPY LICENSE NOTICE /out/licenses/
RUN set -eu; chmod 644 /out/licenses/LICENSE /out/licenses/NOTICE; { \
      echo "Third-party software included in the fudislte-api binary"; echo; \
      echo "FUDISLTE itself is licensed under the PolyForm Internal Use License 1.0.0 (LICENSE, NOTICE)."; \
      echo; echo "== Go standard library and runtime ($(go env GOVERSION))"; echo; \
      cat "$(go env GOROOT)/LICENSE"; \
      go list -deps -f '{{with .Module}}{{if not .Main}}{{.Path}}@{{.Version}} {{.Dir}}{{end}}{{end}}' ./cmd/fudislte-api \
        | sort -u | while read -r module dir; do \
          echo; echo "== $module"; found=; \
          for f in "$dir"/LICENSE* "$dir"/LICENCE* "$dir"/COPYING* "$dir"/NOTICE* "$dir"/PATENTS*; do \
            if [ -f "$f" ]; then echo; cat "$f"; found=1; fi; \
          done; \
          if [ -z "$found" ]; then echo "no license file in $module" >&2; exit 1; fi; \
        done; \
    } > /out/licenses/THIRD_PARTY_NOTICES.txt

# Static binary on a minimal, shell-less base image running as an unprivileged user.
FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/fudislte-api /fudislte-api
COPY --from=build /out/licenses /licenses
# The data directory exists and belongs to nonroot, so a fresh volume inherits that.
COPY --from=build --chown=nonroot:nonroot /out/data /var/lib/fudislte
USER nonroot:nonroot
EXPOSE 8080
ENTRYPOINT ["/fudislte-api"]
CMD ["serve"]
