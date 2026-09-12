# SlackDeskBot

Your desktop coding agent, available in Slack. Slack transport and conversation routing depend on a small `AgentBackend` interface; the initial backend uses the Pi SDK.

## Behavior

- Responds to app mentions in channels and messages in the app's DM.
- Downloads supported Slack text and image attachments and passes them directly to Pi without writing them to disk.
- Keeps one persisted agent session per Slack channel thread and one per DM channel.
- Restores conversation history after service restarts.
- Serializes messages within a conversation while allowing separate conversations to run concurrently.
- Bounds runtime, queue depth, concurrent conversations, and per-user request volume.
- Cancels the active request when a user sends `cancel` in its DM or channel thread.
- Uses Pi's configured model, credentials, instructions, skills, and extensions.
- Allows `read`, `grep`, `find`, and `ls` by default; `edit` and `write` require explicit read-write mode. Shell execution is unavailable.
- Rejects tool paths outside `SLACK_AGENT_CWD`, including paths reached through existing symlinks.
- Splits long responses into Slack-safe messages.

Use `!status`, `!reset`, or `!cancel` as an exact message to inspect a conversation's session, start a fresh session while retaining its previous transcript, or stop its active request. Plain `cancel` also cancels an active request. In channels, mention the bot with the command as usual.

## Resource limits

The defaults allow three concurrent conversations, two queued requests per conversation, twenty queued requests globally, and three active or queued requests per user. Each user may submit a burst of three requests, replenishing at one request per minute. Agent runs time out after five minutes and queued requests expire after ten minutes.

Each message may include up to four supported files. Text files are limited to 1 MiB, images to 5 MiB, and all files in one message to 10 MiB. Supported text types are plain text, Markdown, JSON, and XML; supported image types are PNG, JPEG, GIF, and WebP. Downloads must come directly from Slack, are checked against their declared and actual size and content type, and are kept in memory rather than exposed as filesystem paths.

Live sessions are disposed after one idle hour and limited to 32 least-recently-used entries by default. Their persisted history is reopened on the next message. `SLACK_AGENT_SESSION_DIR` optionally selects an absolute storage directory.

The optional `SLACK_AGENT_*` settings in [`.env.example`](.env.example) override these limits. Cancellation and status requests bypass admission and rate limits.

## Slack setup

1. Optionally personalize the app by changing both `display_information.name` and `features.bot_user.display_name` in [`slack-app-manifest.yaml`](slack-app-manifest.yaml), for example to `Brett's Desktop Bot`.
2. Create a Slack app from the manifest.
3. Under **Basic Information → App-Level Tokens**, create a token with `connections:write`.
4. Install the app into the workspace. Reinstall existing apps so the manifest's `files:read` scope is granted.
5. Copy the bot token (`xoxb-…`) and app token (`xapp-…`).

The manifest defaults to `SlackDeskBot` and enables Socket Mode, so local development needs no public HTTP endpoint. The name applies to the Slack app installation, not separately to each workspace user. Only Slack user IDs configured in `SLACK_ALLOWED_USER_IDS` can invoke the app.

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

### Slack interaction instructions

Use one optional setting to give every Slack conversation the same bot identity, voice, and response style:

```dotenv
SLACK_AGENT_INSTRUCTIONS="Be concise, conversational, and avoid narrating tool use."
```

For longer instructions, keep them outside the target repository and configure an absolute path instead:

```dotenv
SLACK_AGENT_INSTRUCTIONS_FILE=/Users/you/.config/slack-desk-bot/instructions.md
```

Set only one of these settings. The file is read when the service starts, so restart after changing it. These instructions are added only to Pi sessions created by SlackDeskBot; the target repository's `AGENTS.md` continues to provide its normal project-specific instructions.

## Security

`SLACK_ALLOWED_USER_IDS` is a required comma-separated allowlist of Slack member IDs. Requests from all other users are rejected before Pi runs. Find a member ID in Slack from **Profile → More → Copy member ID**.

The agent starts in read-only mode. Set `SLACK_AGENT_MODE=read-write` to explicitly enable `edit` and `write` for allowlisted users. Use a dedicated checkout, review changes before committing, and do not point `SLACK_AGENT_CWD` at a directory containing unrelated or sensitive files.

The path policy limits Pi's selected filesystem tools, but locally installed Pi extensions run as trusted code. Only load extensions you trust on the service machine. Slack interaction instructions are sent to the configured model, so do not put secrets in them.

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
