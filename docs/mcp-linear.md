# Linear MCP setup

1. In Linear, open **Settings → Account → Security & Access** and create a Personal API key with only **Read** permission. Restrict it to the required teams when possible.
2. Save only the raw key in an owner-readable file outside `SLACK_AGENT_CWD`:

    ```sh
    chmod 600 /absolute/path/outside/workspace/linear-token
    ```

3. Save the MCP configuration in one of these locations:

    - `$SLACK_AGENT_CWD/.slack-desk-bot/mcp.json`
    - `~/.config/slack-desk-bot/mcp.json` as the global fallback
    - Another absolute path set through `SLACK_AGENT_MCP_CONFIG_FILE`, such as the service repository's gitignored `.slack-desk-bot/mcp.json`

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

The service repository already ignores `.slack-desk-bot/`. If you use the workspace path, add `$SLACK_AGENT_CWD/.slack-desk-bot/` to that workspace's ignore rules.

SlackDeskBot sends the API key as a bearer token and exposes only the listed tools from Linear's read-only endpoint. Validate the configuration, then restart the service:

```sh
task doctor
hum restart agent
```
