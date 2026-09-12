import { isAbsolute, resolve } from "node:path";
import { statSync } from "node:fs";

export interface Config {
  slackBotToken: string;
  slackAppToken: string;
  workspace: string;
  sessionDir?: string;
  maxActiveSessions: number;
  sessionIdleMs: number;
}

const DEFAULT_MAX_ACTIVE_SESSIONS = 32;
const DEFAULT_SESSION_IDLE_MINUTES = 30;

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

  const configuredSessionDir = environment.SLACK_AGENT_SESSION_DIR?.trim();
  if (configuredSessionDir && !isAbsolute(configuredSessionDir)) {
    throw new Error("SLACK_AGENT_SESSION_DIR must be an absolute path");
  }
  const sessionDir = configuredSessionDir ? resolve(configuredSessionDir) : undefined;
  const maxActiveSessions = positiveInteger(
    environment,
    "SLACK_AGENT_MAX_ACTIVE_SESSIONS",
    DEFAULT_MAX_ACTIVE_SESSIONS,
  );
  const sessionIdleMinutes = positiveInteger(
    environment,
    "SLACK_AGENT_SESSION_IDLE_MINUTES",
    DEFAULT_SESSION_IDLE_MINUTES,
  );

  return {
    slackBotToken,
    slackAppToken,
    workspace,
    sessionDir,
    maxActiveSessions,
    sessionIdleMs: sessionIdleMinutes * 60_000,
  };
}
