# RiiMusic: one image with the web app, the server, ffmpeg and a JS runtime for yt-dlp.
#
#   docker compose up -d --build        (see docker-compose.yml, reads .env)
#
# Build args:
#   AGENT_BINARIES=false  true also builds the Discord agent as programs for Windows /
#                         macOS / Linux at /download/agent/… (≈ +60 MB). Not needed:
#                         users run the agent as a script from /agent.ps1 or /agent.sh.

# ── 1. Web app ───────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS web
WORKDIR /src/web
RUN corepack enable
COPY web/package.json web/pnpm-lock.yaml web/.npmrc ./
RUN pnpm install --frozen-lockfile
COPY web/ ./
RUN pnpm build

# ── 2. Go binaries with the web app embedded ─────────────────────────────
FROM golang:1.27-bookworm AS server
ARG AGENT_BINARIES=false
# Release version (CI passes VERSION.major.minor + run number); "dev" otherwise.
ARG VERSION=dev
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY main.go ./
COPY internal/ ./internal/
COPY web/embed.go ./web/
COPY --from=web /src/web/dist ./web/dist
ENV CGO_ENABLED=0
RUN go build -trimpath -ldflags="-s -w -X rii_music/internal/server.Version=${VERSION}" -o /out/rii_music .
# The same binary is the Discord agent ("rii_music discord-agent …"); users download
# the build for their computer from Cài đặt → Trạng thái Discord.
RUN mkdir -p /out/agent && if [ "$AGENT_BINARIES" = "true" ]; then \
      GOOS=windows GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o /out/agent/rii_music-windows-amd64.exe . && \
      GOOS=darwin  GOARCH=arm64 go build -trimpath -ldflags="-s -w" -o /out/agent/rii_music-macos-arm64 . && \
      GOOS=darwin  GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o /out/agent/rii_music-macos-amd64 . && \
      GOOS=linux   GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o /out/agent/rii_music-linux-amd64 . ; \
    fi

# ── 3. Runtime: ffmpeg + deno (JS runtime yt-dlp needs for YouTube) ──────
FROM debian:trixie-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates tzdata \
 && rm -rf /var/lib/apt/lists/*
COPY --from=denoland/deno:bin /deno /usr/local/bin/deno
COPY --from=server /out/rii_music /usr/local/bin/rii_music
COPY --from=server /out/agent /opt/rii_music/agent

RUN useradd --system --uid 10001 --home /data riimusic && mkdir -p /data && chown riimusic /data
USER riimusic
ENV DATA_DIR=/data PORT=8080 TRUST_PROXY=true AGENT_DIR=/opt/rii_music/agent TZ=Asia/Ho_Chi_Minh
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD ["/usr/local/bin/rii_music", "-healthcheck"]
CMD ["/usr/local/bin/rii_music"]
