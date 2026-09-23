import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_MCP_CONFIG_RELATIVE_PATH,
  loadMcpConfig,
  McpContextProvider,
  mcpSchemaSha256,
} from "../src/mcp-context.ts";

function fixture() {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "slack-desk-mcp-test-"));
  const workspace = join(root, "workspace");
  const secrets = join(root, "secrets");
  mkdirSync(join(workspace, ".slack-desk-bot"), { recursive: true });
  mkdirSync(secrets);
  const tokenFile = join(secrets, "token");
  writeFileSync(tokenFile, "test-token\n", { mode: 0o600 });
  chmodSync(tokenFile, 0o600);
  return {
    root,
    workspace,
    tokenFile,
    configPath: join(workspace, DEFAULT_MCP_CONFIG_RELATIVE_PATH),
    globalConfigPath: join(root, "global", "mcp.json"),
  };
}

function config(tokenFile: string) {
  return {
    version: 1,
    servers: {
      linear: {
        transport: "streamable-http",
        url: "https://mcp.linear.app/mcp/readonly",
        tokenFile,
        allowedTools: {
          search_issues: { localName: "linear_search" },
        },
      },
    },
  };
}

describe("MCP configuration", () => {
  test("loads the ignored workspace location with exact allowed tools", () => {
    const paths = fixture();
    writeFileSync(paths.configPath, JSON.stringify(config(paths.tokenFile)));

    const loaded = loadMcpConfig(paths.workspace, undefined, paths.globalConfigPath);

    expect(loaded?.path).toBe(realpathSync(paths.configPath));
    expect(loaded?.config.servers.linear).toEqual({
      url: "https://mcp.linear.app/mcp/readonly",
      tokenFile: realpathSync(paths.tokenFile),
      allowedTools: {
        search_issues: { localName: "linear_search" },
      },
    });
  });

  test("uses the global configuration when the project has none", () => {
    const paths = fixture();
    mkdirSync(join(paths.root, "global"), { recursive: true });
    writeFileSync(paths.globalConfigPath, JSON.stringify(config(paths.tokenFile)));

    const loaded = loadMcpConfig(paths.workspace, undefined, paths.globalConfigPath);

    expect(loaded?.path).toBe(realpathSync(paths.globalConfigPath));
  });

  test("is optional by default and rejects executable transports and workspace tokens", () => {
    const paths = fixture();
    expect(loadMcpConfig(paths.workspace, undefined, paths.globalConfigPath)).toBeUndefined();

    writeFileSync(
      paths.configPath,
      JSON.stringify({
        ...config(paths.tokenFile),
        servers: {
          linear: { ...config(paths.tokenFile).servers.linear, transport: "stdio" },
        },
      }),
    );
    expect(() => loadMcpConfig(paths.workspace, undefined, paths.globalConfigPath)).toThrow(
      "only streamable-http",
    );

    const workspaceToken = join(paths.workspace, "token");
    writeFileSync(workspaceToken, "secret", { mode: 0o600 });
    writeFileSync(paths.configPath, JSON.stringify(config(workspaceToken)));
    expect(() => loadMcpConfig(paths.workspace, undefined, paths.globalConfigPath)).toThrow(
      "outside SLACK_AGENT_CWD",
    );

    const customConfig = join(paths.workspace, "mcp-config.json");
    writeFileSync(customConfig, JSON.stringify(config(paths.tokenFile)));
    expect(() => loadMcpConfig(paths.workspace, customConfig)).toThrow("outside SLACK_AGENT_CWD");
  });

  test("rejects non-loopback plaintext endpoints and duplicate local names", () => {
    const paths = fixture();
    const value = config(paths.tokenFile);
    value.servers.linear.url = "http://example.com/mcp";
    writeFileSync(paths.configPath, JSON.stringify(value));
    expect(() => loadMcpConfig(paths.workspace, undefined, paths.globalConfigPath)).toThrow(
      "must use HTTPS",
    );

    writeFileSync(
      paths.configPath,
      JSON.stringify({
        version: 1,
        servers: {
          service: {
            url: "http://127.0.0.1:4312/mcp",
            allowedTools: {
              first: { localName: "same_name" },
              second: { localName: "same_name" },
            },
          },
        },
      }),
    );
    expect(() => loadMcpConfig(paths.workspace, undefined, paths.globalConfigPath)).toThrow(
      "Duplicate local MCP tool name",
    );
  });
});

describe("MCP context provider", () => {
  test("discovers only configured tools and closes discovery and call connections", async () => {
    const schema = {
      type: "object" as const,
      properties: { query: { type: "string" } },
      required: ["query"],
    };
    const closed: string[] = [];
    const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    let connectionNumber = 0;
    const provider = new McpContextProvider(
      {
        version: 1,
        servers: {
          linear: {
            url: "https://mcp.linear.app/mcp/readonly",
            allowedTools: {
              search_issues: {
                localName: "linear_search",
                schemaSha256: mcpSchemaSha256(schema),
              },
            },
          },
        },
      },
      {
        connect: async () => {
          const id = String(++connectionNumber);
          return {
            listTools: async () => ({
              tools: [
                { name: "search_issues", description: "Search issues", inputSchema: schema },
                {
                  name: "create_issue",
                  description: "Create an issue",
                  inputSchema: { type: "object" as const },
                },
              ],
            }),
            callTool: async (params) => {
              calls.push(params);
              return { content: [{ type: "text", text: "Issue ENG-123" }] };
            },
            close: async () => {
              closed.push(id);
            },
          };
        },
      },
    );

    const catalog = await provider.catalog();
    expect(
      catalog.map(({ localName, remoteName, description }) => ({
        localName,
        remoteName,
        description,
      })),
    ).toEqual([
      {
        localName: "linear_search",
        remoteName: "search_issues",
        description:
          "Read-only context from the configured linear MCP service. Call search_issues.",
      },
    ]);
    expect(closed).toEqual(["1"]);

    await expect(provider.call("linear", "search_issues", { query: "timeout" })).resolves.toBe(
      "Issue ENG-123",
    );
    expect(calls).toEqual([{ name: "search_issues", arguments: { query: "timeout" } }]);
    expect(closed).toEqual(["1", "2"]);
    await expect(provider.call("linear", "create_issue", {})).rejects.toThrow("not allowed");
  });

  test("returns bounded full JSON to trusted service code without exposing it to the agent", async () => {
    const body = JSON.stringify({ id: "ENG-123", description: "x".repeat(60_000) });
    const provider = new McpContextProvider(
      {
        version: 1,
        servers: {
          linear: {
            url: "https://mcp.linear.app/mcp/readonly",
            allowedTools: { get_issue: { localName: "linear_get_issue" } },
          },
        },
      },
      {
        connect: async () => ({
          listTools: async () => ({ tools: [] }),
          callTool: async () => ({ content: [{ type: "text", text: body }] }),
          close: async () => {},
        }),
      },
    );
    expect(
      (
        (await provider.callJson("linear", "get_issue", { id: "ENG-123" })) as {
          description: string;
        }
      ).description.length,
    ).toBe(60_000);
    expect(await provider.call("linear", "get_issue", { id: "ENG-123" })).toContain(
      "Output truncated",
    );
  });

  test("fails closed for destructive or changed allowed tools", async () => {
    const schema = { type: "object" as const };
    const makeProvider = (destructiveHint: boolean, schemaSha256?: string) =>
      new McpContextProvider(
        {
          version: 1,
          servers: {
            service: {
              url: "https://example.com/mcp",
              allowedTools: { lookup: { localName: "service_lookup", schemaSha256 } },
            },
          },
        },
        {
          connect: async () => ({
            listTools: async () => ({
              tools: [
                {
                  name: "lookup",
                  inputSchema: schema,
                  annotations: { destructiveHint },
                },
              ],
            }),
            callTool: async () => ({ content: [] }),
            close: async () => {},
          }),
        },
      );

    await expect(makeProvider(true).catalog()).rejects.toThrow("marked destructive");
    await expect(makeProvider(false, "0".repeat(64)).catalog()).rejects.toThrow("schema changed");
  });
});
