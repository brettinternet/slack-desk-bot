import type { AgentCommand } from "./agent.ts";

const SLACK_MESSAGE_LIMIT = 3_500;
const AGENT_COMMANDS = new Set<AgentCommand>(["reset", "status", "cancel"]);

export function parseAgentCommand(text: string): AgentCommand | undefined {
  const match = /^!(reset|status|cancel)$/.exec(text.trim().toLowerCase());
  const command = match?.[1] as AgentCommand | undefined;
  return command && AGENT_COMMANDS.has(command) ? command : undefined;
}

export function isSupportedDirectMessage(subtype?: string): boolean {
  return subtype === undefined || subtype === "file_share";
}

export function stripBotMention(text: string, botUserId: string): string {
  return text.replace(new RegExp(`<@${botUserId}>`, "g"), "").trim();
}

export function splitSlackMessage(text: string, limit = SLACK_MESSAGE_LIMIT): string[] {
  const value = text.trim();
  if (!value) return ["Completed without a text response."];

  const chunks: string[] = [];
  let remaining = value;
  while (remaining.length > limit) {
    const newline = remaining.lastIndexOf("\n", limit);
    const space = remaining.lastIndexOf(" ", limit);
    const splitAt = Math.max(newline, space, Math.floor(limit * 0.6));
    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }
  chunks.push(remaining);
  return chunks;
}

export function conversationId(channel: string, threadTs?: string): string {
  return threadTs ? `${channel}:${threadTs}` : `dm:${channel}`;
}
