import { isAbsolute, resolve } from "node:path";
import { statSync } from "node:fs";

export type AgentMode = "read-only" | "read-write";

export interface Config {
  slackBotToken: string;
  slackAppToken: string;
  workspace: string;
  allowedUserIds: Set<string>;
  agentMode: AgentMode;
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
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

  return { slackBotToken, slackAppToken, workspace, allowedUserIds, agentMode };
}
