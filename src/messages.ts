import type { AgentCommand } from "./agent.ts";

const SLACK_MESSAGE_LIMIT = 3_500;
const AGENT_COMMANDS = new Set<AgentCommand>(["reset", "status", "cancel"]);

export const HELP_MESSAGE = `SlackDeskBot commands:
• !help — show this help
• !status — show the conversation session
• !reset — start a fresh session
• !cancel (or cancel) — stop the active request

Send a prompt or attach a supported text/image file in a DM. In a channel, mention the bot for every prompt or command, including replies in a thread.`;

export type SlackCommand =
  { kind: "agent"; command: AgentCommand } | { kind: "help" } | { kind: "unknown" };

export function parseSlackCommand(text: string): SlackCommand | undefined {
  const value = text.trim().toLowerCase();
  if (value === "!help") return { kind: "help" };
  if (value === "cancel") return { kind: "agent", command: "cancel" };

  const match = /^!(reset|status|cancel)$/.exec(value);
  const command = match?.[1] as AgentCommand | undefined;
  if (command && AGENT_COMMANDS.has(command)) return { kind: "agent", command };
  return value.startsWith("!") ? { kind: "unknown" } : undefined;
}

export function parseAgentCommand(text: string): AgentCommand | undefined {
  const parsed = parseSlackCommand(text);
  return parsed?.kind === "agent" ? parsed.command : undefined;
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
