# SlackDeskBot

Your desktop coding agent, available in Slack. Slack transport and conversation routing depend on a small `AgentBackend` interface; the initial backend uses the Pi SDK.

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

1. Optionally personalize the app by changing both `display_information.name` and `features.bot_user.display_name` in [`slack-app-manifest.yaml`](slack-app-manifest.yaml), for example to `Brett's Desktop Bot`.
2. Create a Slack app from the manifest.
3. Under **Basic Information → App-Level Tokens**, create a token with `connections:write`.
4. Install the app into the workspace.
5. Copy the bot token (`xoxb-…`) and app token (`xapp-…`).

The manifest defaults to `SlackDeskBot` and enables Socket Mode, so local development needs no public HTTP endpoint. The name applies to the Slack app installation, not separately to each workspace user. Any workspace member who can mention or DM the installed app can invoke it.

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

Every workspace member can request edits in the configured repository under the permissions of the local service account. Use a dedicated checkout, review changes before committing, and do not point `SLACK_AGENT_CWD` at a directory containing unrelated or sensitive files.

The path policy limits Pi's selected filesystem tools, but locally installed Pi extensions run as trusted code. Only load extensions you trust on the service machine. Slack interaction instructions are sent to the configured model, so do not put secrets in them.

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
