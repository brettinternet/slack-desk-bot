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
} from "./agent.ts";
import { EventDeduplicator } from "./event-deduplicator.ts";
import { ingestSlackFiles } from "./slack-files.ts";
import { type LogWriter, type RequestLogWriter, writeStructuredLog } from "./log.ts";
import { type HealthState } from "./health.ts";
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
} from "./messages.ts";

interface SlackAgentOptions {
  botToken: string;
  appToken: string;
  allowedUserIds: ReadonlySet<string>;
  operatorUserIds?: ReadonlySet<string>;
  agent: CancellableAgentBackend;
  fetch?: typeof fetch;
  log?: RequestLogWriter;
  operatorLog?: LogWriter;
  operatorError?: (message: string, context: { requestId: string; errorType: string }) => void;
  statusUpdateIntervalMs?: number;
  health?: HealthState;
  random?: () => number;
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
const WORKING_STATUS_MESSAGES = [
  { started: "On it…", ongoing: "Still on it…" },
  { started: "Looking…", ongoing: "Still looking…" },
  { started: "Digging in…", ongoing: "Still digging…" },
  { started: "Taking a look…", ongoing: "Still at it…" },
  { started: "Working on it…", ongoing: "Still working…" },
  { started: "Checking…", ongoing: "Still checking…" },
  { started: "Investigating…", ongoing: "Still investigating…" },
  { started: "Reviewing…", ongoing: "Still reviewing…" },
  { started: "Thinking… 🤔", ongoing: "Still thinking… 🤔" },
  { started: "Looking now… 👀", ongoing: "Still looking… 👀" },
  { started: "One moment…", ongoing: "Still at it…" },
  { started: "Diving in…", ongoing: "Still diving…" },
] as const;

interface DeliveryResult {
  outcome: "success" | "partial" | "failure";
  publishedMessages: number;
  errorType?: string;
}

interface SlackFileReference {
  id?: string;
}

interface SlackHistoryMessage {
  ts?: string;
  user?: string;
  bot_id?: string;
  username?: string;
  text?: string;
  files?: Array<{ name?: string; title?: string; mimetype?: string }>;
}

interface InboundSlackMessage {
  requestId: string;
  channel: string;
  messageTs: string;
  threadTs: string | undefined;
  requesterId: string;
  prompt: string;
  files: readonly SlackFileReference[];
}

interface RequestStatus {
  statusTs: string | undefined;
  observer: AgentRunObserver;
  toolCount(): number;
  finish(): Promise<void>;
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
  private readonly denials = new EventDeduplicator();
  private readonly capacityReplies = new EventDeduplicator();
  private readonly missingConversations = new Map<string, number>();
  private readonly ownedChannelThreads = new Set<string>();
  private readonly awaitingThreadReplies = new Set<string>();
  private readonly receiver: SocketModeReceiver;
  private workspaceEmojiNames: string[] = [];
  private readonly userCache = new Map<string, ConversationParticipant>();
  private botUserId = "";
  private activeResponses = 0;
  private responseCapacityWarningLogged = false;

  constructor(private readonly options: SlackAgentOptions) {
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
      this.awaitingThreadReplies.delete(id);
      await this.respondWithinLimit(client, {
        requestId: body.event_id,
        channel: event.channel,
        messageTs: event.ts,
        threadTs,
        requesterId: event.user,
        prompt,
        files,
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
      if (!this.options.allowedUserIds.has(event.user)) {
        const clientMessageId = "client_msg_id" in event ? event.client_msg_id : undefined;
        if (this.acceptEvent(body.event_id, event.channel, event.ts, clientMessageId)) {
          await this.deny(client, event.channel, threadTs, event.user, event.ts);
        }
        return;
      }
      const rawText = "text" in event ? (event.text ?? "") : "";
      const id = conversationId(event.channel, threadTs);
      const intent = directMessage
        ? { prompt: rawText, respond: true }
        : channelThreadIntent(rawText, this.botUserId, this.awaitingThreadReplies.has(id));
      const files = eventFiles(event);
      const clientMessageId = "client_msg_id" in event ? event.client_msg_id : undefined;
      if (
        (!intent.prompt && files.length === 0) ||
        (!intent.respond && intent.prompt.length > 0) ||
        !this.acceptEvent(body.event_id, event.channel, event.ts, clientMessageId)
      )
        return;
      this.awaitingThreadReplies.delete(id);
      await this.respondWithinLimit(client, {
        requestId: body.event_id,
        channel: event.channel,
        messageTs: event.ts,
        threadTs,
        requesterId: event.user,
        prompt: intent.prompt,
        files,
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
    await this.loadWorkspaceEmoji();
    await this.app.start();
    (this.options.operatorLog ?? writeStructuredLog)({
      event: "startup",
      component: "slack",
      outcome: "connected",
    });
  }

  async stop(): Promise<void> {
    await this.app.stop();
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
      await this.reportCapacityDrop(client, message);
      return;
    }

    this.activeResponses++;
    try {
      await this.respond(client, message);
    } finally {
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
    const status = await this.createRequestStatus(client, message);
    const execution = await this.executeRequest(client, message, command, admission, status);
    const delivery = await this.deliverRequest(client, message, status, execution);
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
      delivery.outcome !== "failure" &&
      execution.finalOutput &&
      awaitsThreadReply(execution.finalOutput)
    ) {
      this.awaitingThreadReplies.add(id);
    } else {
      this.awaitingThreadReplies.delete(id);
    }
  }

  private async createRequestStatus(
    client: App["client"],
    message: InboundSlackMessage,
  ): Promise<RequestStatus> {
    const random = this.options.random ?? Math.random;
    const statusMessage =
      WORKING_STATUS_MESSAGES[Math.floor(random() * WORKING_STATUS_MESSAGES.length)] ??
      WORKING_STATUS_MESSAGES[0];
    const response = await this.bestEffortChatOperation(() =>
      client.chat.postMessage({
        channel: message.channel,
        thread_ts: message.threadTs,
        text: "Queued…",
      }),
    );
    const statusTs = response?.ts;
    let statusUpdates = Promise.resolve();
    let feedbackTimer: ReturnType<typeof setInterval> | undefined;
    let runStartedAt = performance.now();
    let toolCount = 0;
    const update = (text: string): void => {
      if (!statusTs) return;
      statusUpdates = statusUpdates.then(async () => {
        await this.bestEffortChatOperation(() =>
          client.chat.update({ channel: message.channel, ts: statusTs, text }),
        );
      });
    };
    return {
      statusTs,
      observer: {
        onQueued: () => {},
        onStarted: () => {
          runStartedAt = performance.now();
          update(statusMessage.started);
          feedbackTimer = setInterval(() => {
            const elapsed = Math.max(1, Math.floor((performance.now() - runStartedAt) / 1_000));
            update(
              `${statusMessage.ongoing} ${elapsed}s elapsed · ${toolCount} tool ${toolCount === 1 ? "use" : "uses"}`,
            );
          }, this.options.statusUpdateIntervalMs ?? 30_000);
          feedbackTimer.unref();
        },
        onToolUse: () => toolCount++,
      },
      toolCount: () => toolCount,
      finish: async () => {
        if (feedbackTimer) clearInterval(feedbackTimer);
        await statusUpdates;
      },
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
    } finally {
      await status.finish();
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
      if (status.statusTs) {
        await this.bestEffortSlackOperation(
          client.chat.delete({ channel: message.channel, ts: status.statusTs }),
        );
      }
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
    const request = {
      conversationId: id,
      requesterId: message.requesterId,
      prompt: message.prompt,
      ...(attachments.length > 0 ? { attachments } : {}),
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
    status: RequestStatus,
    execution: ExecutionResult,
  ): Promise<DeliveryResult> {
    let delivery = execution.delivery ?? { outcome: "failure", publishedMessages: 0 };
    if (execution.finalOutput !== undefined) {
      delivery = await this.publishResult(
        client,
        message.channel,
        message.threadTs,
        status.statusTs,
        execution.finalOutput,
        new Set([...slackUserMentions(message.prompt), `<@${message.requesterId}>`]),
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

  private async publishResult(
    client: App["client"],
    channel: string,
    threadTs: string | undefined,
    statusTs: string | undefined,
    output: string,
    allowedUserMentions: ReadonlySet<string>,
  ): Promise<DeliveryResult> {
    const [first, ...rest] = splitSlackMessage(formatSlackText(output, allowedUserMentions));
    let publishedMessages = 0;
    let updated = false;
    if (statusTs) {
      try {
        await this.chatOperation(() => client.chat.update({ channel, ts: statusTs, text: first }));
        updated = true;
        publishedMessages++;
      } catch {}
    }
    if (!updated) {
      try {
        await this.chatOperation(() =>
          client.chat.postMessage({ channel, thread_ts: threadTs, text: first }),
        );
        publishedMessages++;
      } catch (error) {
        return { outcome: "failure", publishedMessages, errorType: errorType(error) };
      }
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
    return { outcome: "success", publishedMessages };
  }
}
