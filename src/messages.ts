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

Send a prompt or attach a supported text/image file in a DM. In a channel, mention the bot to start or rejoin a thread. Clear requests in an active bot thread and answers to a question directed at you need no mention. For other follow-ups, use an @mention or \`laptop:\`.`;

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

const ACKNOWLEDGEMENT =
  /^(?:(?:thanks|thank you|thx)(?:[,.!\s]+(?:<@[A-Z0-9_]+>|[a-z][\w'-]*))?|got it|okay|ok|sounds good|great|cool|perfect|done)[.!\s]*$/i;
const NO_REPLY = /\b(?:no (?:reply|response) (?:needed|required)|no need to (?:reply|respond))\b/i;
const HUMAN_ADDRESSEE = /^<@[A-Z0-9_]+>[,:]?\s*/;
const REQUEST =
  /^(?:(?:also|actually|and|but|no)[,\s]+)*(?:(?:can|could|would|will|should) you\b|please\b|(?:check|compare|create|debug|explain|find|fix|implement|investigate|look|open|review|run|show|summarize|test|try|update|verify)\b)|\b(?:what about|how about|can we|could we|should we)\b/i;
const LAPTOP_PREFIX = /^laptop\s*[:,]\s*/i;

export interface ChannelThreadIntent {
  prompt: string;
  respond: boolean;
}

/** Conservatively infers whether a reply in a bot-owned channel thread is for the bot. */
export function channelThreadIntent(
  text: string,
  botUserId: string,
  awaitingReply: boolean,
  allowRequest = true,
): ChannelThreadIntent {
  const trimmed = text.trim();
  const explicitlyMentioned = trimmed.includes(`<@${botUserId}>`);
  const laptopPrompt = trimmed.replace(LAPTOP_PREFIX, "");
  const explicitlyAddressed = laptopPrompt !== trimmed;
  const prompt = stripBotMention(explicitlyAddressed ? laptopPrompt : trimmed, botUserId);

  if (explicitlyMentioned || explicitlyAddressed || parseSlackCommand(prompt)) {
    return { prompt, respond: true };
  }
  if (NO_REPLY.test(prompt) || ACKNOWLEDGEMENT.test(prompt) || HUMAN_ADDRESSEE.test(prompt)) {
    return { prompt, respond: false };
  }
  return {
    prompt,
    respond: awaitingReply || (allowRequest && REQUEST.test(prompt)),
  };
}

/** True when the end of an agent response appears to hand the turn back to a user. */
export function awaitsThreadReply(text: string): boolean {
  const ending =
    text
      .trim()
      .split(/\n\s*\n/)
      .at(-1) ?? "";
  return /\?|\b(?:let me know|which (?:one|option)|would you like|should I)\b/i.test(ending);
}

/** A direct @address on the question overrides the requester as the expected respondent. */
export function threadReplyRecipient(text: string, requesterId: string): string {
  const ending =
    text
      .trim()
      .split(/\n\s*\n/)
      .at(-1) ?? "";
  const addressedQuestion = /(?:^|[.!?]\s+)<@([A-Z0-9_]+)>[,:]?\s*[^.!?]*\?/g;
  let match: RegExpExecArray | null;
  let recipient = requesterId;
  while ((match = addressedQuestion.exec(ending))) recipient = match[1]!;
  return recipient;
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

/** Returns user mention entities that the Slack user explicitly included. */
export function slackUserMentions(text: string): ReadonlySet<string> {
  return new Set(text.match(/<@[A-Z0-9]+>/g) ?? []);
}

/**
 * Escapes Slack's three reserved characters so untrusted agent output cannot
 * inject special mentions (`<!channel>`), unapproved user mentions, fake
 * channel links, or disguised link labels. Slack renders escaped entities back
 * as literal text. User mentions explicitly present in the request may be
 * preserved so the agent can intentionally address the same person.
 */
export function escapeSlackText(
  text: string,
  allowedUserMentions: ReadonlySet<string> = new Set(),
): string {
  return text.replace(/<@[A-Z0-9_]+>|[&<>]/g, (value) => {
    if (allowedUserMentions.has(value)) return value;
    if (value === "&") return "&amp;";
    if (value === ">") return "&gt;";
    return value.length === 1 ? "&lt;" : `&lt;${value.slice(1, -1)}&gt;`;
  });
}

/** Escapes untrusted text and translates Markdown bold to Slack mrkdwn. */
export function formatSlackText(
  text: string,
  allowedUserMentions: ReadonlySet<string> = new Set(),
): string {
  return escapeSlackText(text, allowedUserMentions)
    .split(/(```[\s\S]*?```|`+[^`\n]*`+)/g)
    .map((part, index) =>
      index % 2 === 0
        ? part
            .replace(/\*\*(?=\S)([^\n]*?\S)\*\*/g, "*$1*")
            .replace(/__(?=\S)([^\n]*?\S)__/g, "*$1*")
        : part,
    )
    .join("");
}

export function conversationId(channel: string, threadTs?: string): string {
  return threadTs ? `${channel}:${threadTs}` : `dm:${channel}`;
}
