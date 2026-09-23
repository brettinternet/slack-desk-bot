# syntax=docker/dockerfile:1.7

FROM oven/bun:1.4.2-slim AS dependencies
WORKDIR /app
COPY package.json bun.lock ./
COPY patches ./patches
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.4.2-slim AS runtime
ARG VCS_REF="unknown"
ARG VERSION="dev"
LABEL org.opencontainers.image.title="SlackDeskBot" \
      org.opencontainers.image.description="A Slack interface for a constrained Pi coding agent" \
      org.opencontainers.image.source="https://github.com/brettinternet/slack-desk-bot" \
      org.opencontainers.image.revision="$VCS_REF" \
      org.opencontainers.image.version="$VERSION"

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update \
    && apt-get install --no-install-recommends --yes ca-certificates git gh \
    && apt-get clean \
    && mkdir -p /config/pi-agent /var/lib/slack-desk/sessions /workspace \
    && chown -R bun:bun /config/pi-agent /var/lib/slack-desk /workspace

WORKDIR /app
COPY --from=dependencies --chown=bun:bun /app/node_modules ./node_modules
COPY --chown=bun:bun package.json bun.lock ./
COPY --chown=bun:bun patches ./patches
COPY --chown=bun:bun src ./src

ENV NODE_ENV=production \
    HOME=/home/bun \
    PI_CODING_AGENT_DIR=/config/pi-agent \
    SLACK_AGENT_BACKEND=pi \
    SLACK_AGENT_CWD=/workspace \
    SLACK_AGENT_HEALTH_HOST=0.0.0.0 \
    SLACK_AGENT_HEALTH_PORT=3210 \
    SLACK_AGENT_SESSION_DIR=/var/lib/slack-desk/sessions \
    SLACK_AGENT_SOCKET_PATH=/var/lib/slack-desk/control.sock

RUN bun -e "await import('./src/index.ts')"

USER bun
EXPOSE 3210
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=3s --start-period=30s --retries=3 \
  CMD ["bun", "src/healthcheck.ts"]
CMD ["bun", "src/index.ts"]
