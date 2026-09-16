# Linear MCP setup

1. In Linear, open **Settings → Account → Security & Access** and create a Personal API key with only **Read** permission. Restrict it to the required teams when possible.
2. Save only the raw key in an owner-readable file outside `SLACK_AGENT_CWD`:

    ```sh
    chmod 600 /absolute/path/outside/workspace/linear-token
    ```

3. Create `$SLACK_AGENT_CWD/.slack-desk-bot/mcp.json`, or `~/.config/slack-desk-bot/mcp.json` as the global fallback. If the configuration instead lives in the service repository's gitignored `.slack-desk-bot/` directory, set `SLACK_AGENT_MCP_CONFIG_FILE` to its absolute path:

    ```json
    {
        "version": 1,
        "servers": {
            "linear": {
                "transport": "streamable-http",
                "url": "https://mcp.linear.app/mcp/readonly",
                "tokenFile": "/absolute/path/outside/workspace/linear-token",
                "allowedTools": {
                    "list_issues": { "localName": "linear_list_issues" },
                    "get_issue": { "localName": "linear_get_issue" },
                    "list_projects": { "localName": "linear_list_projects" }
                }
            }
        }
    }
    ```

The service repository's `.slack-desk-bot/` directory is gitignored. If you use the default workspace path, ensure `$SLACK_AGENT_CWD/.slack-desk-bot/` is also ignored by that workspace. SlackDeskBot sends the API key as a bearer token and exposes only the listed tools from Linear's read-only endpoint.

Run `task doctor`, then restart SlackDeskBot.
