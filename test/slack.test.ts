import { describe, expect, mock, test } from "bun:test";
import {
  AgentCancelledError,
  AgentTimeoutError,
  ConversationQueueFullError,
  GlobalQueueFullError,
  QueueWaitTimeoutError,
  RateLimitError,
  RequesterLimitError,
  type AgentBackend,
  type AgentRunObserver,
  type CancellableAgentBackend,
  type QueueLimits,
  QueuedAgentBackend,
} from "../src/agent.ts";
import type { RequestLog } from "../src/log.ts";

interface SlackEventHandler {
  (input: {
    body: { event_id: string };
    event: Record<string, unknown>;
    client: SlackClient;
  }): Promise<void>;
}

interface SlackClient {
  chat: {
    postMessage: ReturnType<typeof mock>;
    update: ReturnType<typeof mock>;
    delete: ReturnType<typeof mock>;
  };
  reactions: { add: ReturnType<typeof mock>; remove: ReturnType<typeof mock> };
  files: { info: ReturnType<typeof mock> };
}

let app: MockSlackApp;

class MockSocketModeClient {
  private readonly listeners = new Map<string, Array<() => void>>();

  on(event: string, listener: () => void): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
  }

  emit(event: string): void {
    for (const listener of this.listeners.get(event) ?? []) listener();
  }
}

class MockSocketModeReceiver {
  readonly client = new MockSocketModeClient();

  constructor(_options: { appToken: string }) {}
}

class MockSlackApp {
  readonly handlers = new Map<string, SlackEventHandler>();
  readonly receiver: MockSocketModeReceiver;
  readonly client = {
    auth: { test: mock(async (): Promise<{ user_id?: string }> => ({ user_id: "U_BOT" })) },
  };
  readonly start = mock(async () => {});
  readonly stop = mock(async () => {});

  constructor(options: { receiver: MockSocketModeReceiver }) {
    this.receiver = options.receiver;
    app = this;
  }

  event(name: string, handler: SlackEventHandler): void {
    this.handlers.set(name, handler);
  }
}

mock.module("@slack/bolt", () => ({
  App: MockSlackApp,
  LogLevel: { INFO: "info" },
  SocketModeReceiver: MockSocketModeReceiver,
}));

const { SlackAgent, SlackAuthenticationError, userFacingAgentError } =
  await import("../src/slack.ts");
const { HealthState } = await import("../src/health.ts");

function client(): SlackClient {
  return {
    chat: {
      postMessage: mock(async () => ({ ts: "status-ts" })),
      update: mock(async () => ({})),
      delete: mock(async () => ({})),
    },
    reactions: { add: mock(async () => ({})), remove: mock(async () => ({})) },
    files: { info: mock(async () => ({ ok: true })) },
  };
}

function backend(run: ReturnType<typeof mock>): CancellableAgentBackend {
  return {
    run,
    handleCommand: async () => "command complete",
    cancelActive: () => false,
    dispose: () => {},
  };
}

function createAgent(run: ReturnType<typeof mock>): void {
  new SlackAgent({
    botToken: "xoxb-test",
    appToken: "xapp-test",
    allowedUserIds: new Set(["U_ALLOWED"]),
    agent: backend(run),
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function queueLimits(overrides: Partial<QueueLimits> = {}): QueueLimits {
  return {
    timeoutMs: 10_000,
    queueWaitMs: 10_000,
    maxQueuedPerConversation: 2,
    maxConcurrentConversations: 1,
    maxGlobalQueue: 20,
    maxPendingPerRequester: 10,
    rateLimitBurst: 20,
    rateLimitRefillMs: 60_000,
    ...overrides,
  };
}

describe("SlackAgent transport", () => {
  test("sanitizes rejected and incomplete Slack authentication", async () => {
    const token = "xoxb-test-secret";
    const agent = new SlackAgent({
      botToken: token,
      appToken: "xapp-test",
      allowedUserIds: new Set(["U_ALLOWED"]),
      agent: backend(mock(async () => "response")),
    });
    app.client.auth.test.mockImplementationOnce(async () => {
      throw new Error(`Slack rejected ${token}`);
    });

    let rejected: unknown;
    try {
      await agent.start();
    } catch (error) {
      rejected = error;
    }
    expect(rejected).toBeInstanceOf(SlackAuthenticationError);
    expect(String(rejected)).toContain("verify SLACK_BOT_TOKEN");
    expect(String(rejected)).not.toContain(token);
    expect(app.start).not.toHaveBeenCalled();

    const incomplete = new SlackAgent({
      botToken: token,
      appToken: "xapp-test",
      allowedUserIds: new Set(["U_ALLOWED"]),
      agent: backend(mock(async () => "response")),
    });
    app.client.auth.test.mockImplementationOnce(async () => ({}));
    await expect(incomplete.start()).rejects.toBeInstanceOf(SlackAuthenticationError);
    expect(app.start).not.toHaveBeenCalled();
  });

  test("tracks Socket Mode connection lifecycle transitions", () => {
    const health = new HealthState();
    new SlackAgent({
      botToken: "xoxb-test",
      appToken: "xapp-test",
      allowedUserIds: new Set(["U_ALLOWED"]),
      agent: backend(mock(async () => "response")),
      health,
    });

    app.receiver.client.emit("connected");
    expect(
      health.snapshot({
        active: 0,
        queued: 0,
        limits: { max_concurrent: 1, max_queued: 1 },
        saturated: false,
        backend_available: true,
      }).slack.connection,
    ).toBe("connected");
    app.receiver.client.emit("reconnecting");
    expect(
      health.snapshot({
        active: 0,
        queued: 0,
        limits: { max_concurrent: 1, max_queued: 1 },
        saturated: false,
        backend_available: true,
      }).status,
    ).toBe("degraded");
    app.receiver.client.emit("disconnected");
    expect(
      health.snapshot({
        active: 0,
        queued: 0,
        limits: { max_concurrent: 1, max_queued: 1 },
        saturated: false,
        backend_available: true,
      }).status,
    ).toBe("unhealthy");
  });

  test("degrades readiness after three result delivery failures", async () => {
    const health = new HealthState();
    new SlackAgent({
      botToken: "xoxb-test",
      appToken: "xapp-test",
      allowedUserIds: new Set(["U_ALLOWED"]),
      agent: backend(mock(async () => "response")),
      health,
    });
    app.receiver.client.emit("connected");
    const slack = client();
    slack.chat.update.mockImplementation(async () => {
      throw new Error("update unavailable");
    });
    slack.chat.postMessage.mockImplementation(async (message: { text: string }) => {
      if (message.text === "Queued…") return { ts: "status-ts" };
      throw new Error("post unavailable");
    });

    for (const eventId of ["E_DELIVERY_1", "E_DELIVERY_2", "E_DELIVERY_3"]) {
      await app.handlers.get("app_mention")!({
        body: { event_id: eventId },
        event: { user: "U_ALLOWED", text: "request", channel: "C1", ts: eventId },
        client: slack,
      });
    }

    expect(
      health.snapshot({
        active: 0,
        queued: 0,
        limits: { max_concurrent: 1, max_queued: 1 },
        saturated: false,
        backend_available: true,
      }),
    ).toMatchObject({
      status: "degraded",
      slack: { consecutive_delivery_failures: 3 },
    });
  });

  test("filters unsupported and empty events", async () => {
    const run = mock(async () => "response");
    createAgent(run);
    const slack = client();
    const mention = app.handlers.get("app_mention")!;
    const message = app.handlers.get("message")!;

    await mention({
      body: { event_id: "E_BOT" },
      event: { user: "U_ALLOWED", bot_id: "B1", text: "request", channel: "C1", ts: "1" },
      client: slack,
    });
    await mention({
      body: { event_id: "E_NO_USER" },
      event: { text: "request", channel: "C1", ts: "2" },
      client: slack,
    });
    await mention({
      body: { event_id: "E_EMPTY" },
      event: { user: "U_ALLOWED", text: "", channel: "C1", ts: "3" },
      client: slack,
    });
    await message({
      body: { event_id: "E_CHANNEL" },
      event: {
        channel_type: "channel",
        user: "U_ALLOWED",
        text: "request",
        channel: "C1",
        ts: "4",
      },
      client: slack,
    });
    await message({
      body: { event_id: "E_SUBTYPE" },
      event: {
        channel_type: "im",
        subtype: "bot_message",
        user: "U_ALLOWED",
        text: "request",
        channel: "D1",
        ts: "5",
      },
      client: slack,
    });
    await message({
      body: { event_id: "E_DM_NO_USER" },
      event: { channel_type: "im", text: "request", channel: "D1", ts: "6" },
      client: slack,
    });

    expect(run).not.toHaveBeenCalled();
    expect(slack.chat.postMessage).not.toHaveBeenCalled();
    expect(slack.reactions.add).not.toHaveBeenCalled();
  });

  test("rejects unauthorized mentions before invoking the backend", async () => {
    const run = mock(async () => "response");
    new SlackAgent({
      botToken: "xoxb-test",
      appToken: "xapp-test",
      allowedUserIds: new Set(["U_ALLOWED"]),
      agent: backend(run),
    });
    const slack = client();

    await app.handlers.get("app_mention")!({
      body: { event_id: "E1" },
      event: { user: "U_DENIED", text: "request", channel: "C1", ts: "1" },
      client: slack,
    });

    expect(run).not.toHaveBeenCalled();
    expect(slack.reactions.add).not.toHaveBeenCalled();
    expect(slack.chat.postMessage).toHaveBeenCalledWith({
      channel: "C1",
      thread_ts: "1",
      text: "You are not authorized to use this agent.",
    });

    await app.handlers.get("app_mention")!({
      body: { event_id: "E2" },
      event: { user: "U_DENIED", text: "again", channel: "C1", ts: "2", thread_ts: "1" },
      client: slack,
    });
    expect(slack.chat.postMessage).toHaveBeenCalledTimes(1);
  });

  test("handles help and unknown commands without invoking the backend", async () => {
    const run = mock(async () => "response");
    createAgent(run);
    const slack = client();

    await app.handlers.get("app_mention")!({
      body: { event_id: "E_HELP_CHANNEL" },
      event: { user: "U_ALLOWED", text: "!HeLp", channel: "C1", ts: "1" },
      client: slack,
    });
    await app.handlers.get("message")!({
      body: { event_id: "E_HELP_DM" },
      event: {
        channel_type: "im",
        user: "U_ALLOWED",
        text: "  !help ",
        channel: "D1",
        ts: "2",
      },
      client: slack,
    });
    await app.handlers.get("message")!({
      body: { event_id: "E_UNKNOWN_DM" },
      event: { channel_type: "im", user: "U_ALLOWED", text: "!stats", channel: "D1", ts: "3" },
      client: slack,
    });

    expect(run).not.toHaveBeenCalled();
    expect(slack.reactions.add).not.toHaveBeenCalled();
    expect(slack.chat.update).not.toHaveBeenCalled();
    expect(slack.chat.postMessage).toHaveBeenCalledTimes(3);
    expect(slack.chat.postMessage.mock.calls[0]?.[0]).toMatchObject({
      channel: "C1",
      thread_ts: "1",
      text: expect.stringContaining("!status"),
    });
    expect(slack.chat.postMessage.mock.calls[1]?.[0]).toMatchObject({
      channel: "D1",
      thread_ts: undefined,
      text: expect.stringContaining("mention the bot"),
    });
    expect(slack.chat.postMessage.mock.calls[2]?.[0]).toEqual({
      channel: "D1",
      thread_ts: undefined,
      text: "Unknown command. Send `!help` to see supported commands.",
    });
  });

  test("allows configured users to invoke the backend", async () => {
    const run = mock(async () => "response");
    new SlackAgent({
      botToken: "xoxb-test",
      appToken: "xapp-test",
      allowedUserIds: new Set(["U_ALLOWED"]),
      agent: backend(run),
    });
    const slack = client();

    await app.handlers.get("app_mention")!({
      body: { event_id: "E2" },
      event: { user: "U_ALLOWED", text: "request", channel: "C1", ts: "1" },
      client: slack,
    });

    expect(run).toHaveBeenCalledWith(
      {
        conversationId: "C1:1",
        requesterId: "U_ALLOWED",
        prompt: "request",
      },
      {
        onQueued: expect.any(Function),
        onStarted: expect.any(Function),
        onToolUse: expect.any(Function),
      },
    );
    expect(slack.chat.postMessage).toHaveBeenCalledWith({
      channel: "C1",
      thread_ts: "1",
      text: "Queued…",
    });
    expect(slack.chat.update).toHaveBeenCalledWith({
      channel: "C1",
      ts: "status-ts",
      text: "response",
    });
    expect(slack.reactions.add).toHaveBeenCalledWith({
      channel: "C1",
      timestamp: "1",
      name: "white_check_mark",
    });
    expect(slack.reactions.remove).toHaveBeenCalledWith({
      channel: "C1",
      timestamp: "1",
      name: "eyes",
    });
  });

  test("logs request metadata and tool count without prompt contents", async () => {
    const records: RequestLog[] = [];
    const run = mock(async (_request: unknown, observer?: AgentRunObserver) => {
      observer?.onToolUse();
      observer?.onToolUse();
      return "response";
    });
    new SlackAgent({
      botToken: "xoxb-test",
      appToken: "xapp-test",
      allowedUserIds: new Set(["U_ALLOWED"]),
      agent: backend(run),
      log: (record) => records.push(record),
    });

    await app.handlers.get("app_mention")!({
      body: { event_id: "E_LOGGED" },
      event: {
        user: "U_ALLOWED",
        text: "secret prompt contents",
        channel: "C1",
        ts: "1",
      },
      client: client(),
    });

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      event: "agent_request_completed",
      request_id: "E_LOGGED",
      user: "U_ALLOWED",
      conversation: "C1:1",
      tool_count: 2,
      execution_outcome: "success",
      delivery_outcome: "success",
      published_messages: 1,
    });
    expect(records[0]!.duration_ms).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(records[0])).not.toContain("secret prompt contents");
  });

  test("routes existing threads and direct messages to stable conversations", async () => {
    const run = mock(async () => "response");
    createAgent(run);
    const slack = client();

    await app.handlers.get("app_mention")!({
      body: { event_id: "E_THREAD" },
      event: {
        user: "U_ALLOWED",
        text: "thread request",
        channel: "C1",
        ts: "2",
        thread_ts: "1",
      },
      client: slack,
    });
    await app.handlers.get("message")!({
      body: { event_id: "E_DM" },
      event: {
        channel_type: "im",
        user: "U_ALLOWED",
        text: "dm request",
        channel: "D1",
        ts: "3",
      },
      client: slack,
    });

    expect(run).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenCalledWith(
      {
        conversationId: "C1:1",
        requesterId: "U_ALLOWED",
        prompt: "thread request",
      },
      {
        onQueued: expect.any(Function),
        onStarted: expect.any(Function),
        onToolUse: expect.any(Function),
      },
    );
    expect(run).toHaveBeenCalledWith(
      {
        conversationId: "dm:D1",
        requesterId: "U_ALLOWED",
        prompt: "dm request",
      },
      {
        onQueued: expect.any(Function),
        onStarted: expect.any(Function),
        onToolUse: expect.any(Function),
      },
    );
    expect(slack.chat.postMessage.mock.calls[0]?.[0]).toEqual({
      channel: "C1",
      thread_ts: "1",
      text: "Queued…",
    });
    expect(slack.chat.postMessage.mock.calls[1]?.[0]).toEqual({
      channel: "D1",
      thread_ts: undefined,
      text: "Queued…",
    });
  });

  test("accepts mention-free replies only in allowlisted mention-owned channel threads", async () => {
    const run = mock(async () => "response");
    createAgent(run);
    const slack = client();
    const mention = app.handlers.get("app_mention")!;
    const message = app.handlers.get("message")!;

    await message({
      body: { event_id: "E_UNRELATED_ROOT" },
      event: {
        channel_type: "channel",
        user: "U_ALLOWED",
        text: "unrelated root",
        channel: "C1",
        ts: "1",
      },
      client: slack,
    });
    await message({
      body: { event_id: "E_UNRELATED_THREAD" },
      event: {
        channel_type: "channel",
        user: "U_ALLOWED",
        text: "unrelated reply",
        channel: "C1",
        ts: "2",
        thread_ts: "1",
      },
      client: slack,
    });
    await mention({
      body: { event_id: "E_OWN_THREAD" },
      event: { user: "U_ALLOWED", text: "start", channel: "C1", ts: "3" },
      client: slack,
    });
    await message({
      body: { event_id: "E_FOLLOW_UP" },
      event: {
        channel_type: "channel",
        user: "U_ALLOWED",
        text: "follow up",
        channel: "C1",
        ts: "4",
        thread_ts: "3",
      },
      client: slack,
    });
    await message({
      body: { event_id: "E_BROADCAST_FOLLOW_UP" },
      event: {
        channel_type: "channel",
        subtype: "thread_broadcast",
        user: "U_ALLOWED",
        text: "broadcast follow up",
        channel: "C1",
        ts: "5",
        thread_ts: "3",
      },
      client: slack,
    });

    expect(run).toHaveBeenCalledTimes(3);
    expect(run).toHaveBeenLastCalledWith(
      {
        conversationId: "C1:3",
        requesterId: "U_ALLOWED",
        prompt: "broadcast follow up",
      },
      {
        onQueued: expect.any(Function),
        onStarted: expect.any(Function),
        onToolUse: expect.any(Function),
      },
    );
  });

  test("filters unsafe events in owned channel threads", async () => {
    const run = mock(async () => "response");
    createAgent(run);
    const slack = client();
    const mention = app.handlers.get("app_mention")!;
    const message = app.handlers.get("message")!;

    await mention({
      body: { event_id: "E_OWN_SAFE_THREAD" },
      event: { user: "U_ALLOWED", text: "start", channel: "C1", ts: "10" },
      client: slack,
    });
    for (const [eventId, event] of [
      [
        "E_BOT_REPLY",
        {
          channel_type: "channel",
          user: "U_ALLOWED",
          bot_id: "B1",
          text: "bot reply",
          channel: "C1",
          ts: "11",
          thread_ts: "10",
        },
      ],
      [
        "E_EDITED_REPLY",
        {
          channel_type: "channel",
          subtype: "message_changed",
          user: "U_ALLOWED",
          text: "edited reply",
          channel: "C1",
          ts: "12",
          thread_ts: "10",
        },
      ],
    ] as const) {
      await message({ body: { event_id: eventId }, event, client: slack });
    }
    await message({
      body: { event_id: "E_DENIED_REPLY" },
      event: {
        channel_type: "channel",
        user: "U_DENIED",
        text: "denied reply",
        channel: "C1",
        ts: "13",
        thread_ts: "10",
      },
      client: slack,
    });

    expect(run).toHaveBeenCalledTimes(1);
    expect(slack.chat.postMessage).toHaveBeenCalledWith({
      channel: "C1",
      thread_ts: "10",
      text: "You are not authorized to use this agent.",
    });
  });

  test("requires a new mention to restore channel-thread ownership after restart", async () => {
    const firstRun = mock(async () => "first response");
    createAgent(firstRun);
    const slack = client();
    await app.handlers.get("app_mention")!({
      body: { event_id: "E_BEFORE_RESTART" },
      event: { user: "U_ALLOWED", text: "start", channel: "C1", ts: "20" },
      client: slack,
    });

    const restartedRun = mock(async () => "restarted response");
    createAgent(restartedRun);
    const restartedMention = app.handlers.get("app_mention")!;
    const restartedMessage = app.handlers.get("message")!;
    const reply = {
      channel_type: "channel",
      user: "U_ALLOWED",
      text: "follow up",
      channel: "C1",
      ts: "21",
      thread_ts: "20",
    };
    await restartedMessage({
      body: { event_id: "E_IGNORED_AFTER_RESTART" },
      event: reply,
      client: slack,
    });
    expect(restartedRun).not.toHaveBeenCalled();

    await restartedMention({
      body: { event_id: "E_REJOIN_AFTER_RESTART" },
      event: { ...reply, text: "<@U_BOT> rejoin" },
      client: slack,
    });
    await restartedMessage({
      body: { event_id: "E_ACCEPTED_AFTER_RESTART" },
      event: { ...reply, ts: "22" },
      client: slack,
    });

    expect(restartedRun).toHaveBeenCalledTimes(2);
    expect(restartedRun).toHaveBeenLastCalledWith(
      expect.objectContaining({ conversationId: "C1:20", prompt: "follow up" }),
      expect.any(Object),
    );
  });

  test("deduplicates app mentions delivered through channel message subscriptions", async () => {
    const run = mock(async () => "response");
    createAgent(run);
    const slack = client();
    const event = {
      channel_type: "channel",
      user: "U_ALLOWED",
      text: "request",
      channel: "C1",
      ts: "30",
      client_msg_id: "M30",
      thread_ts: "29",
    };

    await app.handlers.get("app_mention")!({
      body: { event_id: "E_MENTION_DELIVERY" },
      event,
      client: slack,
    });
    await app.handlers.get("message")!({
      body: { event_id: "E_MESSAGE_DELIVERY" },
      event,
      client: slack,
    });

    expect(run).toHaveBeenCalledTimes(1);
  });

  test("processes duplicate Slack deliveries only once", async () => {
    const run = mock(async () => "response");
    createAgent(run);
    const slack = client();
    const mention = app.handlers.get("app_mention")!;
    const event = {
      user: "U_ALLOWED",
      text: "request",
      channel: "C1",
      ts: "1",
      client_msg_id: "M1",
    };

    await mention({ body: { event_id: "E_DUPLICATE" }, event, client: slack });
    await mention({ body: { event_id: "E_DUPLICATE" }, event, client: slack });
    await mention({ body: { event_id: "E_REDELIVERED" }, event, client: slack });

    expect(run).toHaveBeenCalledTimes(1);
    expect(slack.chat.update).toHaveBeenCalledTimes(1);
  });

  test("reports unexpected failures without exposing backend details", async () => {
    const records: RequestLog[] = [];
    const operatorErrors: Array<{
      message: string;
      context: { requestId: string; errorType: string };
    }> = [];
    const run = mock(async (_request: unknown, observer?: AgentRunObserver) => {
      observer?.onToolUse();
      throw new Error("backend unavailable with secret-token");
    });
    new SlackAgent({
      botToken: "xoxb-test",
      appToken: "xapp-test",
      allowedUserIds: new Set(["U_ALLOWED"]),
      agent: backend(run),
      log: (record) => records.push(record),
      operatorError: (message, context) => operatorErrors.push({ message, context }),
    });
    const slack = client();

    await app.handlers.get("app_mention")!({
      body: { event_id: "E_FAILURE" },
      event: { user: "U_ALLOWED", text: "request", channel: "C1", ts: "2" },
      client: slack,
    });

    expect(slack.chat.update).toHaveBeenCalledWith({
      channel: "C1",
      ts: "status-ts",
      text: "The request failed unexpectedly. Try again or contact the operator with request ID `E_FAILURE`.",
    });
    expect(JSON.stringify(slack.chat.update.mock.calls)).not.toContain("secret-token");
    expect(operatorErrors).toEqual([
      {
        message: "Unexpected agent request failure",
        context: { requestId: "E_FAILURE", errorType: "Error" },
      },
    ]);
    expect(JSON.stringify(operatorErrors)).not.toContain("secret-token");
    expect(slack.reactions.add).toHaveBeenCalledWith({
      channel: "C1",
      timestamp: "2",
      name: "x",
    });
    expect(slack.reactions.remove).toHaveBeenCalledWith({
      channel: "C1",
      timestamp: "2",
      name: "eyes",
    });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      request_id: "E_FAILURE",
      tool_count: 1,
      execution_outcome: "error",
      delivery_outcome: "success",
    });
  });

  test("maps every expected queue outcome to distinct actionable text", () => {
    const messages = [
      userFacingAgentError(new ConversationQueueFullError(), "E1"),
      userFacingAgentError(new GlobalQueueFullError(), "E1"),
      userFacingAgentError(new RequesterLimitError(), "E1"),
      userFacingAgentError(new RateLimitError(), "E1"),
      userFacingAgentError(new AgentTimeoutError(), "E1"),
      userFacingAgentError(new QueueWaitTimeoutError(), "E1"),
      userFacingAgentError(new AgentCancelledError(), "E1"),
    ];

    expect(new Set(messages).size).toBe(messages.length);
    expect(messages).toEqual([
      expect.stringContaining("conversation"),
      expect.stringContaining("capacity"),
      expect.stringContaining("active or queued"),
      expect.stringContaining("Wait a minute"),
      expect.stringContaining("focused request"),
      expect.stringContaining("waiting in the queue"),
      "Request cancelled.",
    ]);
    expect(messages.slice(0, -1).every((message) => /wait|try/i.test(message))).toBe(true);
  });

  test("publishes long responses as ordered Slack-safe chunks", async () => {
    const output = Array.from({ length: 1_200 }, (_, index) => `word${index}`).join(" ");
    const run = mock(async () => output);
    createAgent(run);
    const slack = client();

    await app.handlers.get("app_mention")!({
      body: { event_id: "E_CHUNKS" },
      event: { user: "U_ALLOWED", text: "request", channel: "C1", ts: "4" },
      client: slack,
    });

    const chunks = [
      slack.chat.update.mock.calls[0]?.[0].text,
      ...slack.chat.postMessage.mock.calls.slice(1).map(([message]) => message.text),
    ] as string[];
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((text) => text.length <= 3_500)).toBe(true);
    expect(chunks.join(" ")).toBe(output);
    expect(
      slack.chat.postMessage.mock.calls
        .slice(1)
        .every(([message]) => message.channel === "C1" && message.thread_ts === "4"),
    ).toBe(true);
  });

  test("caps published responses and shows the truncation marker", async () => {
    const run = mock(async () => "word ".repeat(4_000));
    createAgent(run);
    const slack = client();

    await app.handlers.get("app_mention")!({
      body: { event_id: "E_TRUNCATED" },
      event: { user: "U_ALLOWED", text: "request", channel: "C1", ts: "5" },
      client: slack,
    });

    const published = [
      slack.chat.update.mock.calls[0]?.[0].text,
      ...slack.chat.postMessage.mock.calls.slice(1).map(([message]) => message.text),
    ] as string[];
    expect(published).toHaveLength(3);
    expect(published.every((text) => text.length <= 3_500)).toBe(true);
    expect(published[2]).toContain("Output truncated");
  });

  test("falls back to a new message when the final status update fails", async () => {
    const records: RequestLog[] = [];
    new SlackAgent({
      botToken: "xoxb-test",
      appToken: "xapp-test",
      allowedUserIds: new Set(["U_ALLOWED"]),
      agent: backend(mock(async () => "response")),
      log: (record) => records.push(record),
    });
    const slack = client();
    slack.chat.update.mockImplementation(async () => {
      throw new Error("update unavailable");
    });

    await app.handlers.get("app_mention")!({
      body: { event_id: "E_UPDATE_FALLBACK" },
      event: { user: "U_ALLOWED", text: "request", channel: "C1", ts: "5" },
      client: slack,
    });

    expect(slack.chat.postMessage).toHaveBeenCalledWith({
      channel: "C1",
      thread_ts: "5",
      text: "response",
    });
    expect(records[0]).toMatchObject({
      delivery_outcome: "success",
      published_messages: 1,
    });
  });

  test("logs partial multi-message delivery without recursively publishing an error", async () => {
    const records: RequestLog[] = [];
    const operatorErrors: Array<{
      message: string;
      context: { requestId: string; errorType: string };
    }> = [];
    const output = "word ".repeat(4_000);
    new SlackAgent({
      botToken: "xoxb-test",
      appToken: "xapp-test",
      allowedUserIds: new Set(["U_ALLOWED"]),
      agent: backend(mock(async () => output)),
      log: (record) => records.push(record),
      operatorError: (message, context) => operatorErrors.push({ message, context }),
    });
    const slack = client();
    slack.chat.postMessage.mockImplementation(async (message: { text: string }) => {
      if (message.text === "Queued…") return { ts: "status-ts" };
      throw new Error("post unavailable");
    });

    await app.handlers.get("app_mention")!({
      body: { event_id: "E_PARTIAL" },
      event: { user: "U_ALLOWED", text: "request", channel: "C1", ts: "6" },
      client: slack,
    });

    expect(slack.chat.postMessage).toHaveBeenCalledTimes(2);
    expect(operatorErrors).toEqual([
      {
        message: "Slack result delivery failure",
        context: { requestId: "E_PARTIAL", errorType: "Error" },
      },
    ]);
    expect(records[0]).toMatchObject({
      execution_outcome: "success",
      delivery_outcome: "partial",
      published_messages: 1,
    });
  });

  test("logs failed delivery and makes only one final publication attempt", async () => {
    const records: RequestLog[] = [];
    const operatorErrors: Array<{
      message: string;
      context: { requestId: string; errorType: string };
    }> = [];
    new SlackAgent({
      botToken: "xoxb-test",
      appToken: "xapp-test",
      allowedUserIds: new Set(["U_ALLOWED"]),
      agent: backend(mock(async () => "response")),
      log: (record) => records.push(record),
      operatorError: (message, context) => operatorErrors.push({ message, context }),
    });
    const slack = client();
    slack.chat.update.mockImplementation(async () => {
      throw new Error("update unavailable");
    });
    slack.chat.postMessage.mockImplementation(async (message: { text: string }) => {
      if (message.text === "Queued…") return { ts: "status-ts" };
      throw new Error("post unavailable");
    });

    await app.handlers.get("app_mention")!({
      body: { event_id: "E_DELIVERY_FAILURE" },
      event: { user: "U_ALLOWED", text: "request", channel: "C1", ts: "7" },
      client: slack,
    });

    expect(slack.chat.postMessage).toHaveBeenCalledTimes(2);
    expect(operatorErrors).toEqual([
      {
        message: "Slack result delivery failure",
        context: { requestId: "E_DELIVERY_FAILURE", errorType: "Error" },
      },
    ]);
    expect(records[0]).toMatchObject({
      execution_outcome: "success",
      delivery_outcome: "failure",
      published_messages: 0,
    });
  });

  test("shows queued, working, and rate-limited aggregate progress", async () => {
    const first = deferred<string>();
    const rawBackend: AgentBackend = {
      run: async ({ prompt }, observer) => {
        observer?.onToolUse();
        return prompt === "first" ? first.promise : "second response";
      },
      dispose: () => {},
    };
    new SlackAgent({
      botToken: "xoxb-test",
      appToken: "xapp-test",
      allowedUserIds: new Set(["U_ALLOWED"]),
      agent: new QueuedAgentBackend(rawBackend, queueLimits()),
      statusUpdateIntervalMs: 10,
    });
    const slack = client();
    const mention = app.handlers.get("app_mention")!;

    const firstHandling = mention({
      body: { event_id: "E_FIRST" },
      event: { user: "U_ALLOWED", text: "first", channel: "C1", ts: "8" },
      client: slack,
    });
    await Bun.sleep(25);
    const secondHandling = mention({
      body: { event_id: "E_SECOND" },
      event: { user: "U_ALLOWED", text: "second", channel: "C2", ts: "9" },
      client: slack,
    });
    await Bun.sleep(0);

    const progress = slack.chat.update.mock.calls
      .map(([message]) => message.text as string)
      .filter((text) => text.startsWith("Working…"));
    expect(progress[0]).toBe("Working…");
    expect(progress.some((text) => /elapsed · 1 tool use$/.test(text))).toBe(true);
    expect(progress.filter((text) => text === "Working…")).toHaveLength(1);
    expect(slack.chat.postMessage).toHaveBeenCalledWith({
      channel: "C2",
      thread_ts: "9",
      text: "Queued…",
    });

    first.resolve("first response");
    await Promise.all([firstHandling, secondHandling]);
    expect(
      slack.chat.update.mock.calls.some(
        ([message]) => (message.text as string) === "second response",
      ),
    ).toBe(true);
    expect(
      slack.chat.update.mock.calls
        .map(([message]) => message.text)
        .filter((text) => text === "Working…"),
    ).toHaveLength(2);
  });

  test("publishes one terminal timeout status", async () => {
    const rawBackend: AgentBackend = {
      run: ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
      dispose: () => {},
    };
    new SlackAgent({
      botToken: "xoxb-test",
      appToken: "xapp-test",
      allowedUserIds: new Set(["U_ALLOWED"]),
      agent: new QueuedAgentBackend(rawBackend, queueLimits({ timeoutMs: 10 })),
    });
    const slack = client();

    await app.handlers.get("app_mention")!({
      body: { event_id: "E_TIMEOUT" },
      event: { user: "U_ALLOWED", text: "slow", channel: "C1", ts: "10" },
      client: slack,
    });

    expect(
      slack.chat.update.mock.calls.filter(([message]) =>
        (message.text as string).includes("focused request"),
      ),
    ).toHaveLength(1);
  });

  test("publishes one terminal status when a running request is cancelled", async () => {
    const rawBackend: AgentBackend = {
      run: ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
      sessionCommand: async () => "command complete",
      dispose: () => {},
    };
    new SlackAgent({
      botToken: "xoxb-test",
      appToken: "xapp-test",
      allowedUserIds: new Set(["U_ALLOWED"]),
      agent: new QueuedAgentBackend(rawBackend, queueLimits()),
    });
    const slack = client();
    let statusCount = 0;
    slack.chat.postMessage.mockImplementation(async () => ({ ts: `status-${++statusCount}` }));
    const mention = app.handlers.get("app_mention")!;

    const running = mention({
      body: { event_id: "E_CANCELLED_RUN" },
      event: { user: "U_ALLOWED", text: "slow", channel: "C1", ts: "11" },
      client: slack,
    });
    await Bun.sleep(0);
    const cancelling = mention({
      body: { event_id: "E_CANCEL_COMMAND" },
      event: {
        user: "U_ALLOWED",
        text: "!cancel",
        channel: "C1",
        ts: "12",
        thread_ts: "11",
      },
      client: slack,
    });
    await Promise.all([running, cancelling]);

    expect(
      slack.chat.update.mock.calls.filter(
        ([message]) => message.ts === "status-1" && message.text === "Request cancelled.",
      ),
    ).toHaveLength(1);
    expect(
      slack.chat.update.mock.calls.some(
        ([message]) => message.ts === "status-1" && message.text === "Working…",
      ),
    ).toBe(true);
  });

  test("keeps the working reaction until the backend settles", async () => {
    const result = deferred<string>();
    const run = mock(() => result.promise);
    createAgent(run);
    const slack = client();

    const handling = app.handlers.get("app_mention")!({
      body: { event_id: "E_PENDING" },
      event: { user: "U_ALLOWED", text: "request", channel: "C1", ts: "5" },
      client: slack,
    });
    await Bun.sleep(0);

    expect(slack.reactions.add.mock.calls[0]?.[0]).toEqual({
      channel: "C1",
      timestamp: "5",
      name: "eyes",
    });
    expect(slack.reactions.remove).not.toHaveBeenCalled();

    result.resolve("response");
    await handling;

    expect(slack.reactions.add.mock.calls[1]?.[0]).toEqual({
      channel: "C1",
      timestamp: "5",
      name: "white_check_mark",
    });
    expect(slack.reactions.remove).toHaveBeenCalledWith({
      channel: "C1",
      timestamp: "5",
      name: "eyes",
    });
  });

  test("does not let reaction failures mask a successful response", async () => {
    const run = mock(async () => "response");
    createAgent(run);
    const slack = client();
    slack.reactions.add.mockImplementation(async () => {
      throw new Error("reaction unavailable");
    });
    slack.reactions.remove.mockImplementation(async () => {
      throw new Error("reaction unavailable");
    });

    await app.handlers.get("app_mention")!({
      body: { event_id: "E_REACTION_FAILURE" },
      event: { user: "U_ALLOWED", text: "request", channel: "C1", ts: "6" },
      client: slack,
    });

    expect(run).toHaveBeenCalledTimes(1);
    expect(slack.chat.update).toHaveBeenCalledWith({
      channel: "C1",
      ts: "status-ts",
      text: "response",
    });
  });

  test("ingests file-only direct messages", async () => {
    const run = mock(async () => "response");
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const fetcher = mock(async () => new Response(png)) as unknown as typeof fetch;
    new SlackAgent({
      botToken: "xoxb-test",
      appToken: "xapp-test",
      allowedUserIds: new Set(["U_ALLOWED"]),
      agent: backend(run),
      fetch: fetcher,
    });
    const slack = client();
    slack.files.info.mockImplementation(async () => ({
      ok: true,
      file: {
        id: "F1",
        name: "image.png",
        mimetype: "image/png",
        size: png.length,
        url_private_download: "https://files.slack.com/files-pri/T1-F1/download/image.png",
      },
    }));

    await app.handlers.get("message")!({
      body: { event_id: "E3" },
      event: {
        subtype: "file_share",
        channel_type: "im",
        user: "U_ALLOWED",
        text: "",
        channel: "D1",
        ts: "2",
        files: [{ id: "F1" }],
      },
      client: slack,
    });

    expect(run).toHaveBeenCalledWith(
      {
        conversationId: "dm:D1",
        requesterId: "U_ALLOWED",
        prompt: "",
        attachments: [
          {
            kind: "image",
            name: "image.png",
            mediaType: "image/png",
            data: Buffer.from(png).toString("base64"),
          },
        ],
      },
      {
        onQueued: expect.any(Function),
        onStarted: expect.any(Function),
        onToolUse: expect.any(Function),
      },
    );
  });
});
