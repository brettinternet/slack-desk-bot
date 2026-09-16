# Linear MCP setup

1. In Linear, open **Settings → Account → Security & Access** and create a Personal API key with only **Read** permission. Restrict it to the required teams when possible.
2. Save only the raw key in an owner-readable file outside `SLACK_AGENT_CWD`:

    ```sh
    chmod 600 /absolute/path/outside/workspace/linear-token
    ```

3. Create `.slack-desk-bot/mcp.json` in one repository, or `~/.config/slack-desk-bot/mcp.json` as the global fallback:

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

The project `.slack-desk-bot/` directory is gitignored. SlackDeskBot sends the API key as a bearer token and exposes only the listed tools from Linear's read-only endpoint.

Run `task doctor`, then restart SlackDeskBot.
