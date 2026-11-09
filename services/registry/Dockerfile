# syntax=docker/dockerfile:1
# Build context: repository root (services/registry/Dockerfile.dockerignore keeps it small).
#   docker build -f services/registry/Dockerfile -t fudislte/registry:dev .
FROM golang:1.27-alpine AS build
WORKDIR /src
COPY services/registry/ .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/fudislte-registry . \
 && mkdir -p /out/data
# Standard library only: the Go license is the only third-party notice.
COPY LICENSE NOTICE /out/licenses/
RUN chmod 644 /out/licenses/LICENSE /out/licenses/NOTICE \
 && cp "$(go env GOROOT)/LICENSE" /out/licenses/GO_LICENSE

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/fudislte-registry /fudislte-registry
COPY --from=build /out/licenses /licenses
COPY --from=build --chown=nonroot:nonroot /out/data /var/lib/fudislte-registry
USER nonroot:nonroot
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD ["/fudislte-registry", "healthcheck"]
ENTRYPOINT ["/fudislte-registry"]
CMD ["serve"]
