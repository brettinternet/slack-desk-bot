import type { AgentBackend } from "./agent.ts";
import { ClaudeBackend, defaultClaudeHome } from "./claude-backend.ts";
import { CodexBackend, defaultCodexHome } from "./codex-backend.ts";
import type { AgentBackendKind, Config } from "./config.ts";
import { GitSlackIdentityResolver, loadSlackUsers } from "./git-slack-identities.ts";
import { defaultSessionDirectory, PiBackend } from "./pi-backend.ts";
import { McpContextProvider } from "./mcp-context.ts";

export interface BackendReadinessChecks {
  pi(workspace: string): Promise<string>;
  codex(config: Config): Promise<string>;
  claude(config: Config): Promise<string>;
  github(): Promise<string>;
}

interface BackendDefinition {
  label: string;
  storageSetting: string;
  hasConversationStore: boolean;
  create(config: Config): AgentBackend;
  checkReady(config: Config, checks: BackendReadinessChecks): Promise<string>;
  sessionHome(config: Config): string;
}

export const BACKENDS: Record<AgentBackendKind, BackendDefinition> = {
  pi: {
    label: "Pi",
    storageSetting: "SLACK_AGENT_SESSION_DIR",
    hasConversationStore: true,
    create: (config) =>
      new PiBackend(config.workspace, {
        mode: config.agentMode,
        commandMode: config.agentCommandMode,
        instructions: config.instructions,
        sessionDir: config.sessionDir,
        maxActiveSessions: config.maxActiveSessions,
        sessionIdleMs: config.sessionIdleMs,
        brokeredToolsOptions: {
          identityResolver: new GitSlackIdentityResolver(() =>
            loadSlackUsers(config.slackBotToken),
          ),
        },
        mcpProvider: config.mcp ? new McpContextProvider(config.mcp.config) : undefined,
        automationKinds: [
          ...(config.mcp?.config.servers.linear?.allowedTools.get_issue
            ? ["linear-issue" as const]
            : []),
          ...(config.github ? ["github-pr" as const, "github-issue" as const] : []),
        ],
      }),
    checkReady: async (config, checks) => {
      const model = await checks.pi(config.workspace);
      const github = config.github ? `; ${await checks.github()}` : "";
      if (!config.mcp) return model + github;
      const catalog = await new McpContextProvider(config.mcp.config).catalog();
      return `${model}${github}; ${catalog.length} allowed MCP context tool${catalog.length === 1 ? "" : "s"} available`;
    },
    sessionHome: (config) => config.sessionDir ?? defaultSessionDirectory(config.workspace),
  },
  codex: {
    label: "Codex",
    storageSetting: "SLACK_CODEX_HOME",
    hasConversationStore: true,
    create: (config) =>
      new CodexBackend(config.workspace, {
        executable: config.codexExecutable,
        home: config.codexHome,
        instructions: config.instructions,
      }),
    checkReady: (config, checks) => checks.codex(config),
    sessionHome: (config) => config.codexHome ?? defaultCodexHome(config.workspace),
  },
  claude: {
    label: "Claude",
    storageSetting: "SLACK_CLAUDE_HOME",
    hasConversationStore: true,
    create: (config) =>
      new ClaudeBackend(config.workspace, {
        executable: config.claudeExecutable,
        home: config.claudeHome,
        instructions: config.instructions,
        mode: config.agentMode,
      }),
    checkReady: (config, checks) => checks.claude(config),
    sessionHome: (config) => config.claudeHome ?? defaultClaudeHome(config.workspace),
  },
};
