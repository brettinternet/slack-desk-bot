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
task doctor    # validates settings, tokens, paths, ports, Slack auth, and backend readiness
hum up
```

`hum status`, `hum logs agent`, and `hum down` inspect and control the service.

### Agent backend

`SLACK_AGENT_BACKEND=pi` is the default. To use Codex CLI instead:

```sh
mise use -g codex@latest
mkdir -p "$HOME/Library/Application Support/SlackDeskBot/codex"
CODEX_HOME="$HOME/Library/Application Support/SlackDeskBot/codex" codex login
```

Then set:

```dotenv
SLACK_AGENT_BACKEND=codex
SLACK_AGENT_MODE=read-only
SLACK_CODEX_HOME=/Users/you/Library/Application Support/SlackDeskBot/codex
# Optional when codex is not on the LaunchAgent PATH:
SLACK_CODEX_EXECUTABLE=/absolute/path/to/codex
```

Run `task doctor` after switching. Codex mode requires macOS, an authenticated `SLACK_CODEX_HOME`, and the Seatbelt process sandbox. Read-write mode is intentionally unsupported. Codex thread mappings and transcripts are retained below `SLACK_CODEX_HOME`, so Slack and `slack-desk attach` resume the exact thread after a service restart.

To use Claude Code instead:

```sh
mkdir -p "$HOME/Library/Application Support/SlackDeskBot/claude"
CLAUDE_CONFIG_DIR="$HOME/Library/Application Support/SlackDeskBot/claude" claude auth login
```

Set `SLACK_AGENT_BACKEND=claude` and optionally `SLACK_CLAUDE_HOME` or `SLACK_CLAUDE_EXECUTABLE`, then run `task doctor`. Claude requires macOS Seatbelt and uses `claude -p` with `stream-json`, a dedicated `CLAUDE_CONFIG_DIR`, ignored inherited settings, and no permission prompts. Read-only mode enables only `Read`, `Glob`, and `Grep`; read-write also enables `Edit` and `Write` and keeps the global single-writer queue limit. Bash, WebFetch, WebSearch, shell/code tools, out-of-workspace paths, and credential-like paths are denied by both Claude policy and the independent Seatbelt profile. Text attachments are inlined; image attachments are rejected without writing files. Session IDs are persisted only after a successful response, and subsequent turns resume that exact Claude session.

## Slack interaction

Mention the bot in a channel to start a conversation. Further replies in that thread do not need a mention, including after restarts. DMs work without a mention. Only user IDs in `SLACK_ALLOWED_USER_IDS` can invoke the app.

| Command              | Effect                                                               |
| -------------------- | -------------------------------------------------------------------- |
| `!help`              | Show usage examples and all commands                                 |
| `!status`            | Model, context usage, cumulative cost, message count (live sessions) |
| `!reset`             | Fresh session, previous transcript retained                          |
| `!cancel` / `cancel` | Cancel active request (own, or any if operator)                      |

Commands are case-insensitive exact messages. An unsupported `!`-prefixed message points back to `!help`.

## Local terminal attachment

SlackDeskBot remains the sole owner of mutable agent sessions. A local client joins the running service over an owner-only Unix socket instead of opening Pi's JSONL file:

```sh
bun link                 # once, from this checkout
slack-desk sessions
slack-desk attach f82ab719
```

Inside an attachment, enter prompts normally or use `/status`, `/cancel`, and `/quit`. Slack and local prompts use the same per-conversation queue. Local operator prompts and replies are posted back to the originating Slack thread with attribution; disconnecting the terminal does not stop the session or an active request.

The socket defaults to `~/Library/Application Support/SlackDeskBot/control.sock` on macOS. Override it for both service and client with an absolute `SLACK_AGENT_SOCKET_PATH`. The versioned newline-delimited JSON control protocol is local-only, bounds frames, clients, pending requests, subscriptions, and buffered output, and exposes only session ID, canonical conversation ID, state, and last-active time during discovery.

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

Files are downloaded from Slack into memory only and are never written to disk. Pi accepts the listed text and image types. Codex and Claude inline text attachments but return a capability error for images because their CLIs require an image file path.

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

Session data is the only data requiring backup. Stop the service first. Pi uses `SLACK_AGENT_SESSION_DIR`; Codex uses `SLACK_CODEX_HOME`; Claude uses `SLACK_CLAUDE_HOME`.

```sh
tar -C "$HOME/Library/Application Support/SlackDeskBot" -czf "slackdeskbot-sessions-$(date +%Y%m%d).tgz" sessions
```

Restore: stop, move existing sessions aside, extract the archive, verify permissions, run `task doctor`, then `task service:install`. Never merge two session directories or run two instances against one.

Offline resume is recovery-only: stop SlackDeskBot first. For Pi, open a copied or exclusively owned session with `pi --session <file>`. Never run `pi --session` against a live SlackDeskBot session. For Codex, use `CODEX_HOME=<configured-home> codex resume <thread-id>` only while SlackDeskBot is stopped. For Claude, use `CLAUDE_CONFIG_DIR=<configured-home> claude --resume <session-id>` only while SlackDeskBot is stopped. Concurrent access does not attach to the service's in-memory queue and can fork history.

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
5. Run `slack-desk sessions`, attach to that session, and alternate one Slack turn and one terminal turn. Confirm both replies appear in the same backend session/thread and Slack thread without another process opening the session.

## Security

**Allowlist:** `SLACK_ALLOWED_USER_IDS` (required) controls who can invoke the app. `SLACK_OPERATOR_USER_IDS` (optional subset) can cancel any active request. Rejected users get one reply per conversation every ten minutes. Find member IDs from **Profile → More → Copy member ID**.

**Read-only by default.** `read`, `grep`, `find`, `ls` are allowed. Set `SLACK_AGENT_MODE=read-write` to enable `edit` and `write`. Read-write mode enforces one active conversation to protect the shared checkout.

**Path policy** blocks `.env` files (except templates), `.ssh`, `.git` contents, private keys, cloud credentials, `.netrc`, `.npmrc`, `.pypirc`. Applies in both modes, follows symlinks, normalizes `~`, `@`, and `file://` paths. This is path-based only, not secret detection. Use a dedicated checkout without secrets.

**Tool paths** are confined to `SLACK_AGENT_CWD`. With Pi, a backend policy allows only the selected file tools and blocks sensitive paths. The target repository is treated as an untrusted Pi project: its `.pi/` directory cannot inject extensions, settings, or system prompts. User-level Pi extensions (`~/.pi/agent`) run as trusted code outside this policy.

**Codex security differs from Pi.** Codex receives a read-only native sandbox and also runs inside a SlackDeskBot-owned macOS Seatbelt boundary. The boundary denies _file contents_ under other user, temporary, and mounted-volume paths, allowing only the workspace, the Codex executable's install root, and its dedicated session home. Writes are confined to that session home. Path metadata stays readable because both CLIs canonicalize their own executable, home, and workspace during startup; denying it prevents them from launching at all. Codex commands inherit no service environment. Credentials live in an owner-only `auth.json` inside `SLACK_CODEX_HOME`; the Codex process can read it, while Codex's own read-only sandbox prevents model-issued commands from reading anything outside the workspace, including that file. Read-write mode, image attachments, Linux service deployment, MCP/connectors, and unrestricted command networking are not supported by this adapter.

**Claude security differs from Pi and Codex.** Claude runs in restricted mode with inherited project and user settings ignored, no MCP servers or slash commands, no permission prompts, and an explicit file-tool list. Read-only mode exposes `Read`, `Glob`, and `Grep`; read-write also exposes `Edit` and `Write` and retains the global single-writer limit. The same Seatbelt boundary used for Codex confines file contents and writes, additionally allowing writes to Claude's fixed `/tmp/claude-<uid>` and `/tmp/cc-socks` runtime directories, which the CLI requires to start. Read-write mode adds workspace writes only. Bash and other code-running tools, WebFetch, WebSearch, image attachments, Linux service deployment, and unrestricted command networking are not supported.

**Sessions** are designed for one service owner. The service is their sole mutable owner. The local socket is owner-only, has no TCP fallback, and does not expose session file paths, prompts, tokens, user names, or file contents in discovery or logs. Do not share session files across instances without external locking.

## Adding another backend

Implement `AgentBackend` from [`src/agent.ts`](src/agent.ts) and select it in [`src/application.ts`](src/application.ts). Keep adapters narrow: translate a conversation ID and prompt into one text response.

## Development

Toolchain is declared in [`mise.toml`](mise.toml). `task init` installs tools, dependencies, and hooks.

```sh
task check    # types + formatting
task test     # tests
task fix      # auto-format
```

Hum exposes project processes to coding agents through [`.mcp.json`](.mcp.json).
