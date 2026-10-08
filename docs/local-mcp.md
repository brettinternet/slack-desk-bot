# Local agent MCP setup

```sh
task mcp:install   # writes ~/.local/bin/slack-desk-mcp
```

The launcher runs this checkout's `src/mcp-server.ts` with its mise-selected Bun. Re-run it if you move the checkout or mise. It won't overwrite a file it didn't create, and it doesn't start the service.

Register it as a stdio server in each agent's user-level MCP config:

```json
{ "mcpServers": { "slack-desk": { "command": "/Users/you/.local/bin/slack-desk-mcp" } } }
```

Use the absolute path, since GUI agents may not inherit your `PATH`. For a non-default socket, set `SLACK_AGENT_SOCKET_PATH` in the server's `env`. Tool behavior is described in the [README](../README.md#mcp-server-for-local-agents).
