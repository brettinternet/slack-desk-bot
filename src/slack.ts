import { App, LogLevel } from "@slack/bolt";
import {
  AgentCancelledError,
  AgentTimeoutError,
  ConversationQueueFullError,
  GlobalQueueFullError,
  QueueWaitTimeoutError,
  RateLimitError,
  RequesterLimitError,
  type CancellableAgentBackend,
} from "./agent.ts";
import { EventDeduplicator } from "./event-deduplicator.ts";
import { ingestSlackFiles } from "./slack-files.ts";
import { type LogWriter, writeStructuredLog } from "./log.ts";
import {
  conversationId,
  HELP_MESSAGE,
  isSupportedDirectMessage,
  parseSlackCommand,
  splitSlackMessage,
  stripBotMention,
} from "./messages.ts";

interface SlackAgentOptions {
  botToken: string;
  appToken: string;
  allowedUserIds: ReadonlySet<string>;
  agent: CancellableAgentBackend;
  fetch?: typeof fetch;
  log?: LogWriter;
  operatorError?: (message: string, context: { requestId: string; errorType: string }) => void;
}

interface SlackFileReference {
  id?: string;
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

export class SlackAgent {
  private readonly app: App;
  private readonly events = new EventDeduplicator();
  private botUserId = "";

  constructor(private readonly options: SlackAgentOptions) {
    this.app = new App({
      token: options.botToken,
      appToken: options.appToken,
      socketMode: true,
      logLevel: LogLevel.INFO,
    });

    this.app.event("app_mention", async ({ body, event, client }) => {
      if (!event.user || event.bot_id) return;
      const threadTs = event.thread_ts ?? event.ts;
      if (!this.options.allowedUserIds.has(event.user)) {
        await this.deny(client, event.channel, threadTs);
        return;
      }
      const prompt = stripBotMention(event.text, this.botUserId);
      const files = eventFiles(event);
      if (
        (!prompt && files.length === 0) ||
        !this.acceptEvent(body.event_id, event.channel, event.ts, event.client_msg_id)
      )
        return;
      await this.respond(
        client,
        body.event_id,
        event.channel,
        event.ts,
        threadTs,
        event.user,
        prompt,
        files,
      );
    });

    this.app.event("message", async ({ body, event, client }) => {
      if (
        event.channel_type !== "im" ||
        !isSupportedDirectMessage(event.subtype) ||
        !("user" in event) ||
        !event.user
      )
        return;
      if (!this.options.allowedUserIds.has(event.user)) {
        await this.deny(client, event.channel, undefined);
        return;
      }
      const text = "text" in event ? (event.text ?? "") : "";
      const files = eventFiles(event);
      const clientMessageId = "client_msg_id" in event ? event.client_msg_id : undefined;
      if (
        (!text && files.length === 0) ||
        !this.acceptEvent(body.event_id, event.channel, event.ts, clientMessageId)
      )
        return;
      await this.respond(
        client,
        body.event_id,
        event.channel,
        event.ts,
        undefined,
        event.user,
        text,
        files,
      );
    });
  }

  async start(): Promise<void> {
    const authentication = await this.app.client.auth.test({ token: this.options.botToken });
    if (!authentication.user_id) throw new Error("Slack auth.test did not return a bot user ID");
    this.botUserId = authentication.user_id;
    await this.app.start();
    console.log("SlackDeskBot connected");
  }

  async stop(): Promise<void> {
    this.options.agent.dispose();
    await this.app.stop();
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

  private async deny(
    client: App["client"],
    channel: string,
    threadTs: string | undefined,
  ): Promise<void> {
    console.warn(`Rejected unauthorized Slack request in channel ${channel}`);
    await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: "You are not authorized to use this agent.",
    });
  }

  private async respond(
    client: App["client"],
    requestId: string,
    channel: string,
    messageTs: string,
    threadTs: string | undefined,
    requesterId: string,
    prompt: string,
    files: readonly SlackFileReference[],
  ): Promise<void> {
    const command = files.length === 0 ? parseSlackCommand(prompt) : undefined;
    if (command?.kind === "help" || command?.kind === "unknown") {
      await client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text:
          command.kind === "help"
            ? HELP_MESSAGE
            : "Unknown command. Send `!help` to see supported commands.",
      });
      return;
    }

    const id = conversationId(channel, threadTs);
    const startedAt = performance.now();
    let toolCount = 0;
    let outcome: "success" | "cancelled" | "error" = "error";

    await client.reactions.add({ channel, timestamp: messageTs, name: "eyes" }).catch(() => {});
    const status = await client.chat
      .postMessage({ channel, thread_ts: threadTs, text: "Working…" })
      .catch(() => undefined);
    const statusTs = status?.ts;

    try {
      const { attachments, warnings } = await ingestSlackFiles(
        client,
        this.options.botToken,
        files,
        this.options.fetch,
      );
      for (const warning of warnings) {
        await client.chat.postMessage({ channel, thread_ts: threadTs, text: warning });
      }
      if (!prompt && attachments.length === 0) {
        if (statusTs) await client.chat.delete({ channel, ts: statusTs }).catch(() => {});
        outcome = "success";
        return;
      }

      const agentCommand = attachments.length === 0 ? command?.command : undefined;
      const output = agentCommand
        ? await this.options.agent.handleCommand(id, requesterId, agentCommand)
        : await this.options.agent.run(
            {
              conversationId: id,
              requesterId,
              prompt,
              ...(attachments.length > 0 ? { attachments } : {}),
            },
            { onToolUse: () => toolCount++ },
          );
      await this.publishResult(client, channel, threadTs, statusTs, output);
      outcome = "success";
      await client.reactions
        .add({ channel, timestamp: messageTs, name: "white_check_mark" })
        .catch(() => {});
    } catch (error) {
      const cancelled = error instanceof AgentCancelledError;
      outcome = cancelled ? "cancelled" : "error";
      const expected =
        cancelled ||
        error instanceof ConversationQueueFullError ||
        error instanceof GlobalQueueFullError ||
        error instanceof RequesterLimitError ||
        error instanceof RateLimitError ||
        error instanceof AgentTimeoutError ||
        error instanceof QueueWaitTimeoutError;
      if (!expected) {
        (this.options.operatorError ?? ((message, context) => console.error(message, context)))(
          "Unexpected agent request failure",
          { requestId, errorType: errorType(error) },
        );
      }
      await this.publishResult(
        client,
        channel,
        threadTs,
        statusTs,
        userFacingAgentError(error, requestId),
      );
      await client.reactions.add({ channel, timestamp: messageTs, name: "x" }).catch(() => {});
    } finally {
      await client.reactions
        .remove({ channel, timestamp: messageTs, name: "eyes" })
        .catch(() => {});
      (this.options.log ?? writeStructuredLog)({
        event: "agent_request_completed",
        request_id: requestId,
        user: requesterId,
        conversation: id,
        duration_ms: Math.round(performance.now() - startedAt),
        tool_count: toolCount,
        outcome,
      });
    }
  }

  private async publishResult(
    client: App["client"],
    channel: string,
    threadTs: string | undefined,
    statusTs: string | undefined,
    output: string,
  ): Promise<void> {
    const [first, ...rest] = splitSlackMessage(output);
    let updated = false;
    if (statusTs) {
      updated = await client.chat
        .update({ channel, ts: statusTs, text: first })
        .then(() => true)
        .catch(() => false);
    }
    if (!updated) {
      await client.chat.postMessage({ channel, thread_ts: threadTs, text: first });
    }
    for (const text of rest) {
      await client.chat.postMessage({ channel, thread_ts: threadTs, text });
    }
  }
}
