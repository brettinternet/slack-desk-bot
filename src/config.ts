import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

export interface Config {
  slackBotToken: string;
  slackAppToken: string;
  workspace: string;
  instructions?: string;
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function optional(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  return environment[name]?.trim() || undefined;
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
    instructions: loadInstructions(environment),
  };
}
