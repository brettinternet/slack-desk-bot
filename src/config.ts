import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { QueueLimits } from "./agent.ts";
import { loadMcpConfig, type McpConfig } from "./mcp-context.ts";

export type AgentMode = "read-only" | "read-write";
export type AgentCommandMode = "off" | "brokered";
export type AgentBackendKind = "pi" | "codex" | "claude";

export interface Config {
  slackBotToken: string;
  slackAppToken: string;
  workspace: string;
  allowedUserIds: Set<string>;
  operatorUserIds: Set<string>;
  agentBackend: AgentBackendKind;
  agentMode: AgentMode;
  agentCommandMode: AgentCommandMode;
  instructions?: string;
  codexExecutable?: string;
  codexHome?: string;
  claudeExecutable?: string;
  claudeHome?: string;
  mcp?: { path: string; config: McpConfig };
  queueLimits: QueueLimits;
  configuredMaxConcurrentConversations: number;
  sessionDir?: string;
  maxActiveSessions: number;
  sessionIdleMs: number;
  healthHost: string;
  healthPort: number;
  socketPath: string;
}

const DEFAULTS = {
  timeoutMs: 300_000,
  queueWaitMs: 600_000,
  maxQueuedPerConversation: 2,
  maxConcurrentConversations: 3,
  maxGlobalQueue: 20,
  maxPendingPerRequester: 3,
  rateLimitBurst: 3,
  rateLimitRefillMs: 60_000,
  maxActiveSessions: 32,
  sessionIdleMs: 3_600_000,
  healthHost: "127.0.0.1",
  healthPort: 3_210,
} as const;

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function optional(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  return environment[name]?.trim() || undefined;
}

function positiveInteger(environment: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const configured = environment[name]?.trim();
  if (!configured) return fallback;
  const value = Number(configured);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function port(environment: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = positiveInteger(environment, name, fallback);
  if (value > 65_535) throw new Error(`${name} must be a valid TCP port`);
  return value;
}

export function defaultSocketPath(environment: NodeJS.ProcessEnv = process.env): string {
  const base =
    process.platform === "darwin"
      ? join(homedir(), "Library", "Application Support", "SlackDeskBot")
      : environment.XDG_RUNTIME_DIR?.trim() || join(homedir(), ".local", "state", "slack-desk-bot");
  return join(base, "control.sock");
}

function loadInstructions(environment: NodeJS.ProcessEnv): string | undefined {
  const inline = optional(environment, "SLACK_AGENT_INSTRUCTIONS");
  const file = optional(environment, "SLACK_AGENT_INSTRUCTIONS_FILE");

  if (inline && file) {
    throw new Error("Set only one of SLACK_AGENT_INSTRUCTIONS or SLACK_AGENT_INSTRUCTIONS_FILE");
  }
  if (!file) return inline;
  if (!isAbsolute(file)) {
    throw new Error("SLACK_AGENT_INSTRUCTIONS_FILE must be an absolute path");
  }
  if (!statSync(file, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`SLACK_AGENT_INSTRUCTIONS_FILE is not a file: ${file}`);
  }

  const instructions = readFileSync(file, "utf8").trim();
  if (!instructions) throw new Error(`SLACK_AGENT_INSTRUCTIONS_FILE is empty: ${file}`);
  return instructions;
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): Config {
  const slackBotToken = required(environment, "SLACK_BOT_TOKEN");
  const slackAppToken = required(environment, "SLACK_APP_TOKEN");
  const configuredWorkspace = required(environment, "SLACK_AGENT_CWD");
  const workspace = resolve(configuredWorkspace);
  const allowedUserIds = new Set(
    required(environment, "SLACK_ALLOWED_USER_IDS")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  const operatorUserIds = new Set(
    (optional(environment, "SLACK_OPERATOR_USER_IDS") ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  const agentBackend = environment.SLACK_AGENT_BACKEND?.trim() || "pi";
  const agentMode = environment.SLACK_AGENT_MODE?.trim() || "read-only";
  const agentCommandMode = environment.SLACK_AGENT_COMMAND_MODE?.trim() || "off";
  const codexExecutable = optional(environment, "SLACK_CODEX_EXECUTABLE");
  const codexHome = optional(environment, "SLACK_CODEX_HOME");
  const claudeExecutable = optional(environment, "SLACK_CLAUDE_EXECUTABLE");
  const claudeHome = optional(environment, "SLACK_CLAUDE_HOME");
  const configuredSessionDir = environment.SLACK_AGENT_SESSION_DIR?.trim();
  const socketPath =
    optional(environment, "SLACK_AGENT_SOCKET_PATH") ?? defaultSocketPath(environment);

  if (allowedUserIds.size === 0) {
    throw new Error("SLACK_ALLOWED_USER_IDS must contain at least one user ID");
  }
  for (const operatorUserId of operatorUserIds) {
    if (!allowedUserIds.has(operatorUserId)) {
      throw new Error("SLACK_OPERATOR_USER_IDS must contain only allowed user IDs");
    }
  }
  if (agentBackend !== "pi" && agentBackend !== "codex" && agentBackend !== "claude") {
    throw new Error("SLACK_AGENT_BACKEND must be pi, codex, or claude");
  }
  if (agentMode !== "read-only" && agentMode !== "read-write") {
    throw new Error("SLACK_AGENT_MODE must be read-only or read-write");
  }
  if (agentCommandMode !== "off" && agentCommandMode !== "brokered") {
    throw new Error("SLACK_AGENT_COMMAND_MODE must be off or brokered");
  }
  if (agentCommandMode === "brokered" && agentBackend !== "pi") {
    throw new Error("SLACK_AGENT_COMMAND_MODE=brokered currently requires SLACK_AGENT_BACKEND=pi");
  }
  if (agentBackend === "codex" && agentMode !== "read-only") {
    throw new Error("The Codex backend currently supports only SLACK_AGENT_MODE=read-only");
  }
  if (!isAbsolute(configuredWorkspace)) {
    throw new Error("SLACK_AGENT_CWD must be an absolute path");
  }
  if (!statSync(workspace, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`SLACK_AGENT_CWD is not a directory: ${workspace}`);
  }
  if (configuredSessionDir && !isAbsolute(configuredSessionDir)) {
    throw new Error("SLACK_AGENT_SESSION_DIR must be an absolute path");
  }
  if (codexExecutable && !isAbsolute(codexExecutable)) {
    throw new Error("SLACK_CODEX_EXECUTABLE must be an absolute path");
  }
  if (codexHome && !isAbsolute(codexHome)) {
    throw new Error("SLACK_CODEX_HOME must be an absolute path");
  }
  if (claudeExecutable && !isAbsolute(claudeExecutable)) {
    throw new Error("SLACK_CLAUDE_EXECUTABLE must be an absolute path");
  }
  if (claudeHome && !isAbsolute(claudeHome)) {
    throw new Error("SLACK_CLAUDE_HOME must be an absolute path");
  }
  if (!isAbsolute(socketPath)) {
    throw new Error("SLACK_AGENT_SOCKET_PATH must be an absolute path");
  }

  const mcp = loadMcpConfig(workspace, optional(environment, "SLACK_AGENT_MCP_CONFIG_FILE"));
  if (mcp && agentBackend !== "pi") {
    throw new Error("MCP context tools currently require SLACK_AGENT_BACKEND=pi");
  }

  const configuredMaxConcurrentConversations = positiveInteger(
    environment,
    "SLACK_AGENT_MAX_CONCURRENT_CONVERSATIONS",
    DEFAULTS.maxConcurrentConversations,
  );

  return {
    slackBotToken,
    slackAppToken,
    workspace,
    allowedUserIds,
    operatorUserIds,
    agentBackend,
    agentMode,
    agentCommandMode,
    instructions: loadInstructions(environment),
    codexExecutable,
    codexHome: codexHome ? resolve(codexHome) : undefined,
    claudeExecutable,
    claudeHome: claudeHome ? resolve(claudeHome) : undefined,
    mcp,
    queueLimits: {
      timeoutMs: positiveInteger(environment, "SLACK_AGENT_TIMEOUT_MS", DEFAULTS.timeoutMs),
      queueWaitMs: positiveInteger(environment, "SLACK_AGENT_QUEUE_WAIT_MS", DEFAULTS.queueWaitMs),
      maxQueuedPerConversation: positiveInteger(
        environment,
        "SLACK_AGENT_MAX_QUEUE_PER_CONVERSATION",
        DEFAULTS.maxQueuedPerConversation,
      ),
      maxConcurrentConversations:
        agentMode === "read-write" ? 1 : configuredMaxConcurrentConversations,
      maxGlobalQueue: positiveInteger(
        environment,
        "SLACK_AGENT_MAX_GLOBAL_QUEUE",
        DEFAULTS.maxGlobalQueue,
      ),
      maxPendingPerRequester: positiveInteger(
        environment,
        "SLACK_AGENT_MAX_PENDING_PER_USER",
        DEFAULTS.maxPendingPerRequester,
      ),
      rateLimitBurst: positiveInteger(
        environment,
        "SLACK_AGENT_RATE_LIMIT_BURST",
        DEFAULTS.rateLimitBurst,
      ),
      rateLimitRefillMs: positiveInteger(
        environment,
        "SLACK_AGENT_RATE_LIMIT_REFILL_MS",
        DEFAULTS.rateLimitRefillMs,
      ),
    },
    configuredMaxConcurrentConversations,
    sessionDir: configuredSessionDir ? resolve(configuredSessionDir) : undefined,
    maxActiveSessions: positiveInteger(
      environment,
      "SLACK_AGENT_MAX_ACTIVE_SESSIONS",
      DEFAULTS.maxActiveSessions,
    ),
    sessionIdleMs: positiveInteger(
      environment,
      "SLACK_AGENT_SESSION_IDLE_MS",
      DEFAULTS.sessionIdleMs,
    ),
    healthHost: optional(environment, "SLACK_AGENT_HEALTH_HOST") ?? DEFAULTS.healthHost,
    healthPort: port(environment, "SLACK_AGENT_HEALTH_PORT", DEFAULTS.healthPort),
    socketPath: resolve(socketPath),
  };
}
