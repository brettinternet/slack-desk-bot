import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { QueueLimits } from "./agent.ts";

export type AgentMode = "read-only" | "read-write";

export interface Config {
  slackBotToken: string;
  slackAppToken: string;
  workspace: string;
  allowedUserIds: Set<string>;
  agentMode: AgentMode;
  instructions?: string;
  queueLimits: QueueLimits;
  sessionDir?: string;
  maxActiveSessions: number;
  sessionIdleMs: number;
  healthPort: number;
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
  const agentMode = environment.SLACK_AGENT_MODE?.trim() || "read-only";
  const configuredSessionDir = environment.SLACK_AGENT_SESSION_DIR?.trim();

  if (allowedUserIds.size === 0) {
    throw new Error("SLACK_ALLOWED_USER_IDS must contain at least one user ID");
  }
  if (agentMode !== "read-only" && agentMode !== "read-write") {
    throw new Error("SLACK_AGENT_MODE must be read-only or read-write");
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

  return {
    slackBotToken,
    slackAppToken,
    workspace,
    allowedUserIds,
    agentMode,
    instructions: loadInstructions(environment),
    queueLimits: {
      timeoutMs: positiveInteger(environment, "SLACK_AGENT_TIMEOUT_MS", DEFAULTS.timeoutMs),
      queueWaitMs: positiveInteger(environment, "SLACK_AGENT_QUEUE_WAIT_MS", DEFAULTS.queueWaitMs),
      maxQueuedPerConversation: positiveInteger(
        environment,
        "SLACK_AGENT_MAX_QUEUE_PER_CONVERSATION",
        DEFAULTS.maxQueuedPerConversation,
      ),
      maxConcurrentConversations: positiveInteger(
        environment,
        "SLACK_AGENT_MAX_CONCURRENT_CONVERSATIONS",
        DEFAULTS.maxConcurrentConversations,
      ),
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
    healthPort: port(environment, "SLACK_AGENT_HEALTH_PORT", DEFAULTS.healthPort),
  };
}
