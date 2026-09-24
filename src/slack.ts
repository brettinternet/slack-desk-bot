import { App, LogLevel, SocketModeReceiver } from "@slack/bolt";
import {
  AgentCancelledError,
  AgentTimeoutError,
  ConversationQueueFullError,
  GlobalQueueFullError,
  QueueWaitTimeoutError,
  RateLimitError,
  RequesterLimitError,
  type AgentAdmission,
  type AgentAttachment,
  type AgentCommand,
  type AgentRunObserver,
  type CancellableAgentBackend,
  type ConversationDetails,
  type ConversationHistoryEntry,
  type ConversationParticipant,
  type DirectMessage,
  type DirectMessageReceipt,
  type ThreadHistoryOptions,
  type ThreadHistoryPage,
} from "./agent.ts";
import { MAX_DIRECT_MESSAGE_CHARACTERS } from "./direct-message-tool.ts";
import type { DmAuditConversationsPage, DmAuditMessagesPage, DmAuditQuery } from "./dm-audit.ts";
import type { ScheduleService } from "./schedules.ts";
import type { AutomationService } from "./automations.ts";
import { EventDeduplicator } from "./event-deduplicator.ts";
import { ingestSlackFiles } from "./slack-files.ts";
import { type LogWriter, type RequestLogWriter, writeStructuredLog } from "./log.ts";
import { type HealthState } from "./health.ts";
import { SlackCatchUpStore } from "./slack-catch-up-store.ts";
import { ThreadReplyStore } from "./thread-reply-store.ts";
import {
  awaitsThreadReply,
  channelThreadIntent,
  conversationId,
  formatSlackText,
  HELP_MESSAGE,
  isSupportedChannelMessage,
  isSupportedDirectMessage,
  parseSlackCommand,
  slackUserMentions,
  splitSlackMessage,
  stripBotMention,
  threadReplyRecipient,
  TRUNCATION_MARKER,
} from "./messages.ts";

interface SlackAgentOptions {
  botToken: string;
  appToken: string;
  allowedUserIds: ReadonlySet<string>;
  operatorUserIds?: ReadonlySet<string>;
  agent: CancellableAgentBackend;
  schedules?: ScheduleService;
  automations?: AutomationService;
  fetch?: typeof fetch;
  log?: RequestLogWriter;
  operatorLog?: LogWriter;
  operatorError?: (message: string, context: { requestId: string; errorType: string }) => void;
  health?: HealthState;
  random?: () => number;
  denialStatePath?: string;
  threadReplyStatePath?: string;
  catchUp?: {
    statePath: string;
    lookbackMs?: number;
    cooldownMs?: number;
    maxMessages?: number;
    maxHistoryRequests?: number;
    now?: () => number;
  };
}

export class SlackAuthenticationError extends Error {
  constructor() {
    super("Slack authentication failed; verify SLACK_BOT_TOKEN and reinstall the app if needed");
    this.name = "SlackAuthenticationError";
  }
}

const MAX_CONCURRENT_RESPONSES = 8;
const MISSING_CONVERSATION_TTL_MS = 60_000;
const WORKSPACE_REACTION_PROBABILITY = 0.2;
const DEFAULT_CATCH_UP_LOOKBACK_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_CATCH_UP_COOLDOWN_MS = 5 * 60 * 1_000;
const DEFAULT_CATCH_UP_MAX_MESSAGES = 10;
const DEFAULT_CATCH_UP_MAX_HISTORY_REQUESTS = 25;
const MAX_DIRECT_MESSAGES_PER_REQUEST = 5;
interface DeliveryResult {
  outcome: "success" | "partial" | "failure";
  publishedMessages: number;
  errorType?: string;
  postedText?: string;
}

interface SlackFileReference {
  id?: string;
}

interface SlackHistoryMessage {
  ts?: string;
  thread_ts?: string;
  subtype?: string;
  client_msg_id?: string;
  user?: string;
  bot_id?: string;
  username?: string;
  text?: string;
  reply_count?: number;
  files?: Array<SlackFileReference & { name?: string; title?: string; mimetype?: string }>;
}

interface SlackConversation {
  id?: string;
  is_im?: boolean;
}

interface CatchUpTarget {
  channel: string;
  threadTs?: string;
  directMessage: boolean;
  handledThrough?: number;
}

interface CatchUpCandidate extends InboundSlackMessage {
  explicitRejoin?: boolean;
  timestamp: number;
  key: string;
}

interface InboundSlackMessage {
  requestId: string;
  channel: string;
  messageTs: string;
  threadTs: string | undefined;
  requesterId: string;
  prompt: string;
  files: readonly SlackFileReference[];
  clientMessageId?: string;
  pendingAnswer?: boolean;
}

interface RequestStatus {
  observer: AgentRunObserver;
  toolCount(): number;
}

interface ExecutionResult {
  outcome: "success" | "cancelled" | "error";
  finalOutput?: string;
  delivery?: DeliveryResult;
  cancelledBy?: string;
}

function eventFiles(event: object): SlackFileReference[] {
  if (!("files" in event) || !Array.isArray(event.files)) return [];
  return event.files.filter(
    (file): file is SlackFileReference => typeof file === "object" && file !== null,
  );
}

export function userFacingAgentError(error: unknown, requestId: string): string {
  if (error instanceof AgentCancelledError) return "Request cancelled.";
  if (error instanceof ConversationQueueFullError) {
    return "This conversation already has the maximum queued requests. Wait for one to finish, then try again.";
  }
  if (error instanceof GlobalQueueFullError) {
    return "The agent is at capacity. Try again after another request finishes.";
  }
  if (error instanceof RequesterLimitError) {
    return "You already have the maximum active or queued requests. Wait for one to finish, then try again.";
  }
  if (error instanceof RateLimitError) {
    return "You're sending requests too quickly. Wait a minute, then try again.";
  }
  if (error instanceof AgentTimeoutError) {
    return "The request timed out before completion. Try a smaller or more focused request.";
  }
  if (error instanceof QueueWaitTimeoutError) {
    return "The request expired while waiting in the queue. Try again when the agent is less busy.";
  }
  return `The request failed unexpectedly. Try again or contact the operator with request ID \`${requestId}\`.`;
}

function errorType(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function slackApiError(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("data" in error)) return undefined;
  const data = error.data;
  if (!data || typeof data !== "object" || !("error" in data)) return undefined;
  return typeof data.error === "string" ? data.error : undefined;
}

function boundedLocalText(text: string, maxCharacters: number): string {
  const singleLine = text
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return singleLine.length <= maxCharacters
    ? singleLine
    : `${singleLine.slice(0, maxCharacters - 1)}…`;
}

function slackDestination(conversation: string): { channel: string; thread_ts?: string } {
  if (conversation.startsWith("dm:")) return { channel: conversation.slice(3) };
  const separator = conversation.indexOf(":");
  if (separator < 1 || separator === conversation.length - 1) {
    throw new Error("Invalid Slack conversation ID");
  }
  return {
    channel: conversation.slice(0, separator),
    thread_ts: conversation.slice(separator + 1),
  };
}

export class SlackAgent {
  private readonly app: App;
  private readonly events = new EventDeduplicator();
  private readonly denials: EventDeduplicator;
  private readonly capacityReplies = new EventDeduplicator();
  private readonly missingConversations = new Map<string, number>();
  private readonly ownedChannelThreads = new Set<string>();
  private readonly threadReplies: ThreadReplyStore;
  private readonly receiver: SocketModeReceiver;
  private workspaceEmojiNames: string[] = [];
  private readonly userCache = new Map<string, ConversationParticipant>();
  private botUserId = "";
  private botId?: string;
  private activeResponses = 0;
  private responseCapacityWarningLogged = false;
  private catchUpStore: SlackCatchUpStore | undefined;
  private catchUpTimer: ReturnType<typeof setTimeout> | undefined;
  private stopping = false;

  constructor(private readonly options: SlackAgentOptions) {
    this.denials = new EventDeduplicator({ statePath: options.denialStatePath });
    this.threadReplies = new ThreadReplyStore(options.threadReplyStatePath);
    this.receiver = new SocketModeReceiver({ appToken: options.appToken });
    this.receiver.client.on("connecting", () => options.health?.setSlackConnection("connecting"));
    this.receiver.client.on("connected", () => options.health?.setSlackConnection("connected"));
    this.receiver.client.on("reconnecting", () =>
      options.health?.setSlackConnection("reconnecting"),
    );
    this.receiver.client.on("disconnecting", () =>
      options.health?.setSlackConnection("disconnecting"),
    );
    this.receiver.client.on("disconnected", () =>
      options.health?.setSlackConnection("disconnected"),
    );
    this.app = new App({
      token: options.botToken,
      receiver: this.receiver,
      logLevel: LogLevel.INFO,
    });

    this.registerAppMentionHandler();
    this.registerMessageHandler();
  }

  private registerAppMentionHandler(): void {
    this.app.event("app_mention", async ({ body, event, client }) => {
      if (!event.user || event.bot_id) return;
      const threadTs = event.thread_ts ?? event.ts;
      if (!this.options.allowedUserIds.has(event.user)) {
        if (this.acceptEvent(body.event_id, event.channel, event.ts, event.client_msg_id)) {
          await this.deny(client, event.channel, threadTs, event.user, event.ts);
        }
        return;
      }
      const prompt = stripBotMention(event.text, this.botUserId);
      const files = eventFiles(event);
      if (
        (!prompt && files.length === 0) ||
        !this.acceptEvent(body.event_id, event.channel, event.ts, event.client_msg_id)
      )
        return;
      const id = conversationId(event.channel, threadTs);
      this.ownedChannelThreads.add(id);
      this.threadReplies.setOwner(id, event.user);
      this.threadReplies.clear(id);
      await this.respondWithinLimit(client, {
        requestId: body.event_id,
        channel: event.channel,
        messageTs: event.ts,
        threadTs,
        requesterId: event.user,
        prompt,
        files,
        ...(event.client_msg_id ? { clientMessageId: event.client_msg_id } : {}),
      });
    });
  }

  private registerMessageHandler(): void {
    this.app.event("message", async ({ body, event, client }) => {
      if (!("user" in event) || !event.user || ("bot_id" in event && event.bot_id)) return;
      const directMessage = event.channel_type === "im";
      if (
        !(directMessage
          ? isSupportedDirectMessage(event.subtype)
          : isSupportedChannelMessage(event.subtype))
      )
        return;
      const threadTs = "thread_ts" in event ? event.thread_ts : undefined;
      if (!directMessage) {
        if (!threadTs || !(await this.ownsChannelThread(conversationId(event.channel, threadTs))))
          return;
      }
      if (!this.options.allowedUserIds.has(event.user)) return;
      const rawText = "text" in event ? (event.text ?? "") : "";
      const id = conversationId(event.channel, threadTs);
      const pendingAnswer = !directMessage && this.threadReplies.expects(id, event.user);
      const intent = directMessage
        ? { prompt: rawText, respond: true }
        : channelThreadIntent(
            rawText,
            this.botUserId,
            pendingAnswer,
            this.threadReplies.isOwner(id, event.user),
          );
      const files = eventFiles(event);
      const clientMessageId = "client_msg_id" in event ? event.client_msg_id : undefined;
      if (
        (!intent.prompt && files.length === 0) ||
        !intent.respond ||
        !this.acceptEvent(body.event_id, event.channel, event.ts, clientMessageId)
      )
        return;
      if (
        !directMessage &&
        (rawText.includes(`<@${this.botUserId}>`) || /^\s*laptop\s*[:,]/i.test(rawText))
      ) {
        this.threadReplies.setOwner(id, event.user);
      }
      this.threadReplies.clear(id);
      await this.respondWithinLimit(client, {
        requestId: body.event_id,
        channel: event.channel,
        messageTs: event.ts,
        threadTs,
        requesterId: event.user,
        prompt: intent.prompt,
        files,
        ...(pendingAnswer ? { pendingAnswer } : {}),
        ...(clientMessageId ? { clientMessageId } : {}),
      });
    });
  }

  async start(): Promise<void> {
    let authentication: Awaited<ReturnType<typeof this.app.client.auth.test>>;
    try {
      authentication = await this.slackOperation(
        this.app.client.auth.test({ token: this.options.botToken }),
      );
    } catch {
      throw new SlackAuthenticationError();
    }
    if (!authentication.user_id) throw new SlackAuthenticationError();
    this.botUserId = authentication.user_id;
    this.botId = authentication.bot_id;
    await this.loadWorkspaceEmoji();
    await this.app.start();
    this.scheduleCatchUp();
    (this.options.operatorLog ?? writeStructuredLog)({
      event: "startup",
      component: "slack",
      outcome: "connected",
    });
  }

  async leaveChannel(channel: string): Promise<void> {
    await this.slackOperation(this.app.client.conversations.leave({ channel }));
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.catchUpTimer) clearTimeout(this.catchUpTimer);
    await this.app.stop();
  }

  private scheduleCatchUp(): void {
    const config = this.options.catchUp;
    if (!config) return;
    const now = config.now ?? Date.now;
    try {
      this.catchUpStore = new SlackCatchUpStore(config.statePath, now());
    } catch (error) {
      this.reportCatchUpError("Unable to initialize Slack catch-up state", error);
      return;
    }
    const cooldownMs = config.cooldownMs ?? DEFAULT_CATCH_UP_COOLDOWN_MS;
    const delayMs = Math.max(0, this.catchUpStore.lastReconciledAt + cooldownMs - now());
    this.catchUpTimer = setTimeout(() => {
      this.catchUpTimer = undefined;
      void this.reconcileMissedMessages();
    }, delayMs);
    this.catchUpTimer.unref();
  }

  private async reconcileMissedMessages(): Promise<void> {
    const config = this.options.catchUp;
    const store = this.catchUpStore;
    if (!config || !store || this.stopping) return;
    const now = config.now ?? Date.now;
    const reconciliationAt = now();
    const lookbackMs = config.lookbackMs ?? DEFAULT_CATCH_UP_LOOKBACK_MS;
    const oldestAt = Math.max(store.lastReconciledAt, reconciliationAt - lookbackMs);
    const targets: CatchUpTarget[] = [];
    let complete = true;

    try {
      const conversations = await this.options.agent.listConversations?.();
      for (const conversation of conversations ?? []) {
        if (conversation.conversationId.startsWith("dm:")) {
          targets.push({
            channel: conversation.conversationId.slice(3),
            directMessage: true,
            handledThrough: conversation.lastActiveAt,
          });
          continue;
        }
        const separator = conversation.conversationId.indexOf(":");
        if (separator > 0) {
          targets.push({
            channel: conversation.conversationId.slice(0, separator),
            threadTs: conversation.conversationId.slice(separator + 1),
            directMessage: false,
            handledThrough: conversation.lastActiveAt,
          });
        }
      }
    } catch (error) {
      complete = false;
      this.reportCatchUpError("Unable to list existing conversations for Slack catch-up", error);
    }

    try {
      let cursor: string | undefined;
      for (let page = 0; page < 5; page++) {
        const response = await this.slackOperation(
          this.app.client.users.conversations({
            types: "public_channel,private_channel,im",
            exclude_archived: true,
            limit: 200,
            ...(cursor ? { cursor } : {}),
          }),
        );
        const conversations = (response.channels ?? []) as SlackConversation[];
        for (const conversation of conversations.filter((item) => item.is_im)) {
          if (conversation.id) targets.push({ channel: conversation.id, directMessage: true });
        }
        for (const conversation of conversations.filter((item) => !item.is_im)) {
          if (conversation.id) targets.push({ channel: conversation.id, directMessage: false });
        }
        cursor = response.response_metadata?.next_cursor || undefined;
        if (!cursor) break;
      }
    } catch (error) {
      complete = false;
      this.reportCatchUpError("Unable to list Slack conversations for catch-up", error);
    }

    const uniqueTargets = targets
      .filter(
        (target, index) =>
          targets.findIndex(
            (candidate) =>
              candidate.channel === target.channel && candidate.threadTs === target.threadTs,
          ) === index,
      )
      .sort((left, right) => {
        const priority = (target: (typeof targets)[number]): number =>
          target.directMessage ? 0 : target.threadTs ? 1 : 2;
        return priority(left) - priority(right);
      });
    const historyRequestLimit = config.maxHistoryRequests ?? DEFAULT_CATCH_UP_MAX_HISTORY_REQUESTS;
    const candidates: CatchUpCandidate[] = [];
    for (const target of uniqueTargets.slice(0, historyRequestLimit)) {
      if (this.stopping) return;
      try {
        const messages = target.threadTs
          ? (
              await this.slackOperation(
                this.app.client.conversations.replies({
                  channel: target.channel,
                  ts: target.threadTs,
                  oldest: String(oldestAt / 1_000),
                  latest: String(reconciliationAt / 1_000),
                  inclusive: false,
                  limit: 100,
                }),
              )
            ).messages
          : (
              await this.slackOperation(
                this.app.client.conversations.history({
                  channel: target.channel,
                  oldest: String(oldestAt / 1_000),
                  latest: String(reconciliationAt / 1_000),
                  inclusive: false,
                  limit: 100,
                }),
              )
            ).messages;
        const boundedMessages = ((messages ?? []) as SlackHistoryMessage[]).filter((message) => {
          const timestamp = Number(message.ts) * 1_000;
          return (
            Number.isFinite(timestamp) &&
            timestamp > oldestAt &&
            timestamp < reconciliationAt &&
            timestamp > (target.handledThrough ?? 0)
          );
        });
        const messagesToInspect =
          target.directMessage || target.threadTs
            ? boundedMessages.sort((left, right) => Number(right.ts) - Number(left.ts)).slice(0, 1)
            : boundedMessages;
        for (const message of messagesToInspect) {
          const candidate = this.catchUpCandidate(target, message);
          if (candidate && !store.hasProcessed(candidate.key)) candidates.push(candidate);
        }
      } catch (error) {
        if (slackApiError(error) === "channel_not_found") continue;
        complete = false;
        this.reportCatchUpError("Unable to read a Slack conversation during catch-up", error);
      }
    }

    const maxMessages = config.maxMessages ?? DEFAULT_CATCH_UP_MAX_MESSAGES;
    const selected = candidates
      .filter(
        (candidate, index) =>
          candidates.findIndex((message) => message.key === candidate.key) === index,
      )
      .sort((left, right) => left.timestamp - right.timestamp)
      .slice(-maxMessages);
    for (const candidate of selected) {
      if (this.stopping) return;
      if (
        !this.acceptEvent(
          `catch-up:${candidate.key}`,
          candidate.channel,
          candidate.messageTs,
          candidate.clientMessageId,
        )
      ) {
        continue;
      }
      if (candidate.threadTs && candidate.explicitRejoin) {
        this.threadReplies.setOwner(
          conversationId(candidate.channel, candidate.threadTs),
          candidate.requesterId,
        );
      }
      if (candidate.pendingAnswer && candidate.threadTs) {
        this.threadReplies.clear(conversationId(candidate.channel, candidate.threadTs));
      }
      await this.respondWithinLimit(this.app.client, candidate);
    }
    if (complete && !this.stopping) {
      store.markReconciled(reconciliationAt, reconciliationAt - lookbackMs);
    }
  }

  private catchUpCandidate(
    target: CatchUpTarget,
    message: SlackHistoryMessage,
  ): CatchUpCandidate | undefined {
    if (
      !message.ts ||
      !Number.isFinite(Number(message.ts)) ||
      !message.user ||
      message.bot_id ||
      !this.options.allowedUserIds.has(message.user)
    ) {
      return undefined;
    }
    const supported = target.directMessage
      ? isSupportedDirectMessage(message.subtype)
      : isSupportedChannelMessage(message.subtype);
    if (!supported) return undefined;
    const rawText = message.text ?? "";
    const files = message.files ?? [];
    let prompt = rawText;
    let threadTs = target.threadTs;
    let pendingAnswer = false;
    if (!target.directMessage && target.threadTs) {
      pendingAnswer = this.threadReplies.expects(
        conversationId(target.channel, target.threadTs),
        message.user,
      );
      const intent = channelThreadIntent(
        rawText,
        this.botUserId,
        pendingAnswer,
        this.threadReplies.isOwner(conversationId(target.channel, target.threadTs), message.user),
      );
      if (!intent.respond) return undefined;
      prompt = intent.prompt;
    } else if (!target.directMessage) {
      const mention = `<@${this.botUserId}>`;
      if (!rawText.includes(mention) || (message.reply_count ?? 0) > 0) return undefined;
      prompt = stripBotMention(rawText, this.botUserId);
      threadTs = message.thread_ts ?? message.ts;
    }
    if (!prompt && files.length === 0) return undefined;
    return {
      requestId: `catch-up:${target.channel}:${message.ts}`,
      channel: target.channel,
      messageTs: message.ts,
      threadTs,
      requesterId: message.user,
      prompt,
      files,
      ...(pendingAnswer ? { pendingAnswer } : {}),
      ...(!target.directMessage &&
      (rawText.includes(`<@${this.botUserId}>`) || /^\s*laptop\s*[:,]/i.test(rawText))
        ? { explicitRejoin: true }
        : {}),
      timestamp: Number(message.ts) * 1_000,
      key: `${target.channel}:${message.ts}`,
      ...(message.client_msg_id ? { clientMessageId: message.client_msg_id } : {}),
    };
  }

  private reportCatchUpError(message: string, error: unknown): void {
    (this.options.operatorLog ?? writeStructuredLog)({
      event: "operator_error",
      component: "slack",
      message,
      error_type: errorType(error),
    });
  }

  async publishOperatorExchange(
    conversation: string,
    prompt: string,
    response: string,
  ): Promise<void> {
    const destination = slackDestination(conversation);
    await this.publishAttributed(destination, "*Local operator:*", prompt);
    await this.publishAttributed(destination, "*Agent (operator request):*", response);
  }

  /**
   * Sends a DM from the bot. Agent-initiated messages name the requesting user so
   * recipients can tell who asked; local operator messages speak as the bot.
   */
  async sendDirectMessage(
    message: DirectMessage,
    requesterId?: string,
    signal?: AbortSignal,
  ): Promise<DirectMessageReceipt> {
    const recipientId = message.userId.trim().replace(/^<@([A-Z0-9]+)>$/, "$1");
    if (!/^[UW][A-Z0-9]{2,}$/.test(recipientId)) {
      throw new Error("Recipient must be a Slack member ID such as U0123456789");
    }
    const text = message.text.trim();
    if (!text) throw new Error("Direct message text is required");
    if (text.length > MAX_DIRECT_MESSAGE_CHARACTERS) {
      throw new Error(`Direct message text exceeds ${MAX_DIRECT_MESSAGE_CHARACTERS} characters`);
    }
    if (signal?.aborted) throw signal.reason;

    let user;
    try {
      user = (await this.slackOperation(this.app.client.users.info({ user: recipientId }))).user;
    } catch (error) {
      if (slackApiError(error) === "user_not_found") throw new Error("Slack user not found");
      throw error;
    }
    if (!user || user.deleted) throw new Error("Slack user not found");
    if (user.is_bot || recipientId === "USLACKBOT" || recipientId === this.botUserId) {
      throw new Error("Direct messages can only be sent to people");
    }
    const recipient = await this.resolveUser(recipientId);

    // Operator text is trusted to mention anyone; agent text may mention only
    // the recipient and requester, so injected content cannot ping others.
    const allowedMentions = requesterId
      ? new Set([`<@${recipientId}>`, `<@${requesterId}>`])
      : slackUserMentions(text);
    const label = requesterId ? `*Message from <@${requesterId}>:*\n` : "";
    const chunks = splitSlackMessage(formatSlackText(text, allowedMentions));
    let receipt: DirectMessageReceipt | undefined;
    for (const [index, chunk] of chunks.entries()) {
      if (signal?.aborted) throw signal.reason;
      const response = await this.chatOperation(() =>
        this.app.client.chat.postMessage({
          channel: recipientId,
          text: index === 0 ? `${label}${chunk}` : chunk,
          unfurl_links: false,
          unfurl_media: false,
        }),
      );
      receipt ??= {
        recipientId,
        recipientName: recipient.name,
        channel: response.channel ?? recipientId,
        ts: response.ts ?? "",
      };
    }
    (this.options.operatorLog ?? writeStructuredLog)({
      event: "direct_message_sent",
      recipient: recipientId,
      requester: requesterId ?? "local-operator",
      messages: chunks.length,
    });
    return receipt!;
  }

  async listDmAuditConversations(cursor?: string): Promise<DmAuditConversationsPage> {
    const response = await this.slackOperation(
      this.app.client.users.conversations({
        types: "im",
        exclude_archived: false,
        limit: 200,
        ...(cursor ? { cursor } : {}),
      }),
    );
    const conversations = (response.channels ?? []) as Array<SlackConversation & { user?: string }>;
    const nextCursor = response.response_metadata?.next_cursor || undefined;
    return {
      conversations: conversations.flatMap((item) =>
        item.is_im && item.id?.startsWith("D") && item.user
          ? [{ channel: item.id, recipientId: item.user }]
          : [],
      ),
      ...(nextCursor ? { nextCursor } : {}),
    };
  }

  async auditDmMessages(query: DmAuditQuery): Promise<DmAuditMessagesPage> {
    if (!this.botId) throw new Error("Slack did not identify the bot; DM audit cannot be complete");
    const response = query.threadTs
      ? await this.slackOperation(
          this.app.client.conversations.replies({
            channel: query.channel,
            ts: query.threadTs,
            oldest: query.oldest,
            ...(query.latest ? { latest: query.latest } : {}),
            ...(query.cursor ? { cursor: query.cursor } : {}),
            inclusive: false,
            limit: 100,
          }),
        )
      : await this.slackOperation(
          this.app.client.conversations.history({
            channel: query.channel,
            // Scan older parents too: a thread started before --since can have new replies.
            oldest: "0",
            ...(query.latest ? { latest: query.latest } : {}),
            inclusive: false,
            limit: 100,
          }),
        );
    const raw = (response.messages ?? []) as SlackHistoryMessage[];
    const messages: DmAuditMessagesPage["messages"] = [];
    const threads: string[] = [];
    let lastTs: string | undefined;
    let cutShort = false;
    // The client caps responses at 256 KiB; leave room for the response envelope.
    let bytes = 0;
    for (const message of raw) {
      if (
        message.ts &&
        message.ts !== query.threadTs &&
        Number(message.ts) > Number(query.oldest) &&
        (message.user === this.botUserId || message.bot_id === this.botId)
      ) {
        const entry = {
          channel: query.channel,
          recipientId: query.recipientId,
          ts: message.ts,
          text: message.text ?? "",
          permalink: `https://app.slack.com/archives/${query.channel}/p${message.ts.replace(".", "")}`,
        };
        const size = Buffer.byteLength(JSON.stringify(entry));
        if (bytes + size > 250_000) {
          if (!lastTs) throw new Error("Slack message exceeds the audit response size limit");
          cutShort = true;
          break;
        }
        bytes += size;
        messages.push(entry);
      }
      if (!query.threadTs && message.reply_count && message.reply_count > 0 && message.ts) {
        threads.push(message.ts);
      }
      if (message.ts) lastTs = message.ts;
    }
    if (cutShort || response.has_more || response.response_metadata?.next_cursor) {
      if (!lastTs) throw new Error("Slack history cannot be paginated for DM audit");
      if (!query.threadTs) return { messages, threads, nextLatest: lastTs };
      if (!cutShort && response.response_metadata?.next_cursor)
        return { messages, threads, nextCursor: response.response_metadata.next_cursor };
      return { messages, threads, nextOldest: lastTs };
    }
    return { messages, threads };
  }

  async inspectConversation(
    conversation: string,
    historyLimit: number,
  ): Promise<ConversationDetails> {
    const destination = slackDestination(conversation);
    const channelResponse = await this.bestEffortSlackOperation(
      this.app.client.conversations.info({ channel: destination.channel }),
    );
    const channel = channelResponse?.channel;
    const channelName =
      channel && "name" in channel && typeof channel.name === "string" ? channel.name : undefined;

    const inspectedMessages = await this.conversationMessages(destination, historyLimit > 0);
    const messages = (inspectedMessages ?? [])
      .filter((message) => Number.isFinite(Number(message.ts)))
      .sort((left, right) => Number(left.ts) - Number(right.ts));
    const participantIds = [
      ...new Set(
        messages.flatMap((message) => (message.user && !message.bot_id ? [message.user] : [])),
      ),
    ].filter((id) => id !== this.botUserId);
    const participants: ConversationParticipant[] = [];
    for (let index = 0; index < participantIds.length; index += 4) {
      participants.push(
        ...(await Promise.all(
          participantIds.slice(index, index + 4).map((id) => this.resolveUser(id)),
        )),
      );
    }
    const participantById = new Map(
      participants.map((participant) => [participant.id, participant]),
    );
    const history =
      historyLimit > 0
        ? messages
            .slice(-historyLimit)
            .map((message) => this.historyEntry(message, participantById))
        : [];
    const threadStarter = destination.thread_ts
      ? boundedLocalText(messages[0]?.text ?? "", 120)
      : undefined;
    const directUserId =
      channel && "user" in channel && typeof channel.user === "string"
        ? channel.user
        : participantIds[0];
    const directParticipant = directUserId
      ? (participantById.get(directUserId) ?? (await this.resolveUser(directUserId)))
      : undefined;
    const permalinkResponse =
      destination.thread_ts && historyLimit > 0
        ? await this.bestEffortSlackOperation(
            this.app.client.chat.getPermalink({
              channel: destination.channel,
              message_ts: destination.thread_ts,
            }),
          )
        : undefined;
    const permalink = permalinkResponse?.permalink;
    const label = conversation.startsWith("dm:")
      ? `DM with ${directParticipant?.name ?? directUserId ?? destination.channel}`
      : `#${channelName ?? destination.channel}${threadStarter ? ` / ${threadStarter}` : ""}`;

    return {
      label,
      ...(channelName ? { channelName } : {}),
      ...(threadStarter ? { threadStarter } : {}),
      ...(typeof permalink === "string" ? { permalink } : {}),
      participants,
      history,
      ...(!inspectedMessages ? { historyUnavailable: "Slack history is unavailable" } : {}),
    };
  }

  private async readThreadHistoryPage(
    channel: string,
    threadTs: string,
    options: ThreadHistoryOptions,
    signal?: AbortSignal,
  ): Promise<ThreadHistoryPage> {
    if (signal?.aborted) throw signal.reason;
    const limit = Math.max(1, Math.min(50, options.limit ?? 50));
    const response = await this.slackOperation(
      this.app.client.conversations.replies({
        channel,
        ts: threadTs,
        limit,
        ...(options.cursor ? { cursor: options.cursor } : {}),
      }),
    );
    if (signal?.aborted) throw signal.reason;
    const messages = Array.isArray(response.messages)
      ? (response.messages as SlackHistoryMessage[])
      : [];
    const participantIds = [
      ...new Set(
        messages.flatMap((message) => (message.user && !message.bot_id ? [message.user] : [])),
      ),
    ].filter((id) => id !== this.botUserId);
    const participants: ConversationParticipant[] = [];
    for (let index = 0; index < participantIds.length; index += 4) {
      participants.push(
        ...(await Promise.all(
          participantIds.slice(index, index + 4).map((id) => this.resolveUser(id)),
        )),
      );
    }
    const participantById = new Map(
      participants.map((participant) => [participant.id, participant]),
    );
    const nextCursor = response.response_metadata?.next_cursor || undefined;
    return {
      messages: messages
        .filter((message) => Number.isFinite(Number(message.ts)))
        .sort((left, right) => Number(left.ts) - Number(right.ts))
        .map((message) => this.historyEntry(message, participantById)),
      ...(nextCursor ? { nextCursor } : {}),
    };
  }

  private async conversationMessages(
    destination: { channel: string; thread_ts?: string },
    fetchAllPages: boolean,
  ): Promise<SlackHistoryMessage[] | undefined> {
    if (!destination.thread_ts) {
      const response = await this.bestEffortSlackOperation(
        this.app.client.conversations.history({ channel: destination.channel, limit: 100 }),
      );
      return Array.isArray(response?.messages)
        ? (response.messages as SlackHistoryMessage[])
        : undefined;
    }

    const messages: SlackHistoryMessage[] = [];
    let cursor: string | undefined;
    do {
      const response = await this.bestEffortSlackOperation(
        this.app.client.conversations.replies({
          channel: destination.channel,
          ts: destination.thread_ts,
          limit: 100,
          ...(cursor ? { cursor } : {}),
        }),
      );
      if (!response || !Array.isArray(response.messages))
        return messages.length > 0 ? messages : undefined;
      messages.push(...(response.messages as SlackHistoryMessage[]));
      cursor = response.response_metadata?.next_cursor || undefined;
    } while (fetchAllPages && cursor);
    return messages;
  }

  private async resolveUser(id: string): Promise<ConversationParticipant> {
    const cached = this.userCache.get(id);
    if (cached) return cached;
    const response = await this.bestEffortSlackOperation(this.app.client.users.info({ user: id }));
    const user = response?.user;
    const profile = user?.profile;
    const handle = user?.name || undefined;
    const name = boundedLocalText(
      profile?.display_name || profile?.real_name || user?.real_name || handle || id,
      120,
    );
    const participant = {
      id,
      name,
      ...(handle ? { handle: boundedLocalText(handle, 80) } : {}),
    };
    this.userCache.set(id, participant);
    return participant;
  }

  private historyEntry(
    message: SlackHistoryMessage,
    participants: ReadonlyMap<string, ConversationParticipant>,
  ): ConversationHistoryEntry {
    const text = boundedLocalText(message.text ?? "", 500);
    const operator = text.startsWith("*Local operator:*");
    const agent = Boolean(message.bot_id || message.user === this.botUserId) && !operator;
    const participant = message.user ? participants.get(message.user) : undefined;
    const attachments = (message.files ?? []).map((file) =>
      boundedLocalText(file.name ?? file.title ?? file.mimetype ?? "attachment", 200),
    );
    return {
      timestamp: Math.round(Number(message.ts) * 1_000),
      ...(message.user ? { authorId: message.user } : {}),
      authorName: operator
        ? "Local operator"
        : agent
          ? "Agent"
          : (participant?.name ?? message.username ?? message.user ?? "User"),
      kind: operator ? "operator" : agent ? "agent" : "user",
      text,
      ...(attachments.length > 0 ? { attachments } : {}),
    };
  }

  /** Splits and escapes untrusted text so one oversized frame cannot fail delivery. */
  private async publishAttributed(
    destination: { channel: string; thread_ts?: string },
    label: string,
    text: string,
  ): Promise<void> {
    const chunks = splitSlackMessage(formatSlackText(text));
    for (const [index, chunk] of chunks.entries()) {
      await this.chatOperation(() =>
        this.app.client.chat.postMessage({
          ...destination,
          text: index === 0 ? `${label} ${chunk}` : chunk,
          unfurl_links: false,
          unfurl_media: false,
        }),
      );
    }
  }

  private async loadWorkspaceEmoji(): Promise<void> {
    try {
      const response = await this.slackOperation(this.app.client.emoji.list());
      this.workspaceEmojiNames = Object.entries(response.emoji ?? {})
        .filter(([, value]) => !value.startsWith("alias:"))
        .map(([name]) => name);
    } catch (error) {
      (this.options.operatorLog ?? writeStructuredLog)({
        event: "operator_error",
        component: "slack",
        message: "Unable to load workspace emoji; playful reactions are disabled",
        error_type: errorType(error),
      });
    }
  }

  private async ownsChannelThread(id: string): Promise<boolean> {
    if (this.ownedChannelThreads.has(id)) return true;

    const now = Date.now();
    for (const [conversationId, expiresAt] of this.missingConversations) {
      if (expiresAt <= now) this.missingConversations.delete(conversationId);
    }
    if (this.missingConversations.has(id)) return false;

    if (!(await this.options.agent.hasConversation?.(id))) {
      this.missingConversations.set(id, now + MISSING_CONVERSATION_TTL_MS);
      return false;
    }

    this.ownedChannelThreads.add(id);
    return true;
  }

  private async slackOperation<T>(operation: Promise<T>): Promise<T> {
    const value = await operation;
    this.options.health?.recordSuccessfulSlackOperation();
    return value;
  }

  private async bestEffortSlackOperation<T>(operation: Promise<T>): Promise<T | undefined> {
    try {
      return await this.slackOperation(operation);
    } catch {
      return undefined;
    }
  }

  private async chatOperation<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await this.slackOperation(operation());
    } catch (error) {
      const retryAfter = this.retryAfterSeconds(error);
      if (retryAfter === undefined) throw error;
      await new Promise((resolve) => setTimeout(resolve, retryAfter * 1_000));
      return this.slackOperation(operation());
    }
  }

  private async bestEffortChatOperation<T>(operation: () => Promise<T>): Promise<T | undefined> {
    try {
      return await this.chatOperation(operation);
    } catch {
      return undefined;
    }
  }

  private retryAfterSeconds(error: unknown): number | undefined {
    if (typeof error !== "object" || error === null) return undefined;
    if ("retryAfter" in error) {
      const retryAfter = error.retryAfter;
      if (typeof retryAfter === "number" && Number.isFinite(retryAfter) && retryAfter >= 0) {
        return retryAfter;
      }
    }
    if (!("data" in error)) return undefined;
    const data = error.data;
    if (typeof data !== "object" || data === null || !("error" in data)) return undefined;
    if (data.error !== "ratelimited" || !("response_metadata" in data)) return undefined;
    const metadata = data.response_metadata;
    if (typeof metadata !== "object" || metadata === null || !("retryAfter" in metadata))
      return undefined;
    const retryAfter = metadata.retryAfter;
    return typeof retryAfter === "number" && Number.isFinite(retryAfter) && retryAfter >= 0
      ? retryAfter
      : undefined;
  }

  private acceptEvent(
    eventId: string,
    channel: string,
    messageTs: string,
    clientMessageId?: string,
  ): boolean {
    return this.events.accept([
      `event:${eventId}`,
      `message:${channel}:${clientMessageId ?? messageTs}`,
    ]);
  }

  /** Explains the denial once, then uses a quiet reaction for later messages in the dedupe window. */
  private async deny(
    client: App["client"],
    channel: string,
    threadTs: string | undefined,
    userId: string,
    messageTs: string,
  ): Promise<void> {
    (this.options.operatorLog ?? writeStructuredLog)({ event: "unauthorized", channel });
    if (this.denials.accept([`deny:${conversationId(channel, threadTs)}:${userId}`])) {
      await this.bestEffortChatOperation(() =>
        client.chat.postMessage({
          channel,
          thread_ts: threadTs,
          text: "You are not authorized to use this agent.",
        }),
      );
      return;
    }
    await this.bestEffortSlackOperation(
      client.reactions.add({ channel, timestamp: messageTs, name: "no_entry" }),
    );
  }

  private reportOperatorError(message: string, requestId: string, type: string): void {
    if (this.options.operatorError) {
      this.options.operatorError(message, { requestId, errorType: type });
      return;
    }
    (this.options.operatorLog ?? writeStructuredLog)({
      event: "operator_error",
      component: "slack",
      message,
      request_id: requestId,
      error_type: type,
    });
  }

  private async respondWithinLimit(
    client: App["client"],
    message: InboundSlackMessage,
  ): Promise<void> {
    if (this.activeResponses >= MAX_CONCURRENT_RESPONSES) {
      if (!this.responseCapacityWarningLogged) {
        (this.options.operatorLog ?? writeStructuredLog)({
          event: "capacity_drop",
          active_responses: this.activeResponses,
          limit: MAX_CONCURRENT_RESPONSES,
        });
        this.responseCapacityWarningLogged = true;
      }
      this.restorePendingAnswer(message);
      await this.reportCapacityDrop(client, message);
      return;
    }

    this.activeResponses++;
    try {
      await this.respond(client, message);
    } finally {
      try {
        this.catchUpStore?.markProcessed(
          `${message.channel}:${message.messageTs}`,
          (this.options.catchUp?.now ?? Date.now)(),
        );
      } catch (error) {
        this.reportCatchUpError("Unable to save processed Slack message state", error);
      }
      this.activeResponses--;
      if (this.activeResponses < MAX_CONCURRENT_RESPONSES) {
        this.responseCapacityWarningLogged = false;
      }
    }
  }

  private async reportCapacityDrop(
    client: App["client"],
    message: InboundSlackMessage,
  ): Promise<void> {
    await this.bestEffortSlackOperation(
      client.reactions.add({
        channel: message.channel,
        timestamp: message.messageTs,
        name: "x",
      }),
    );
    const id = conversationId(message.channel, message.threadTs);
    if (!this.capacityReplies.accept([`capacity:${id}`])) return;
    await this.bestEffortChatOperation(() =>
      client.chat.postMessage({
        channel: message.channel,
        thread_ts: message.threadTs,
        text: "The agent is at capacity. Try again after another request finishes.",
      }),
    );
  }

  private async respond(client: App["client"], message: InboundSlackMessage): Promise<void> {
    const command = message.files.length === 0 ? parseSlackCommand(message.prompt) : undefined;
    if (command?.kind === "help" || command?.kind === "unknown") {
      await this.chatOperation(() =>
        client.chat.postMessage({
          channel: message.channel,
          thread_ts: message.threadTs,
          text:
            command.kind === "help"
              ? HELP_MESSAGE
              : "Unknown command. Send `!help` to see supported commands.",
        }),
      );
      return;
    }

    let admission: AgentAdmission | undefined;
    const agentCommand = command?.kind === "agent" ? command.command : undefined;
    if (agentCommand !== "status" && agentCommand !== "cancel") {
      try {
        admission = this.options.agent.admit?.(message.requesterId);
      } catch (error) {
        this.restorePendingAnswer(message);
        await this.postAdmissionError(client, message, error);
        return;
      }
    }

    try {
      await this.respondAdmitted(client, message, command, admission);
    } finally {
      admission?.release();
    }
  }

  private async postAdmissionError(
    client: App["client"],
    message: InboundSlackMessage,
    error: unknown,
  ): Promise<void> {
    await this.bestEffortChatOperation(() =>
      client.chat.postMessage({
        channel: message.channel,
        thread_ts: message.threadTs,
        text: userFacingAgentError(error, message.requestId),
      }),
    );
  }

  private async respondAdmitted(
    client: App["client"],
    message: InboundSlackMessage,
    command: ReturnType<typeof parseSlackCommand>,
    admission: AgentAdmission | undefined,
  ): Promise<void> {
    const startedAt = performance.now();
    const status = this.createRequestStatus();
    const execution = await this.executeRequest(client, message, command, admission, status);
    const delivery = await this.deliverRequest(client, message, execution);
    this.updateThreadAttention(message, execution, delivery);
    this.recordRequest(message, status, execution, delivery, startedAt);
  }

  private updateThreadAttention(
    message: InboundSlackMessage,
    execution: ExecutionResult,
    delivery: DeliveryResult,
  ): void {
    if (!message.threadTs) return;
    const id = conversationId(message.channel, message.threadTs);
    if (
      execution.outcome === "success" &&
      delivery.outcome === "success" &&
      delivery.postedText &&
      !delivery.postedText.endsWith(TRUNCATION_MARKER) &&
      awaitsThreadReply(delivery.postedText)
    ) {
      const recipient = threadReplyRecipient(delivery.postedText, message.requesterId);
      this.threadReplies.set(
        id,
        this.options.allowedUserIds.has(recipient) ? recipient : message.requesterId,
      );
    } else if (message.pendingAnswer && execution.outcome !== "success") {
      this.restorePendingAnswer(message);
    } else {
      this.threadReplies.clear(id);
    }
  }

  private restorePendingAnswer(message: InboundSlackMessage): void {
    if (message.pendingAnswer && message.threadTs) {
      this.threadReplies.set(
        conversationId(message.channel, message.threadTs),
        message.requesterId,
      );
    }
  }

  private createRequestStatus(): RequestStatus {
    let toolCount = 0;
    return {
      observer: {
        onQueued: () => {},
        onStarted: () => {},
        onToolUse: () => toolCount++,
      },
      toolCount: () => toolCount,
    };
  }

  private async executeRequest(
    client: App["client"],
    message: InboundSlackMessage,
    command: ReturnType<typeof parseSlackCommand>,
    admission: AgentAdmission | undefined,
    status: RequestStatus,
  ): Promise<ExecutionResult> {
    try {
      return await this.performRequest(client, message, command, admission, status);
    } catch (error) {
      const cancelled = error instanceof AgentCancelledError;
      const expected = cancelled || this.isExpectedAgentError(error);
      if (!expected) {
        this.reportOperatorError(
          "Unexpected agent request failure",
          message.requestId,
          errorType(error),
        );
      }
      return {
        outcome: cancelled ? "cancelled" : "error",
        finalOutput: userFacingAgentError(error, message.requestId),
      };
    }
  }

  private async performRequest(
    client: App["client"],
    message: InboundSlackMessage,
    command: ReturnType<typeof parseSlackCommand>,
    admission: AgentAdmission | undefined,
    status: RequestStatus,
  ): Promise<ExecutionResult> {
    const { attachments, warnings } = await ingestSlackFiles(
      client,
      this.options.botToken,
      message.files,
      this.options.fetch,
    );
    for (const warning of warnings) {
      await this.chatOperation(() =>
        client.chat.postMessage({
          channel: message.channel,
          thread_ts: message.threadTs,
          text: warning,
        }),
      );
    }
    if (!message.prompt && attachments.length === 0) {
      return {
        outcome: "success",
        delivery: { outcome: "success", publishedMessages: 0 },
      };
    }
    const agentCommand =
      attachments.length === 0 && command?.kind === "agent" ? command.command : undefined;
    return this.invokeAgent(message, attachments, agentCommand, admission, status.observer);
  }

  private async invokeAgent(
    message: InboundSlackMessage,
    attachments: readonly AgentAttachment[],
    command: AgentCommand | undefined,
    admission: AgentAdmission | undefined,
    observer: AgentRunObserver,
  ): Promise<ExecutionResult> {
    const id = conversationId(message.channel, message.threadTs);
    if (command === "cancel") {
      observer.onStarted?.();
      const cancelled = this.options.agent.cancelActive(
        id,
        message.requesterId,
        this.options.operatorUserIds?.has(message.requesterId),
      );
      return {
        outcome: "success",
        finalOutput: cancelled
          ? `<@${message.requesterId}> cancelled the active request.`
          : "There is no active request to cancel.",
        ...(cancelled ? { cancelledBy: message.requesterId } : {}),
      };
    }
    if (command) {
      const output = admission
        ? await this.options.agent.handleCommand(
            id,
            message.requesterId,
            command,
            observer,
            admission,
          )
        : await this.options.agent.handleCommand(id, message.requesterId, command, observer);
      return { outcome: "success", finalOutput: output };
    }
    let directMessages = 0;
    let scheduleChanges = 0;
    let automationChanges = 0;
    const countScheduleChange = () => {
      if (++scheduleChanges > 5) throw new Error("At most 5 schedule changes per request");
    };
    const request = {
      conversationId: id,
      requesterId: message.requesterId,
      prompt: message.prompt,
      ...(attachments.length > 0 ? { attachments } : {}),
      context: {
        ...(message.threadTs
          ? {
              readThreadHistory: (options: ThreadHistoryOptions, signal?: AbortSignal) =>
                this.readThreadHistoryPage(message.channel, message.threadTs!, options, signal),
            }
          : {}),
        ...(this.options.schedules
          ? {
              schedules: {
                list: () =>
                  this.options.schedules!.list(
                    message.requesterId,
                    this.options.operatorUserIds?.has(message.requesterId),
                  ),
                create: (input: import("./schedules.ts").ScheduleInput) => {
                  countScheduleChange();
                  return this.options.schedules!.create(
                    { ...input, userId: input.userId || message.requesterId },
                    message.requesterId,
                  );
                },
                update: (scheduleId: string, input: import("./schedules.ts").ScheduleInput) => {
                  countScheduleChange();
                  return this.options.schedules!.update(
                    scheduleId,
                    input,
                    message.requesterId,
                    this.options.operatorUserIds?.has(message.requesterId),
                  );
                },
                cancel: (scheduleId: string) => {
                  countScheduleChange();
                  return this.options.schedules!.cancel(
                    scheduleId,
                    message.requesterId,
                    this.options.operatorUserIds?.has(message.requesterId),
                  );
                },
              },
            }
          : {}),
        ...(this.options.automations
          ? {
              automations: {
                list: () =>
                  this.options.automations!.list(
                    message.requesterId,
                    this.options.operatorUserIds?.has(message.requesterId),
                  ),
                create: (input: import("./automations.ts").AutomationInput) => {
                  if (++automationChanges > 5)
                    throw new Error("At most 5 automation changes per request");
                  return this.options.automations!.create(input, message.requesterId);
                },
                pause: (automationId: string) => {
                  if (++automationChanges > 5)
                    throw new Error("At most 5 automation changes per request");
                  return this.options.automations!.pause(
                    automationId,
                    message.requesterId,
                    this.options.operatorUserIds?.has(message.requesterId),
                  );
                },
                resume: (automationId: string) => {
                  if (++automationChanges > 5)
                    throw new Error("At most 5 automation changes per request");
                  return this.options.automations!.resume(
                    automationId,
                    message.requesterId,
                    this.options.operatorUserIds?.has(message.requesterId),
                  );
                },
                cancel: (automationId: string) => {
                  if (++automationChanges > 5)
                    throw new Error("At most 5 automation changes per request");
                  return this.options.automations!.cancel(
                    automationId,
                    message.requesterId,
                    this.options.operatorUserIds?.has(message.requesterId),
                  );
                },
              },
            }
          : {}),
        sendDirectMessage: async (directMessage: DirectMessage, signal?: AbortSignal) => {
          if (++directMessages > MAX_DIRECT_MESSAGES_PER_REQUEST) {
            throw new Error(
              `At most ${MAX_DIRECT_MESSAGES_PER_REQUEST} direct messages can be sent per request`,
            );
          }
          return this.sendDirectMessage(directMessage, message.requesterId, signal);
        },
      },
    };
    const output = admission
      ? await this.options.agent.run(request, observer, admission)
      : await this.options.agent.run(request, observer);
    return { outcome: "success", finalOutput: output };
  }

  private isExpectedAgentError(error: unknown): boolean {
    return (
      error instanceof ConversationQueueFullError ||
      error instanceof GlobalQueueFullError ||
      error instanceof RequesterLimitError ||
      error instanceof RateLimitError ||
      error instanceof AgentTimeoutError ||
      error instanceof QueueWaitTimeoutError
    );
  }

  private async deliverRequest(
    client: App["client"],
    message: InboundSlackMessage,
    execution: ExecutionResult,
  ): Promise<DeliveryResult> {
    let delivery = execution.delivery ?? { outcome: "failure", publishedMessages: 0 };
    if (execution.finalOutput !== undefined) {
      const allowedUserMentions = new Set([
        ...slackUserMentions(message.prompt),
        `<@${message.requesterId}>`,
      ]);
      if (message.threadTs) {
        const unresolvedMentions = new Set(
          [...slackUserMentions(execution.finalOutput)].filter(
            (mention) => !allowedUserMentions.has(mention),
          ),
        );
        for (const mention of await this.explicitThreadUserMentions(
          message.channel,
          message.threadTs,
          unresolvedMentions,
        )) {
          allowedUserMentions.add(mention);
        }
      }
      delivery = await this.publishResult(
        client,
        message.channel,
        message.threadTs,
        execution.finalOutput,
        allowedUserMentions,
      );
      if (delivery.outcome !== "success") {
        this.reportOperatorError(
          "Slack result delivery failure",
          message.requestId,
          delivery.errorType ?? "UnknownDeliveryError",
        );
      }
    }
    const successful = execution.outcome === "success" && delivery.outcome === "success";
    if (delivery.outcome === "success") this.options.health?.recordSlackDeliverySuccess();
    else if (execution.finalOutput !== undefined) this.options.health?.recordSlackDeliveryFailure();
    if (!successful) {
      await this.bestEffortSlackOperation(
        client.reactions.add({
          channel: message.channel,
          timestamp: message.messageTs,
          name: "x",
        }),
      );
    }
    if (successful) await this.addRandomWorkspaceReaction(client, message);
    return delivery;
  }

  private async addRandomWorkspaceReaction(
    client: App["client"],
    message: InboundSlackMessage,
  ): Promise<void> {
    const random = this.options.random ?? Math.random;
    if (this.workspaceEmojiNames.length === 0 || random() >= WORKSPACE_REACTION_PROBABILITY) return;
    const name = this.workspaceEmojiNames[Math.floor(random() * this.workspaceEmojiNames.length)];
    if (!name) return;
    await this.bestEffortSlackOperation(
      client.reactions.add({
        channel: message.channel,
        timestamp: message.messageTs,
        name,
      }),
    );
  }

  private recordRequest(
    message: InboundSlackMessage,
    status: RequestStatus,
    execution: ExecutionResult,
    delivery: DeliveryResult,
    startedAt: number,
  ): void {
    (this.options.log ?? writeStructuredLog)({
      event: "agent_request_completed",
      request_id: message.requestId,
      user: message.requesterId,
      conversation: conversationId(message.channel, message.threadTs),
      duration_ms: Math.round(performance.now() - startedAt),
      tool_count: status.toolCount(),
      execution_outcome: execution.outcome,
      delivery_outcome: delivery.outcome,
      published_messages: delivery.publishedMessages,
      ...(execution.cancelledBy ? { cancelled_by: execution.cancelledBy } : {}),
    });
  }

  /** Allows only mentions that an authorized user previously wrote in this thread. */
  private async explicitThreadUserMentions(
    channel: string,
    threadTs: string,
    requestedMentions: ReadonlySet<string>,
  ): Promise<ReadonlySet<string>> {
    const found = new Set<string>();
    if (requestedMentions.size === 0) return found;

    let cursor: string | undefined;
    do {
      const response = await this.bestEffortSlackOperation(
        this.app.client.conversations.replies({
          channel,
          ts: threadTs,
          limit: 100,
          ...(cursor ? { cursor } : {}),
        }),
      );
      if (!response || !Array.isArray(response.messages)) return found;
      for (const message of response.messages as SlackHistoryMessage[]) {
        if (!message.user || message.bot_id || !this.options.allowedUserIds.has(message.user)) {
          continue;
        }
        for (const mention of slackUserMentions(message.text ?? "")) {
          if (requestedMentions.has(mention)) found.add(mention);
        }
      }
      cursor = response.response_metadata?.next_cursor || undefined;
    } while (cursor && found.size < requestedMentions.size);

    return found;
  }

  private async publishResult(
    client: App["client"],
    channel: string,
    threadTs: string | undefined,
    output: string,
    allowedUserMentions: ReadonlySet<string>,
  ): Promise<DeliveryResult> {
    const [first, ...rest] = splitSlackMessage(formatSlackText(output, allowedUserMentions));
    let publishedMessages = 0;
    try {
      await this.chatOperation(() =>
        client.chat.postMessage({ channel, thread_ts: threadTs, text: first }),
      );
      publishedMessages++;
    } catch (error) {
      return { outcome: "failure", publishedMessages, errorType: errorType(error) };
    }
    for (const text of rest) {
      try {
        await this.chatOperation(() =>
          client.chat.postMessage({ channel, thread_ts: threadTs, text }),
        );
        publishedMessages++;
      } catch (error) {
        return { outcome: "partial", publishedMessages, errorType: errorType(error) };
      }
    }
    return { outcome: "success", publishedMessages, postedText: rest.at(-1) ?? first };
  }
}
