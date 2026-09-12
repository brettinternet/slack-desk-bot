# SlackDeskBot

Your desktop coding agent, available in Slack. Slack transport and conversation routing depend on a small `AgentBackend` interface; the initial backend uses the Pi SDK.

## Supported platform and prerequisites

The supported always-on deployment is a single-user macOS desktop running SlackDeskBot under LaunchAgent and Hum. A clean machine needs macOS, Git, and [Mise](https://mise.jdx.dev/getting-started.html); Mise installs the pinned Bun, Task, Hum, TypeScript, formatting, and check toolchain declared by this repository. A Slack workspace administrator must also allow installing an app from a manifest. Linux remains supported for development and CI, but no Linux service recipe is maintained.

Bootstrap a clean checkout:

```sh
git clone https://github.com/brettinternet/slack-desk-bot.git
cd slack-desk-bot
mise install
mise exec task -- task init
```

## Behavior

- Responds to app mentions in channels, mention-free follow-ups in bot-owned channel threads, and messages in the app's DM.
- Downloads supported Slack text and image attachments and passes them directly to Pi without writing them to disk.
- Keeps one persisted agent session per Slack channel thread and one per DM channel.
- Restores conversation history after service restarts.
- Serializes messages within a conversation. Read-only mode allows separate conversations to run concurrently; read-write mode runs only one conversation at a time to protect the shared checkout.
- Bounds runtime, queue depth, concurrent conversations, and per-user request volume.
- Cancels the active request when a user sends `cancel` in its DM or channel thread.
- Uses Pi's configured model, credentials, instructions, skills, and extensions.
- Allows `read`, `grep`, `find`, and `ls` by default; `edit` and `write` require explicit read-write mode. Shell execution is unavailable.
- Rejects tool paths outside `SLACK_AGENT_CWD` and documented sensitive paths inside it, including paths reached through existing symlinks, `~`, and `file://` forms.
- Treats `SLACK_AGENT_CWD` as an untrusted Pi project: its `.pi/` settings, extensions, skills, prompts, and system prompt files are never loaded.
- Publishes at most three Slack-safe messages (10,500 characters total) per agent response and marks truncated output.
- Emits prompt-free JSON request logs with request, user, conversation, duration, tool count, execution outcome, and Slack delivery outcome fields.

Use `!help` to see Slack examples and all supported commands. `!status`, `!reset`, and `!cancel` inspect a conversation's session, start a fresh session while retaining its previous transcript, or stop its active request. Plain `cancel` also cancels an active request. Commands are case-insensitive exact messages; an unsupported message beginning with `!` points back to `!help` instead of invoking the agent. In a channel, an allowlisted user must mention the bot to start a conversation. Further allowlisted human replies in that thread do not need a mention. Thread ownership is intentionally kept in memory rather than inferred from persisted agent sessions, so after a service restart mention the bot once in the thread before continuing. Root channel messages and replies in unrelated threads are ignored.

## Resource limits

The defaults allow three concurrent conversations in read-only mode, two queued requests per conversation, twenty queued requests globally, and three active or queued requests per user. Read-write mode always limits active conversations to one, regardless of `SLACK_AGENT_MAX_CONCURRENT_CONVERSATIONS`, so two agents cannot edit the shared checkout concurrently. Startup logs report when this safety limit overrides the configured value. Each user may submit a burst of three requests, replenishing at one request per minute. Requester admission happens before file downloads and status messages, and at most eight Slack responses may be in flight; excess event deliveries are dropped with one warning per overload period. Agent runs time out after five minutes and queued requests expire after ten minutes. Slack shows `Queued…` until execution starts, then `Working…`; long runs update at most every 30 seconds with elapsed time and aggregate tool use. Slack reports queue, user, rate, runtime, and queue-wait limits with a specific recovery action. Unexpected failures show only a request ID; give that ID to the operator, who can correlate it with sanitized logs without exposing backend details in Slack. Response publication is limited to three messages; truncated output tells the user to request a narrower response. Rate-limited message posts and updates honor Slack's retry delay once before delivery is reported as failed. Logs separately report agent execution and Slack delivery as successful, partial, or failed.

Each message may include up to four supported files. Text files are limited to 1 MiB, images to 5 MiB, and all files in one message to 10 MiB. Supported text types are plain text, Markdown, JSON, and XML; supported image types are PNG, JPEG, GIF, and WebP. Downloads must come directly from Slack, are checked against their declared and actual size and content type, and are kept in memory rather than exposed as filesystem paths.

Live sessions are disposed after one idle hour and limited to 32 least-recently-used entries by default. Their persisted history is reopened on the next message. `SLACK_AGENT_SESSION_DIR` optionally selects an absolute storage directory.

The optional `SLACK_AGENT_*` settings in [`.env.example`](.env.example) override these limits. Cancellation and status requests bypass admission and rate limits.

## Slack setup

1. Optionally personalize the app by changing both `display_information.name` and `features.bot_user.display_name` in [`slack-app-manifest.yaml`](slack-app-manifest.yaml), for example to `Brett's Desktop Bot`.
2. Create a Slack app from the manifest.
3. Under **Basic Information → App-Level Tokens**, create a token with `connections:write`.
4. Install the app into the workspace. Reinstall existing apps so the manifest's `files:read`, `channels:history`, and `groups:history` scopes and channel-message event subscriptions are granted.
5. Copy the bot token (`xoxb-…`) and app token (`xapp-…`).

The manifest defaults to `SlackDeskBot` and enables Socket Mode, so local development needs no public HTTP endpoint. The name applies to the Slack app installation, not separately to each workspace user. Only Slack user IDs configured in `SLACK_ALLOWED_USER_IDS` can invoke the app.

## Local setup

Complete the bootstrap above. Pi uses the model authentication already configured on the machine. If needed, authenticate and select a model first:

```sh
pi
# Run /login in Pi, then select a model.
```

Configure and verify the service before starting it under Hum:

```sh
cp .env.example .env
# Fill in tokens, an absolute SLACK_AGENT_CWD path, and allowed Slack user IDs.
task doctor
hum up
```

`task doctor` is non-destructive: it validates required settings and token formats, workspace and session paths, health-port availability, Slack `auth.test`, and local Pi/model authentication without starting Socket Mode, creating a Pi session, or sending an agent prompt. It prints pass/fail diagnostics and exits nonzero for blocking failures. Run it after setup or configuration changes while the service is stopped so its health port is available.

`hum status`, `hum logs agent`, and `hum down` inspect and control the service. Hum verifies request readiness through `http://127.0.0.1:3210/readyz` instead of matching process output; set `SLACK_AGENT_HEALTH_PORT` to change the port. `/healthz` is cheap process liveness and remains OK while Slack reconnects; `/readyz` is `ready` only when Slack is connected and the backend is available, `degraded` during reconnects or after three consecutive result-delivery failures, and `unhealthy` when Slack is disconnected or the backend is disposed. The readiness response contains only sanitized start/uptime, queue counts and limits, connection state, and the last successful Slack operation time—never prompts, IDs, paths, tokens, or file data.

In readiness diagnostics, `active` is the number of running conversations, `queued` is waiting work, `max_concurrent` and `max_queued` are their global limits, and `saturated` means the global waiting queue is full. Queue load is diagnostic and does not by itself change readiness.

First troubleshooting command:

```sh
curl -fsS "http://127.0.0.1:${SLACK_AGENT_HEALTH_PORT:-3210}/readyz"
```

Bun loads `.env` automatically. The machine must remain awake and connected to Slack.

## Supported macOS deployment

Keep the checkout at a stable path. Store service secrets outside the checkout and make Pi sessions durable:

```sh
mkdir -p "$HOME/.config/slack-desk-bot" "$HOME/Library/Application Support/SlackDeskBot/sessions"
cp .env.example "$HOME/.config/slack-desk-bot/service.env"
chmod 600 "$HOME/.config/slack-desk-bot/service.env"
```

Edit `service.env`: set the Slack tokens, allowed users, and absolute workspace path, and set `SLACK_AGENT_SESSION_DIR` to the absolute `.../Library/Application Support/SlackDeskBot/sessions` path created above. Do not commit this file or copy it into the target repository. Verify it while the service is stopped:

```sh
set -a
source "$HOME/.config/slack-desk-bot/service.env"
set +a
task doctor
```

From the SlackDeskBot checkout, `task service:install` writes a mode-`0600` LaunchAgent to `~/Library/LaunchAgents/com.slackdeskbot.agent.plist`, loads it, and starts Hum. LaunchAgent starts it at login, while Hum applies `restart: on-failure` and waits for `/readyz`. The plist stores only paths; it sources the external environment file at startup.

Operate the installed service from its checkout:

```sh
hum status                    # process and readiness
hum logs agent                # retained application output
hum restart agent             # graceful process restart
launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.slackdeskbot.agent.plist"
hum down                      # full shutdown after unloading LaunchAgent
```

Run `task service:install` again to load or restart it. Hum retains at most 4 MiB of output per process and 20 completed records by default; application logs are prompt-free and credential-free, but should still be treated as operator data. macOS may additionally retain LaunchAgent diagnostics according to its system log policy.

### Backup and restore

Sessions are the only application data requiring backup; the checkout and pinned dependencies are reproducible, and secrets should be backed up through the operator's password manager rather than copied with sessions. Stop the service, then archive the configured session directory:

```sh
tar -C "$HOME/Library/Application Support/SlackDeskBot" -czf "slackdeskbot-sessions-$(date +%Y%m%d).tgz" sessions
```

To restore, stop the service, move the existing session directory aside, extract a trusted archive into the same parent directory, verify ownership and write permissions, run the environment-loaded `task doctor`, then run `task service:install`. Never merge two live session directories or run two service instances against one directory.

### Upgrade and rollback

Stop the service, back up sessions, and upgrade only from a reviewed tag or commit:

```sh
git pull --ff-only
mise install
bun install --frozen-lockfile
task check
task test
# Load service.env as shown above, then:
task doctor
task service:install
```

For rollback, unload the LaunchAgent, check out the previously recorded tag or commit, rerun `mise install` and `bun install --frozen-lockfile`, then run the same doctor and install steps. The pinned `mise.toml` and `bun.lock` keep local development and CI on the same toolchain; update those pins intentionally in one reviewed change.

### Fresh-install smoke checklist

1. Complete the clean-machine bootstrap and Slack setup.
2. Create the external `service.env` and durable session directory.
3. Load `service.env` and confirm `task doctor` passes.
4. Run `task service:install`, then confirm `hum status` reports ready and `/readyz` returns HTTP 200 with `"status":"ready"`.
5. Send the app a Slack DM containing `!help`, then send an ordinary prompt and confirm a successful reply.

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

`SLACK_ALLOWED_USER_IDS` is a required comma-separated allowlist of Slack member IDs. Requests from all other users are rejected before Pi runs; the rejection reply is sent at most once per user and conversation every ten minutes so repeated messages cannot generate Slack API traffic. The app receives public and private channel message events so it can accept natural follow-ups, but it ignores channel roots and threads that an allowlisted mention has not claimed during the current service process. Find a member ID in Slack from **Profile → More → Copy member ID**.

The agent starts in read-only mode. Set `SLACK_AGENT_MODE=read-write` to explicitly enable `edit` and `write` for allowlisted users. Read-write mode processes only one conversation at a time because every conversation shares `SLACK_AGENT_CWD`; queued conversations resume when the active run settles. Use a dedicated checkout, review changes before committing, and do not point `SLACK_AGENT_CWD` at a directory containing unrelated or sensitive files.

The path policy blocks direct access by Pi's selected filesystem tools to `.env` files (except `.env.example`, `.env.sample`, and `.env.template`), `.ssh` and `.git` contents, common private-key extensions and names, `.aws/credentials`, Google application-default credentials, Docker's `config.json`, `.netrc`, `.npmrc`, and `.pypirc`. The same rules apply in read-only and read-write modes, follow symlink targets, and normalize `~`, `@`-prefixed, and `file://` paths the same way Pi's tools do. This is a narrow path-based safeguard, not secret detection: ordinary readable source files and model output can still disclose sensitive content, so use a dedicated checkout without secrets.

Pi extensions installed at the user level (`~/.pi/agent`) run as trusted code outside this path policy. Only load extensions you trust on the service machine. The target repository itself is treated as an untrusted Pi project, so a `.pi/` directory inside `SLACK_AGENT_CWD` cannot inject extensions, settings, or system prompts into the service; its `AGENTS.md` context files are still read as ordinary project instructions. Slack interaction instructions are sent to the configured model, so do not put secrets in them.

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
