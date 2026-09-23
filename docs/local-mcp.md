# Local agent MCP setup

Install the stable launcher once from the SlackDeskBot checkout:

```sh
task mcp:install
```

It writes `~/.local/bin/slack-desk-mcp`, an owner-managed executable that runs this checkout's `src/mcp-server.ts` with the Bun version selected by the checkout's mise configuration. Re-run after moving the checkout or mise executable. It will not replace an unmanaged file at that path. The launcher does not start SlackDeskBot; the service must be running to use its tools.

Register this **stdio MCP server** in each agent's user-level MCP configuration (the configuration syntax varies by client):

```json
{
    "mcpServers": {
        "slack-desk": { "command": "/path/to/home/.local/bin/slack-desk-mcp" }
    }
}
```

Replace `/path/to/home` with your absolute home directory. Use the absolute launcher path: GUI-started agents may not inherit your shell's `PATH`. If the service uses a non-default socket, supply `SLACK_AGENT_SOCKET_PATH` in that agent's MCP server environment. No `bun link` or shell startup file is needed. See [README.md](../README.md#mcp-for-local-agents) for tool behavior and permissions.
