# slack-agent

Run coding agents from Slack. Slack transport and conversation routing depend on a small `AgentBackend` interface; the initial backend uses the Pi SDK.

## Behavior

- Responds to app mentions in channels and messages in the app's DM.
- Keeps one agent session per Slack channel thread and one per DM channel.
- Serializes messages within a conversation while allowing separate conversations to run concurrently.
- Bounds runtime, queue depth, concurrent conversations, and per-user request volume.
- Cancels the active request when a user sends `cancel` in its DM or channel thread.
- Uses Pi's configured model, credentials, instructions, skills, and extensions.
- Allows `read`, `grep`, `find`, and `ls` by default; `edit` and `write` require explicit read-write mode. Shell execution is unavailable.
- Rejects tool paths outside `SLACK_AGENT_CWD`, including paths reached through existing symlinks.
- Splits long responses into Slack-safe messages.

Sessions are kept in memory, evicted after an idle timeout, and reset when the service restarts.

## Resource limits

The defaults allow three concurrent conversations, two queued requests per conversation, twenty queued requests globally, and three active or queued requests per user. Each user may submit a burst of three requests, replenishing at one request per minute. Agent runs time out after five minutes and queued requests expire after ten minutes.

The optional `SLACK_AGENT_*` settings in [`.env.example`](.env.example) override these limits. Cancellation requests bypass admission and rate limits.

## Slack setup

1. Create a Slack app from [`slack-app-manifest.yaml`](slack-app-manifest.yaml).
2. Under **Basic Information → App-Level Tokens**, create a token with `connections:write`.
3. Install the app into the workspace.
4. Copy the bot token (`xoxb-…`) and app token (`xapp-…`).

The manifest enables Socket Mode, so local development needs no public HTTP endpoint. Only Slack user IDs configured in `SLACK_ALLOWED_USER_IDS` can invoke the app.

## Local setup

Pi uses the model authentication already configured on the machine. If needed, authenticate in Pi first:

```sh
pi
# Run /login in Pi
```

Then install the project tools, configure the service, and start it under Hum:

```sh
task init
cp .env.example .env
# Fill in tokens, an absolute SLACK_AGENT_CWD path, and allowed Slack user IDs.
hum up
```

`hum status`, `hum logs agent`, and `hum down` inspect and control the service. Bun loads `.env` automatically. The machine must remain awake and connected to Slack.

## Security

`SLACK_ALLOWED_USER_IDS` is a required comma-separated allowlist of Slack member IDs. Requests from all other users are rejected before Pi runs. Find a member ID in Slack from **Profile → More → Copy member ID**.

The agent starts in read-only mode. Set `SLACK_AGENT_MODE=read-write` to explicitly enable `edit` and `write` for allowlisted users. Use a dedicated checkout, review changes before committing, and do not point `SLACK_AGENT_CWD` at a directory containing unrelated or sensitive files.

The path policy limits Pi's selected filesystem tools, but locally installed Pi extensions run as trusted code. Only load extensions you trust on the service machine.

## Adding another agent

Implement `AgentBackend` from [`src/agent.ts`](src/agent.ts), then select that implementation in [`src/index.ts`](src/index.ts). Slack handlers do not depend on Pi-specific session types or events.

Keep adapters narrow: translate a conversation ID and prompt into one text response. Backend-specific process management, sessions, and credentials belong inside the adapter.

## Development

The toolchain is declared in [`mise.toml`](mise.toml). `task init` installs Mise-managed tools, Bun dependencies, and Git hooks.

```sh
task check
task test
task fix
```

Hum exposes project processes to supported coding agents through [`.mcp.json`](.mcp.json).
