# slack-agent

Run coding agents from Slack. Slack transport and conversation routing depend on a small `AgentBackend` interface; the initial backend uses the Pi SDK.

## Behavior

- Responds to app mentions in channels and messages in the app's DM.
- Keeps one persisted agent session per Slack channel thread and one per DM channel.
- Restores conversation history after service restarts.
- Serializes messages within a conversation while allowing separate conversations to run concurrently.
- Uses Pi's configured model, credentials, instructions, skills, and extensions.
- Allows `read`, `grep`, `find`, `ls`, `edit`, and `write`; shell execution is unavailable.
- Rejects tool paths outside `SLACK_AGENT_CWD`, including paths reached through existing symlinks.
- Splits long responses into Slack-safe messages.

Use `!status`, `!reset`, or `!cancel` as an exact message to inspect a conversation's session, start a fresh session while retaining its previous transcript, or stop its active request. In channels, mention the bot with the command as usual.

Live sessions are disposed after 30 idle minutes and limited to 32 least-recently-used entries by default. Their persisted history is reopened on the next message. Configure these limits with `SLACK_AGENT_SESSION_IDLE_MINUTES` and `SLACK_AGENT_MAX_ACTIVE_SESSIONS`; `SLACK_AGENT_SESSION_DIR` optionally selects an absolute storage directory.

## Slack setup

1. Create a Slack app from [`slack-app-manifest.yaml`](slack-app-manifest.yaml).
2. Under **Basic Information → App-Level Tokens**, create a token with `connections:write`.
3. Install the app into the workspace.
4. Copy the bot token (`xoxb-…`) and app token (`xapp-…`).

The manifest enables Socket Mode, so local development needs no public HTTP endpoint. Any workspace member who can mention or DM the installed app can invoke it.

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
# Fill in tokens and an absolute SLACK_AGENT_CWD path.
hum up
```

`hum status`, `hum logs agent`, and `hum down` inspect and control the service. Bun loads `.env` automatically. The machine must remain awake and connected to Slack.

## Security

Every workspace member can request edits in the configured repository under the permissions of the local service account. Use a dedicated checkout, review changes before committing, and do not point `SLACK_AGENT_CWD` at a directory containing unrelated or sensitive files.

The path policy limits Pi's selected filesystem tools, but locally installed Pi extensions run as trusted code. Only load extensions you trust on the service machine.

Session JSONL files are designed for one service process. Running multiple instances against the same session directory requires conversation affinity and external locking.

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
