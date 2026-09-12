import type { AgentCommand } from "./agent.ts";

export const SLACK_MESSAGE_LIMIT = 3_500;
export const MAX_SLACK_RESPONSE_MESSAGES = 3;
export const TRUNCATION_MARKER =
  "\n\n_Output truncated. Ask for a narrower response to see the omitted portion._";
const AGENT_COMMANDS = new Set<AgentCommand>(["reset", "status", "cancel"]);

export const HELP_MESSAGE = `SlackDeskBot commands:
• !help — show this help
• !status — show the conversation session
• !reset — start a fresh session
• !cancel (or cancel) — stop the active request

Send a prompt or attach a supported text/image file in a DM. In a channel, mention the bot to start or rejoin a thread; replies in that thread do not need another mention.`;

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

export function isSupportedDirectMessage(subtype?: string): boolean {
  return subtype === undefined || subtype === "file_share";
}

export function isSupportedChannelMessage(subtype?: string): boolean {
  return isSupportedDirectMessage(subtype) || subtype === "thread_broadcast";
}

export function stripBotMention(text: string, botUserId: string): string {
  return text.replaceAll(`<@${botUserId}>`, "").trim();
}

export function splitSlackMessage(
  text: string,
  limit = SLACK_MESSAGE_LIMIT,
  maxMessages = MAX_SLACK_RESPONSE_MESSAGES,
): string[] {
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

  if (chunks.length <= maxMessages) return chunks;
  const published = chunks.slice(0, maxMessages);
  published[maxMessages - 1] =
    published[maxMessages - 1]!.slice(0, limit - TRUNCATION_MARKER.length).trimEnd() +
    TRUNCATION_MARKER;
  return published;
}

export function conversationId(channel: string, threadTs?: string): string {
  return threadTs ? `${channel}:${threadTs}` : `dm:${channel}`;
}
