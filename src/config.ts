import { isAbsolute, resolve } from "node:path";
import { statSync } from "node:fs";

export interface Config {
  slackBotToken: string;
  slackAppToken: string;
  workspace: string;
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

  if (!isAbsolute(configuredWorkspace)) {
    throw new Error("SLACK_AGENT_CWD must be an absolute path");
  }
  if (!statSync(workspace, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`SLACK_AGENT_CWD is not a directory: ${workspace}`);
  }

  return { slackBotToken, slackAppToken, workspace };
}
