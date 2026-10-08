# Linear MCP setup

1. In Linear, go to **Settings → Account → Security & Access** and create a Personal API key with **Read** permission only, limited to the teams you need.
2. Save the raw key outside `SLACK_AGENT_CWD`:

    ```sh
    chmod 600 /abs/outside/workspace/linear-token
    ```

3. Write `mcp.json` to `SLACK_AGENT_MCP_CONFIG_FILE`, `$SLACK_AGENT_CWD/.slack-desk-bot/mcp.json` (gitignore it), or `~/.config/slack-desk-bot/mcp.json`:

    ```json
    {
        "version": 1,
        "servers": {
            "linear": {
                "transport": "streamable-http",
                "url": "https://mcp.linear.app/mcp/readonly",
                "tokenFile": "/abs/outside/workspace/linear-token",
                "allowedTools": {
                    "list_issues": { "localName": "linear_list_issues" },
                    "get_issue": { "localName": "linear_get_issue" },
                    "list_projects": { "localName": "linear_list_projects" }
                }
            }
        }
    }
    ```

4. Validate and restart:

    ```sh
    task doctor
    hum restart agent
    ```

The key is sent as a bearer token, and only the listed tools are exposed. `get_issue` also enables Linear watches.
