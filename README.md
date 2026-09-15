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
4. Install the app into the workspace. Reinstall existing apps to grant the manifest scopes and event subscriptions.
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

**Pi (default):** `SLACK_AGENT_BACKEND=pi`.

- Reads model settings, `models.json`, and `auth.json` from the Pi agent directory reported by `task doctor`.
- Does not load that directory's extensions, skills, or prompt templates.
- Tools are restricted to the `SLACK_AGENT_MODE` and `SLACK_AGENT_COMMAND_MODE` allowlist, enforced again at call time.
- Authenticate with desktop Pi as usual. No credential copy is required.

**Codex:**

```sh
mise use -g codex@latest
mkdir -p "$HOME/Library/Application Support/SlackDeskBot/codex"
CODEX_HOME="$HOME/Library/Application Support/SlackDeskBot/codex" codex login
```

```dotenv
SLACK_AGENT_BACKEND=codex
SLACK_AGENT_MODE=read-only
SLACK_CODEX_HOME=/Users/you/Library/Application Support/SlackDeskBot/codex
# Optional when codex is not on the LaunchAgent PATH:
SLACK_CODEX_EXECUTABLE=/absolute/path/to/codex
```

Requires macOS, an authenticated `SLACK_CODEX_HOME`, and the Seatbelt process sandbox. Read-write mode is intentionally unsupported. Thread mappings and transcripts under `SLACK_CODEX_HOME` survive restarts, so Slack and `slack-desk attach` resume the exact thread.

**Claude:**

```sh
mkdir -p "$HOME/Library/Application Support/SlackDeskBot/claude"
CLAUDE_CONFIG_DIR="$HOME/Library/Application Support/SlackDeskBot/claude" claude auth login
```

Set `SLACK_AGENT_BACKEND=claude` and optionally `SLACK_CLAUDE_HOME` or `SLACK_CLAUDE_EXECUTABLE`.

| Mode       | Tools                                                  |
| ---------- | ------------------------------------------------------ |
| read-only  | `Read`, `Glob`, `Grep`                                 |
| read-write | adds `Edit`, `Write`; keeps global single-writer limit |

Claude requires macOS Seatbelt. It runs via `claude -p` with `stream-json`, a dedicated `CLAUDE_CONFIG_DIR`, inherited settings ignored, and no permission prompts.

- Bash, WebFetch, WebSearch, shell/code tools, out-of-workspace paths, and credential-like paths are denied by Claude policy and Seatbelt.
- Text attachments are inlined; images are rejected.
- Session IDs persist only after a successful response. Subsequent turns resume that session.

Run `task doctor` after switching backends.

## Slack interaction

Mention the bot in a channel to start a conversation. In that thread, follow-up questions and requests do not need another mention, including after restarts; answers to the bot's questions are also inferred while the service remains running. General observations, acknowledgements, explicit no-reply notes, and messages addressed to another user are ignored. Prefix a short or ambiguous request with `laptop:` to address the bot without an @mention. DMs work without a mention. Only `SLACK_ALLOWED_USER_IDS` can invoke the app. After a successful response, the bot has a 20% chance of reacting with a random custom workspace emoji.

When the service returns after being offline, it reconciles eligible DMs, mentions, and requests in existing bot threads from the previous 24 hours. Catch-up runs in the background, processes at most 10 messages, and bounds history reads to 25 conversations, prioritizing DMs and existing threads. A durable checkpoint beside the local control socket prevents duplicate agent calls; restarts within five minutes share a cooldown before another history scan. The first launch after installing this behavior establishes the checkpoint without replying to older messages.

| Command              | Effect                                                |
| -------------------- | ----------------------------------------------------- |
| `!help`              | Show usage examples and all commands                  |
| `!status`            | Model, context, cumulative cost, messages (live only) |
| `!reset`             | Fresh session (previous transcript retained)          |
| `!cancel` / `cancel` | Cancel active request (own, or any if operator)       |

Commands are case-insensitive exact messages. An unsupported `!`-prefixed message points back to `!help`.

## Local terminal attachment

SlackDeskBot remains the sole owner of mutable agent sessions. A local client joins over an owner-only Unix socket:

```sh
bun link                 # once, from this checkout
slack-desk sessions
slack-desk attach f82ab719
slack-desk attach f82ab719 --history 50  # default: 20; --no-history to disable
```

`slack-desk sessions` shows conversation labels and participants when Slack metadata is available. Attaching prints thread/DM identity, participants, permalink, and recent history, then switches to live events.

Scopes `channels:read`, `groups:read`, `im:read`, `users:read`, and `users:read.email` are required; reinstall an existing app after adding them. History and automatic Git identity matching fall back gracefully when Slack denies access.

Inside an attachment use prompts normally, or `/status`, `/cancel`, `/quit`. Slack and local prompts share the same per-conversation queue. Local operator prompts and replies post back to the originating Slack thread with attribution; disconnecting does not stop the session or an active request.

On macOS, the socket defaults to `~/Library/Application Support/SlackDeskBot/control.sock`. Override with `SLACK_AGENT_SOCKET_PATH` (absolute); the client reads the same variable or takes `--socket <path>`.

The protocol is versioned newline-delimited JSON, local-only. It bounds frames, clients, pending requests, subscriptions, and buffered output. Session state and bounded Slack metadata/history are exposed only to the local operator.

### Custom instructions

```dotenv
SLACK_AGENT_INSTRUCTIONS="Be concise, conversational, and avoid narrating tool use."
# Or use a file (set only one):
# SLACK_AGENT_INSTRUCTIONS_FILE=/absolute/path/to/instructions.md
```

Restart after changes. These apply only to SlackDeskBot sessions; the target repository's `AGENTS.md` still provides project instructions.

| Backend | Mechanism                 |
| ------- | ------------------------- |
| Pi      | Appended to system prompt |
| Claude  | `--append-system-prompt`  |
| Codex   | `developer_instructions`  |

`task doctor` reports when an older CLI lacks the required option and SlackDeskBot must prefix instructions to each prompt instead.

### Brokered inspection commands

For the Pi backend, opt into fixed read-only command brokers without enabling a shell:

```dotenv
SLACK_AGENT_COMMAND_MODE=brokered
```

**`git_inspect`** reports status, branches, tags, bounded logs and diffs, historical contents, blame, commit search/details, release notes, branch divergence, contributors and file ownership, activity and streaks, code/file age, largest files, change coupling, hotspots, bus-factor estimates, repository health, tracked-file statistics, and Git-author-to-Slack identity matches.

Git identities use `.mailmap`-canonicalized author emails. Exact workspace-email matches are automatic; names are never fuzzy-matched. Explicit aliases can be stored globally or in a local, gitignored project file:

```sh
slack-desk identities scan
slack-desk identities list
slack-desk identities link U012ABCDEF brett@users.noreply.github.com
slack-desk identities link U012ABCDEF brett@company.com --global
```

Project mappings are written to `.slack-desk/identities.yaml`; global mappings use `~/.config/slack-desk/identities.yaml`. Project mappings take precedence. `scan` requires `SLACK_BOT_TOKEN` and the `users:read.email` scope. The `contributors`, `identities`, and `bus_factor` Git inspection actions include resolved Slack names and stable user IDs without exposing workspace email addresses.

- `SLACK_AGENT_CWD` is the outer access boundary: a single repo root or a parent of multiple repos.
- In nested layouts, `git_inspect` resolves a workspace-relative repo root and uses paths relative to it.
- Other file tools stay relative to `SLACK_AGENT_CWD`, reaching files across allowed projects without changing directories.
- Repository selection rejects traversal, symlink escapes, non-root subdirectories, and paths outside `SLACK_AGENT_CWD`.
- Sensitive paths (`.env`, `.git`, credentials, private keys) are rejected or omitted.
- Git runs as `/usr/bin/git` with exact arguments, no pager, hooks, lazy fetching, optional locks, global/system config, credential prompts, or inherited service environment. It cannot contact remotes or mutate the repository.

**`repo_fun`** derives playful local-only reports from Git metadata: repository personality and birthday, ancient artifacts, hot zones, team constellations, commit weather, deterministic fortunes, activity sparklines, milestones, and trivia. Interpret personality, weather, ownership, and concentration results as approximate.

**`system_info`** reports battery and battery health, uptime/load, OS/kernel/CPU/runtime/tool versions, workspace disk and volume space, memory and thermal pressure, power settings, redacted connected-display summaries, computer name, local clock, combined system pressure, and SlackDeskBot process health. Each action uses in-process facts or a fixed executable with fixed arguments; no shell or free-form arguments are accepted. Hardware serials and private scheduled activity returned by macOS are never included in tool output.

Brokered commands are off by default, currently Pi-only, and independent of `SLACK_AGENT_MODE` (read-only and read-write sessions receive the same inspection-only operations).

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

Files are downloaded from Slack into memory only and never written to disk. Pi accepts all listed text and image types. Codex and Claude inline text attachments but reject images (their CLIs require an image file path).

See [`.env.example`](.env.example) for all tunable `SLACK_AGENT_*` settings.

## Readiness and health

| Endpoint   | Purpose                                                                                                                                                            |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/healthz` | Liveness. OK during Slack reconnects.                                                                                                                              |
| `/readyz`  | `ready` when Slack connected and backend available; `degraded` during reconnects or repeated delivery failures; `unhealthy` when disconnected or backend disposed. |

```sh
curl -fsS "http://127.0.0.1:${SLACK_AGENT_HEALTH_PORT:-3210}/readyz"
```

Response includes start/uptime, queue counts, connection state, and last successful Slack operation time. No prompts, IDs, paths, tokens, or file data.

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

Session data is the only data requiring backup. Stop the service first.

| Backend | Session location          |
| ------- | ------------------------- |
| Pi      | `SLACK_AGENT_SESSION_DIR` |
| Codex   | `SLACK_CODEX_HOME`        |
| Claude  | `SLACK_CLAUDE_HOME`       |

```sh
tar -C "$HOME/Library/Application Support/SlackDeskBot" -czf "slackdeskbot-sessions-$(date +%Y%m%d).tgz" sessions
```

Restore: stop the service, move existing sessions aside, extract the archive, verify permissions, run `task doctor`, then `task service:install`. Never merge two session directories or run two instances against one.

**Offline resume** is recovery-only. Stop SlackDeskBot first. Concurrent access outside the service does not join the in-memory queue and can fork history.

| Backend | Offline resume command                                             |
| ------- | ------------------------------------------------------------------ |
| Pi      | `pi --session <file>` (use a copy or exclusively owned session)    |
| Codex   | `CODEX_HOME=<configured-home> codex resume <thread-id>`            |
| Claude  | `CLAUDE_CONFIG_DIR=<configured-home> claude --resume <session-id>` |

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
5. `slack-desk sessions`, attach, then alternate one Slack turn and one terminal turn. Confirm both replies use the same backend session and Slack thread without another process opening the session.

## Security

**Allowlist:** `SLACK_ALLOWED_USER_IDS` (required) controls invocation. `SLACK_OPERATOR_USER_IDS` (optional subset) can cancel any active request. Rejected users get one reply per conversation every ten minutes. Find member IDs from **Profile → More → Copy member ID**.

**Read-only by default.** `read`, `grep`, `find`, `ls` are allowed. Set `SLACK_AGENT_MODE=read-write` to enable `edit` and `write` (enforces one active conversation). Brokered commands are separately controlled by `SLACK_AGENT_COMMAND_MODE` and never add a shell or mutation capability.

**Path policy** blocks `.env` files (except templates), `.ssh`, `.git` contents, private keys, cloud credentials, `.netrc`, `.npmrc`, `.pypirc`. It applies in both modes, follows symlinks, and normalizes `~`, `@`, and `file://` paths.

This is path-based only, not secret detection. Use a dedicated checkout without secrets.

**Tool paths** are confined to `SLACK_AGENT_CWD`. Pi allows only the selected file and brokered tools and blocks sensitive paths.

The target repository's `.pi/` directory cannot inject extensions, settings, or system prompts. User-level Pi extensions (`~/.pi/agent`) run as trusted code outside this policy.

### Backend-specific sandboxing

**Codex** uses two sandboxes:

- Its native sandbox is read-only.
- SlackDeskBot's macOS Seatbelt boundary exposes file contents only from the workspace, Codex install root, and dedicated session home. Writes are limited to that session home.
- Path metadata remains readable because the CLIs canonicalize their executable, home, and workspace at startup.
- Commands receive no service environment.
- Credentials live in an owner-only `auth.json` under `SLACK_CODEX_HOME`. The Codex process can read it; model-issued commands cannot.

**Claude** runs with:

- inherited project and user settings ignored;
- no MCP servers, slash commands, or permission prompts;
- an explicit file-tool list;
- the same Seatbelt boundary as Codex, plus required writes to `/tmp/claude-<uid>` and `/tmp/cc-socks`;
- workspace writes only in read-write mode.

| Capability                      | Codex | Claude |
| ------------------------------- | ----- | ------ |
| Read-write mode                 | No    | Yes    |
| Image attachments               | No    | No     |
| Linux service deployment        | No    | No     |
| MCP/connectors                  | No    | No     |
| Unrestricted command networking | No    | No     |

Claude also denies Bash, shell/code tools, WebFetch, and WebSearch.

### Sessions

Sessions are designed for one service owner; SlackDeskBot is their sole mutable owner.

The socket has no TCP fallback and does not expose session paths, prompts, tokens, user names, or file contents in discovery or logs. It is created `0600` inside a `0700` owner-only directory.

Neither Node nor Bun exposes Unix peer credentials, so any process running as the service user can connect and is treated as the operator. Do not share session files across instances without external locking.

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
