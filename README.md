# SlackDeskBot

A desktop coding agent available in Slack. Slack transport and conversation routing depend on a small `AgentBackend` interface; the default backend uses the Pi SDK.

## Platform

Single-user macOS desktop running under LaunchAgent and Hum. Requires macOS, Git, and [Mise](https://mise.jdx.dev/getting-started.html). Linux works for development and CI but has no service recipe.

## Quick start

```sh
git clone https://github.com/brettinternet/slack-desk-bot.git
cd slack-desk-bot
mise install
mise exec task -- task init
```

### Slack app

1. Optionally rename the app in [`slack-app-manifest.yaml`](slack-app-manifest.yaml).
2. Create a Slack app from the manifest.
3. Under **Basic Information → App-Level Tokens**, create a token with `connections:write`.
4. Install the app into the workspace. Reinstall existing apps so the manifest scopes and event subscriptions are granted.
5. Copy the bot token (`xoxb-…`) and app token (`xapp-…`).

Socket Mode is enabled, so no public endpoint is needed.

### Configure and run

Authenticate Pi if needed (`pi`, then `/login` and select a model), then:

```sh
cp .env.example .env
# Fill in tokens, absolute SLACK_AGENT_CWD, and allowed Slack user IDs.
task doctor    # validates settings, tokens, paths, ports, Slack auth, Pi readiness
hum up
```

`hum status`, `hum logs agent`, and `hum down` inspect and control the service.

## Slack interaction

Mention the bot in a channel to start a conversation. Further replies in that thread do not need a mention, including after restarts. DMs work without a mention. Only user IDs in `SLACK_ALLOWED_USER_IDS` can invoke the app.

| Command              | Effect                                                               |
| -------------------- | -------------------------------------------------------------------- |
| `!help`              | Show usage examples and all commands                                 |
| `!status`            | Model, context usage, cumulative cost, message count (live sessions) |
| `!reset`             | Fresh session, previous transcript retained                          |
| `!cancel` / `cancel` | Cancel active request (own, or any if operator)                      |

Commands are case-insensitive exact messages. An unsupported `!`-prefixed message points back to `!help`.

### Custom instructions

```dotenv
SLACK_AGENT_INSTRUCTIONS="Be concise, conversational, and avoid narrating tool use."
# Or use a file (set only one):
# SLACK_AGENT_INSTRUCTIONS_FILE=/absolute/path/to/instructions.md
```

Restart after changes. These apply only to SlackDeskBot sessions; the target repository's `AGENTS.md` still provides project instructions.

## Resource limits

| Limit                                 | Default               |
| ------------------------------------- | --------------------- |
| Concurrent conversations (read-only)  | 3                     |
| Concurrent conversations (read-write) | 1 (enforced)          |
| Queued per conversation               | 2                     |
| Global queue                          | 20                    |
| Active/queued per user                | 3                     |
| Rate limit                            | 3 burst, 1/min refill |
| Agent timeout                         | 5 min                 |
| Queue wait                            | 10 min                |
| Max response messages                 | 3 (10,500 chars)      |

### File attachments

| Constraint        | Limit                           |
| ----------------- | ------------------------------- |
| Files per message | 4                               |
| Text file size    | 1 MiB                           |
| Image file size   | 5 MiB                           |
| Total per message | 10 MiB                          |
| Text types        | plain text, Markdown, JSON, XML |
| Image types       | PNG, JPEG, GIF, WebP            |

Files are downloaded from Slack into memory only and are never written to disk.

See [`.env.example`](.env.example) for all tunable `SLACK_AGENT_*` settings.

## Readiness and health

| Endpoint   | Purpose                                                                                                                                                                        |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/healthz` | Liveness. OK during Slack reconnects.                                                                                                                                          |
| `/readyz`  | `ready` when Slack is connected and backend is available; `degraded` during reconnects or after repeated delivery failures; `unhealthy` when disconnected or backend disposed. |

```sh
curl -fsS "http://127.0.0.1:${SLACK_AGENT_HEALTH_PORT:-3210}/readyz"
```

Response contains start/uptime, queue counts, connection state, and last successful Slack operation time. No prompts, IDs, paths, tokens, or file data.

## macOS deployment

```sh
# External secrets and durable sessions
mkdir -p "$HOME/.config/slack-desk-bot" "$HOME/Library/Application Support/SlackDeskBot/sessions"
cp .env.example "$HOME/.config/slack-desk-bot/service.env"
chmod 600 "$HOME/.config/slack-desk-bot/service.env"
# Edit service.env: tokens, allowed users, SLACK_AGENT_CWD, SLACK_AGENT_SESSION_DIR

# Verify
set -a; source "$HOME/.config/slack-desk-bot/service.env"; set +a
task doctor

# Install LaunchAgent and start
task service:install
```

Operate:

```sh
hum status
hum logs agent
hum restart agent
launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.slackdeskbot.agent.plist"
hum down
```

### Backup and restore

Sessions are the only data requiring backup. Stop the service first.

```sh
tar -C "$HOME/Library/Application Support/SlackDeskBot" -czf "slackdeskbot-sessions-$(date +%Y%m%d).tgz" sessions
```

Restore: stop, move existing sessions aside, extract the archive, verify permissions, run `task doctor`, then `task service:install`. Never merge two session directories or run two instances against one.

### Upgrade and rollback

```sh
# Stop, back up sessions, then:
git pull --ff-only
mise install
bun install --frozen-lockfile
task check && task test
# Load service.env, then:
task doctor
task service:install
```

Rollback: unload LaunchAgent, check out the previous tag/commit, rerun the install and verify steps.

### Smoke checklist

1. Bootstrap, Slack setup, external `service.env`, durable session directory.
2. `task doctor` passes.
3. `task service:install`, then `hum status` reports ready and `/readyz` returns 200.
4. Send `!help` in a DM, then send a prompt and confirm a reply.

## Security

**Allowlist:** `SLACK_ALLOWED_USER_IDS` (required) controls who can invoke the app. `SLACK_OPERATOR_USER_IDS` (optional subset) can cancel any active request. Rejected users get one reply per conversation every ten minutes. Find member IDs from **Profile → More → Copy member ID**.

**Read-only by default.** `read`, `grep`, `find`, `ls` are allowed. Set `SLACK_AGENT_MODE=read-write` to enable `edit` and `write`. Read-write mode enforces one active conversation to protect the shared checkout.

**Path policy** blocks `.env` files (except templates), `.ssh`, `.git` contents, private keys, cloud credentials, `.netrc`, `.npmrc`, `.pypirc`. Applies in both modes, follows symlinks, normalizes `~`, `@`, and `file://` paths. This is path-based only, not secret detection. Use a dedicated checkout without secrets.

**Tool paths** are confined to `SLACK_AGENT_CWD`. The target repository is treated as an untrusted Pi project: its `.pi/` directory cannot inject extensions, settings, or system prompts. User-level Pi extensions (`~/.pi/agent`) run as trusted code outside this policy.

**Sessions** are JSONL files designed for one process. Do not share across instances without external locking.

## Adding another backend

Implement `AgentBackend` from [`src/agent.ts`](src/agent.ts) and select it in [`src/index.ts`](src/index.ts). Keep adapters narrow: translate a conversation ID and prompt into one text response.

## Development

Toolchain is declared in [`mise.toml`](mise.toml). `task init` installs tools, dependencies, and hooks.

```sh
task check    # types + formatting
task test     # tests
task fix      # auto-format
```

Hum exposes project processes to coding agents through [`.mcp.json`](.mcp.json).
