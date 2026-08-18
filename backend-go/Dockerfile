# Traceo Go backend — FR-081 (on-premise deployment).
#
# Two stages so the shipped image carries no toolchain and no source: the result
# is a single static binary on a minimal base, which is what makes an air-gapped
# install reviewable (BR-07, NFR-D1). CGO is off so the binary has no libc
# dependency — the sqlite driver (glebarez/sqlite) is pure Go by design.

FROM golang:1.24-alpine AS build
WORKDIR /src

# Dependencies first: this layer is cached until go.mod/go.sum actually change.
COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/traceo ./cmd/server

FROM alpine:3.20
# ca-certificates: needed to execute tests against an HTTPS system-under-test.
# It does NOT imply outbound access — the offline mock LLM provider stays default.
RUN apk add --no-cache ca-certificates tzdata \
    && adduser -D -u 10001 traceo
WORKDIR /app

COPY --from=build /out/traceo /usr/local/bin/traceo

# Writable state lives here; mount a volume so data survives an image upgrade.
RUN mkdir -p /data/storage && chown -R traceo:traceo /data
USER traceo

ENV TRACEO_DATABASE_URL=/data/traceo.db \
    TRACEO_STORAGE_DIR=/data/storage \
    TRACEO_PORT=8000
EXPOSE 8000

# Deliberately NOT setting TRACEO_ENV=production here: production also requires a
# unique TRACEO_SECRET_KEY and TRACEO_SEED_DEMO=0, and the backend refuses to
# start without them. Setting it in the image would turn a deploy-time mistake
# into a build-time surprise.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
    CMD wget -qO- http://127.0.0.1:8000/health >/dev/null || exit 1

ENTRYPOINT ["traceo"]
