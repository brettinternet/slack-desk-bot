import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { QueueLimits } from "./agent.ts";

export interface Config {
  slackBotToken: string;
  slackAppToken: string;
  workspace: string;
  queueLimits: QueueLimits;
  sessionIdleMs: number;
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
  sessionIdleMs: 3_600_000,
} as const;

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
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

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): Config {
  const slackBotToken = required(environment, "SLACK_BOT_TOKEN");
  const slackAppToken = required(environment, "SLACK_APP_TOKEN");
  const configuredWorkspace = required(environment, "SLACK_AGENT_CWD");
  const workspace = resolve(configuredWorkspace);

  if (!isAbsolute(configuredWorkspace)) {
    throw new Error("SLACK_AGENT_CWD must be an absolute path");
  }
  if (!statSync(workspace, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`SLACK_AGENT_CWD is not a directory: ${workspace}`);
  }

  return {
    slackBotToken,
    slackAppToken,
    workspace,
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
    sessionIdleMs: positiveInteger(
      environment,
      "SLACK_AGENT_SESSION_IDLE_MS",
      DEFAULTS.sessionIdleMs,
    ),
  };
}
