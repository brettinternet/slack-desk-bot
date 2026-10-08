import type { AgentCommand } from "./agent.ts";

export const SLACK_MESSAGE_LIMIT = 3_500;
export const MAX_SLACK_RESPONSE_MESSAGES = 3;
export const TRUNCATION_MARKER =
  "\n\n_Output truncated. Ask for a narrower response to see the omitted portion._";
const AGENT_COMMANDS = new Set<AgentCommand>(["reset", "status", "cancel"]);

/** Hard inline budget for one formatted reply in a shared channel, including thread replies. */
export const CHANNEL_REPLY_LIMIT = 1_000;
const EMPTY_RESPONSE = "Completed without a text response.";
const DETAIL_UNAVAILABLE_NOTE = "\n\n_The full response could not be attached._";
const SUMMARY_LIMIT = CHANNEL_REPLY_LIMIT - DETAIL_UNAVAILABLE_NOTE.length;
/** Requested summary length; leaves room for formatting expansion before the hard check. */
const SUMMARY_TARGET = 700;
const SUMMARY_UNAVAILABLE = "The full response is long, so it is attached as a file.";
const LONG_REPLY_FAILED =
  "The response was too long to post here, and attaching it as a file failed. Ask for a shorter answer or try again.";

/** Per-request guidance for shared channels; DMs keep the backend's default style. */
export const CHANNEL_REPLY_GUIDANCE = `<slack-delivery>
This is a shared Slack channel thread. Reply in about 50–100 words: lead with the answer, then only the important caveat and next step. Skip routine reports, repeated context, and tool narration. Write extensive detail only when requested or genuinely necessary; a reply over ${CHANNEL_REPLY_LIMIT.toLocaleString("en-US")} characters is posted as a short summary with the full text attached as a file.
</slack-delivery>`;

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

/** Formats a shared-channel reply without splitting it. */
function formatChannelReply(
  text: string,
  allowedUserMentions: ReadonlySet<string> = new Set(),
): string {
  return formatSlackText(text.trim() || EMPTY_RESPONSE, allowedUserMentions);
}

function fitsSummary(
  summary: string,
  allowedUserMentions?: ReadonlySet<string>,
  prefix = "",
): boolean {
  return (
    Boolean(summary.trim()) &&
    prefix.length + formatChannelReply(summary, allowedUserMentions).length <= SUMMARY_LIMIT
  );
}

/**
 * Prompts for a standalone summary after a too-long channel reply. Retries summarize the original
 * full response again rather than condensing the previous summary.
 */
function channelSummaryPrompt(previousSummary?: string): string {
  const request = `Write a standalone summary in at most ${SUMMARY_TARGET} characters: the answer, the material caveat, and the next step, so readers need not open the file. Do not mention the file or use tools. Reply with only the summary.`;
  return previousSummary === undefined
    ? `Your response above is too long for this shared Slack channel; the complete text will be attached as a file. ${request}`
    : `That summary was ${previousSummary.trim().length} characters, which is still too long. Summarize your earlier full response again, not the previous summary. ${request}`;
}

/**
 * Requests summary turns until a response fits the channel budget. `allowedUserMentions` is a
 * subset of the mentions allowed at delivery; any other mention is checked escaped, which is only
 * longer, so this check is never looser than delivery.
 */
export function channelReplyReviser(allowedUserMentions: ReadonlySet<string>): {
  next(response: string): string | undefined;
  detail(): string | undefined;
} {
  let detail: string | undefined;
  return {
    next(response) {
      if (detail === undefined) {
        if (formatChannelReply(response, allowedUserMentions).length <= CHANNEL_REPLY_LIMIT) {
          return undefined;
        }
        detail = response;
        return channelSummaryPrompt();
      }
      return fitsSummary(response, allowedUserMentions)
        ? undefined
        : channelSummaryPrompt(response);
    },
    detail: () => detail,
  };
}

export type ChannelReply =
  | { kind: "inline"; text: string }
  | { kind: "detail"; text: string; fallback: string; detail: string };

/**
 * Plans one shared-channel reply within {@link CHANNEL_REPLY_LIMIT}, including an optional trusted
 * mrkdwn `label`. A response that does not fit is preserved in full as `detail` and introduced by
 * a validated summary or an honest note. `fallback` is the single reply to send when attaching the
 * detail fails.
 */
export function planChannelReply(
  output: string,
  allowedUserMentions: ReadonlySet<string>,
  options: { detail?: string; label?: string } = {},
): ChannelReply {
  const { detail, label } = options;
  const prefix = label ? `${label} ` : "";
  const text = `${prefix}${formatChannelReply(output, allowedUserMentions)}`;
  if (detail === undefined && text.length <= CHANNEL_REPLY_LIMIT) return { kind: "inline", text };
  const summary =
    detail !== undefined && fitsSummary(output, allowedUserMentions, prefix) ? text : undefined;
  return {
    kind: "detail",
    text: summary ?? `${prefix}${SUMMARY_UNAVAILABLE}`,
    fallback: summary ? `${summary}${DETAIL_UNAVAILABLE_NOTE}` : `${prefix}${LONG_REPLY_FAILED}`,
    detail: detail ?? output,
  };
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
