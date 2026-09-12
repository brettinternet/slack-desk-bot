# slack-agent

Run coding agents from Slack. Slack transport and conversation routing depend on a small `AgentBackend` interface; the initial backend uses the Pi SDK.

## Behavior

- Responds to app mentions in channels and messages in the app's DM.
- Keeps one agent session per Slack channel thread and one per DM channel.
- Serializes messages within a conversation while allowing separate conversations to run concurrently.
- Uses Pi's configured model, credentials, instructions, skills, and extensions.
- Allows `read`, `grep`, `find`, `ls`, `edit`, and `write`; shell execution is unavailable.
- Rejects tool paths outside `SLACK_AGENT_CWD`, including paths reached through existing symlinks.
- Splits long responses into Slack-safe messages.

Sessions are currently in memory and reset when the service restarts.

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

Then configure and start the service:

```sh
bun install
cp .env.example .env
# Fill in tokens and an absolute SLACK_AGENT_CWD path.
bun start
```

Bun loads `.env` automatically. The machine must remain awake and connected to Slack.

## Security

Every workspace member can request edits in the configured repository under the permissions of the local service account. Use a dedicated checkout, review changes before committing, and do not point `SLACK_AGENT_CWD` at a directory containing unrelated or sensitive files.

The path policy limits Pi's selected filesystem tools, but locally installed Pi extensions run as trusted code. Only load extensions you trust on the service machine.

## Adding another agent

Implement `AgentBackend` from [`src/agent.ts`](src/agent.ts), then select that implementation in [`src/index.ts`](src/index.ts). Slack handlers do not depend on Pi-specific session types or events.

Keep adapters narrow: translate a conversation ID and prompt into one text response. Backend-specific process management, sessions, and credentials belong inside the adapter.

## Development

```sh
bun run check
bun test
```
