import { describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import type { RequestLog, StructuredLog } from "../src/log.ts";
import { SLACK_MESSAGE_LIMIT } from "../src/messages.ts";
import { ScheduleService } from "../src/schedules.ts";

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
    emoji: { list: mock(async () => ({ emoji: {} as Record<string, string> })) },
    chat: {
      postMessage: mock(async () => ({ ts: "operator-message" })),
      update: mock(async () => ({})),
      delete: mock(async () => ({})),
      getPermalink: mock(async () => ({ permalink: "https://example.slack.com/thread" })),
    },
    reactions: { add: mock(async () => ({})) },
    files: { info: mock(async () => ({ ok: true })) },
    conversations: {
      info: mock(async () => ({ channel: { name: "engineering" } })),
      replies: mock(async (): Promise<{ messages: Record<string, unknown>[] }> => ({
        messages: [],
      })),
      history: mock(
        async (
          _options?: Record<string, unknown>,
        ): Promise<{ messages: Record<string, unknown>[] }> => ({ messages: [] }),
      ),
    },
    users: {
      conversations: mock(
        async (): Promise<{
          channels: Record<string, unknown>[];
          response_metadata?: { next_cursor?: string };
        }> => ({ channels: [] }),
      ),
      info: mock(async ({ user }: { user: string }) => ({
        user: {
          id: user,
          name: "jane",
          real_name: "Jane Doe",
          profile: { display_name: "Jane", real_name: "Jane Doe" },
        },
      })),
    },
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

function backend(
  run: ReturnType<typeof mock>,
  hasConversation: (conversationId: string) => Promise<boolean> = async () => false,
): CancellableAgentBackend {
  return {
    hasConversation,
    run,
    handleCommand: async () => "command complete",
    cancelActive: () => false,
    dispose: () => {},
  };
}

function createAgent(
  run: ReturnType<typeof mock>,
  hasConversation?: (conversationId: string) => Promise<boolean>,
  operatorLog?: (record: StructuredLog) => void,
): void {
  new SlackAgent({
    botToken: "xoxb-test",
    appToken: "xapp-test",
    allowedUserIds: new Set(["U_ALLOWED"]),
    agent: backend(run, hasConversation),
    ...(operatorLog ? { operatorLog } : {}),
  });
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await Bun.sleep(5);
  }
  throw new Error("Timed out waiting for condition");
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

  test("replies to bounded eligible messages missed while offline", async () => {
    const directory = mkdtempSync(join(tmpdir(), "slack-desk-catch-up-"));
    const statePath = join(directory, "state.json");
    const now = 1_710_000_000_000;
    writeFileSync(
      statePath,
      `${JSON.stringify({ version: 1, lastReconciledAt: now - 60_000, processedMessages: [] })}\n`,
    );
    const run = mock(async (_request: unknown) => "caught up");
    const agent = new SlackAgent({
      botToken: "xoxb-test",
      appToken: "xapp-test",
      allowedUserIds: new Set(["U_ALLOWED"]),
      agent: backend(run),
      catchUp: { statePath, cooldownMs: 0, now: () => now },
      random: () => 1,
    });
    app.client.users.conversations
      .mockImplementationOnce(async () => ({
        channels: [{ id: "D1", is_im: true }],
        response_metadata: { next_cursor: "page-2" },
      }))
      .mockImplementationOnce(async () => ({
        channels: [{ id: "C1", is_im: false }],
      }));
    app.client.conversations.history.mockImplementation(
      async (options?: Record<string, unknown>) =>
        options?.channel === "D1"
          ? { messages: [{ ts: "1709999990.000100", user: "U_ALLOWED", text: "offline dm" }] }
          : {
              messages: [
                {
                  ts: "1709999991.000100",
                  user: "U_ALLOWED",
                  text: "<@U_BOT> offline mention",
                },
                {
                  ts: "1709999992.000100",
                  user: "U_ALLOWED",
                  text: "unrelated channel post",
                  subtype: "file_share",
                  files: [{ id: "F_UNRELATED" }],
                },
              ],
            },
    );

    try {
      await agent.start();
      await waitUntil(() => run.mock.calls.length === 2);
      expect(run.mock.calls.map((call) => call[0])).toEqual([
        {
          conversationId: "dm:D1",
          requesterId: "U_ALLOWED",
          prompt: "offline dm",
          context: { sendDirectMessage: expect.any(Function) },
        },
        {
          conversationId: "C1:1709999991.000100",
          requesterId: "U_ALLOWED",
          prompt: "offline mention",
          context: {
            readThreadHistory: expect.any(Function),
            sendDirectMessage: expect.any(Function),
          },
        },
      ]);
      expect(app.client.users.conversations).toHaveBeenCalledTimes(2);
      expect(app.client.conversations.history).toHaveBeenCalledTimes(2);
    } finally {
      await agent.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("ignores a thread parent Slack returns outside the catch-up window", async () => {
    const directory = mkdtempSync(join(tmpdir(), "slack-desk-catch-up-parent-"));
    const statePath = join(directory, "state.json");
    const now = 1_710_000_000_000;
    writeFileSync(
      statePath,
      `${JSON.stringify({ version: 1, lastReconciledAt: now - 60_000, processedMessages: [] })}\n`,
    );
    const run = mock(async (_request: unknown) => "caught up");
    const reconciler = backend(run);
    reconciler.listConversations = async () => [
      {
        conversationId: "C1:1709000000.000100",
        sessionId: "session-1",
        state: "inactive",
        lastActiveAt: now - 120_000,
      },
    ];
    const agent = new SlackAgent({
      botToken: "xoxb-test",
      appToken: "xapp-test",
      allowedUserIds: new Set(["U_ALLOWED"]),
      agent: reconciler,
      catchUp: { statePath, cooldownMs: 0, now: () => now },
    });
    app.client.conversations.replies.mockImplementationOnce(async () => ({
      messages: [
        {
          ts: "1709000000.000100",
          user: "U_ALLOWED",
          text: "<@U_BOT> already answered thread parent",
        },
      ],
    }));

    try {
      await agent.start();
      await waitUntil(() => app.client.conversations.replies.mock.calls.length === 1);
      await Bun.sleep(10);
      expect(run).not.toHaveBeenCalled();
    } finally {
      await agent.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("silently skips stored conversations the bot can no longer access", async () => {
    const directory = mkdtempSync(join(tmpdir(), "slack-desk-catch-up-stale-"));
    const statePath = join(directory, "state.json");
    const now = 1_710_000_000_000;
    writeFileSync(
      statePath,
      `${JSON.stringify({ version: 1, lastReconciledAt: now - 60_000, processedMessages: [] })}\n`,
    );
    const reconciler = backend(mock(async () => "caught up"));
    reconciler.listConversations = async () => [
      {
        conversationId: "C_STALE:1709999900.000100",
        sessionId: "session-stale",
        state: "inactive",
        lastActiveAt: now - 60_000,
      },
    ];
    const operatorLogs: StructuredLog[] = [];
    const agent = new SlackAgent({
      botToken: "xoxb-test",
      appToken: "xapp-test",
      allowedUserIds: new Set(["U_ALLOWED"]),
      agent: reconciler,
      operatorLog: (record) => operatorLogs.push(record),
      catchUp: { statePath, cooldownMs: 0, now: () => now },
    });
    app.client.conversations.replies.mockImplementationOnce(async () => {
      throw Object.assign(new Error("An API error occurred: channel_not_found"), {
        data: { error: "channel_not_found" },
      });
    });

    try {
      await agent.start();
      await waitUntil(() => app.client.conversations.replies.mock.calls.length === 1);
      await Bun.sleep(10);
      expect(operatorLogs.filter((record) => record.event === "operator_error")).toEqual([]);
      expect(JSON.parse(await Bun.file(statePath).text()).lastReconciledAt).toBe(now);
    } finally {
      await agent.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("only catches up messages with no evidence of a later reply or prior handling", async () => {
    const directory = mkdtempSync(join(tmpdir(), "slack-desk-catch-up-unanswered-"));
    const statePath = join(directory, "state.json");
    const now = 1_710_000_000_000;
    writeFileSync(
      statePath,
      `${JSON.stringify({ version: 1, lastReconciledAt: now - 60_000, processedMessages: [] })}\n`,
    );
    const run = mock(async (_request: unknown) => "caught up");
    const reconciler = backend(run);
    reconciler.listConversations = async () => [
      {
        conversationId: "C1:1709999900.000100",
        sessionId: "session-1",
        state: "inactive",
        lastActiveAt: now - 120_000,
      },
      {
        conversationId: "C3:1709999901.000100",
        sessionId: "session-3",
        state: "inactive",
        lastActiveAt: now - 10_000,
      },
    ];
    const agent = new SlackAgent({
      botToken: "xoxb-test",
      appToken: "xapp-test",
      allowedUserIds: new Set(["U_ALLOWED"]),
      agent: reconciler,
      catchUp: { statePath, cooldownMs: 0, now: () => now },
      random: () => 1,
    });
    app.client.users.conversations.mockImplementationOnce(async () => ({
      channels: [
        { id: "D1", is_im: true },
        { id: "C2", is_im: false },
      ],
    }));
    app.client.conversations.replies.mockImplementation(
      async (options?: Record<string, unknown>) =>
        options?.channel === "C1"
          ? {
              messages: [
                { ts: "1709999960.000100", user: "U_ALLOWED", text: "please check this" },
                { ts: "1709999970.000100", user: "U_BOT", bot_id: "B1", text: "done" },
              ],
            }
          : {
              messages: [{ ts: "1709999960.000200", user: "U_ALLOWED", text: "please check this" }],
            },
    );
    app.client.conversations.history.mockImplementation(
      async (options?: Record<string, unknown>) =>
        options?.channel === "D1"
          ? {
              messages: [
                { ts: "1709999950.000100", user: "U_ALLOWED", text: "offline dm" },
                { ts: "1709999960.000100", user: "U_BOT", bot_id: "B1", text: "handled" },
              ],
            }
          : {
              messages: [
                {
                  ts: "1709999970.000100",
                  user: "U_ALLOWED",
                  text: "<@U_BOT> already answered",
                  reply_count: 1,
                },
                {
                  ts: "1709999980.000100",
                  user: "U_ALLOWED",
                  text: "<@U_BOT> actually missed",
                },
              ],
            },
    );

    try {
      await agent.start();
      await waitUntil(() => run.mock.calls.length === 1);
      expect(run.mock.calls[0]?.[0]).toEqual({
        conversationId: "C2:1709999980.000100",
        requesterId: "U_ALLOWED",
        prompt: "actually missed",
        context: {
          readThreadHistory: expect.any(Function),
          sendDirectMessage: expect.any(Function),
        },
      });
    } finally {
      await agent.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("deduplicates a message delivered live while catch-up scans it", async () => {
    const directory = mkdtempSync(join(tmpdir(), "slack-desk-catch-up-race-"));
    const statePath = join(directory, "state.json");
    const now = 1_710_000_000_000;
    writeFileSync(
      statePath,
      `${JSON.stringify({ version: 1, lastReconciledAt: now - 60_000, processedMessages: [] })}\n`,
    );
    const result = deferred<string>();
    const run = mock(async (_request: unknown) => result.promise);
    const agent = new SlackAgent({
      botToken: "xoxb-test",
      appToken: "xapp-test",
      allowedUserIds: new Set(["U_ALLOWED"]),
      agent: backend(run),
      catchUp: { statePath, cooldownMs: 0, now: () => now },
      random: () => 1,
    });
    app.client.users.conversations.mockImplementationOnce(async () => ({
      channels: [{ id: "D1", is_im: true }],
    }));
    app.client.conversations.history.mockImplementationOnce(async () => ({
      messages: [
        {
          ts: "1709999990.000100",
          client_msg_id: "M1",
          user: "U_ALLOWED",
          text: "one request",
        },
      ],
    }));

    try {
      await agent.start();
      const live = app.handlers.get("message")!({
        body: { event_id: "E_LIVE_DURING_CATCH_UP" },
        event: {
          user: "U_ALLOWED",
          text: "one request",
          channel: "D1",
          channel_type: "im",
          ts: "1709999990.000100",
          client_msg_id: "M1",
        },
        client: client(),
      });
      await waitUntil(() => app.client.conversations.history.mock.calls.length === 1);
      await Bun.sleep(10);
      expect(run).toHaveBeenCalledTimes(1);
      result.resolve("done");
      await live;
    } finally {
      result.resolve("done");
      await agent.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("defers catch-up after a recent reconciliation", async () => {
    const directory = mkdtempSync(join(tmpdir(), "slack-desk-catch-up-cooldown-"));
    const statePath = join(directory, "state.json");
    const now = 1_710_000_000_000;
    writeFileSync(
      statePath,
      `${JSON.stringify({ version: 1, lastReconciledAt: now - 1_000, processedMessages: [] })}\n`,
    );
    const agent = new SlackAgent({
      botToken: "xoxb-test",
      appToken: "xapp-test",
      allowedUserIds: new Set(["U_ALLOWED"]),
      agent: backend(mock(async () => "response")),
      catchUp: { statePath, cooldownMs: 300_000, now: () => now },
    });

    try {
      await agent.start();
      await Bun.sleep(20);
      expect(app.client.users.conversations).not.toHaveBeenCalled();
      expect(app.client.conversations.history).not.toHaveBeenCalled();
    } finally {
      await agent.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("occasionally adds a random custom workspace emoji after a successful response", async () => {
    const randomValues = [0.1, 0.99];
    const agent = new SlackAgent({
      botToken: "xoxb-test",
      appToken: "xapp-test",
      allowedUserIds: new Set(["U_ALLOWED"]),
      agent: backend(mock(async () => "response")),
      random: () => randomValues.shift() ?? 1,
    });
    app.client.emoji.list.mockImplementationOnce(async () => ({
      emoji: {
        party_parrot: "https://example.com/party.gif",
        ship_it: "https://example.com/ship.png",
        party_alias: "alias:party_parrot",
      },
    }));
    await agent.start();
    const slack = client();

    await app.handlers.get("app_mention")!({
      body: { event_id: "E_PLAYFUL_REACTION" },
      event: { user: "U_ALLOWED", text: "request", channel: "C1", ts: "5" },
      client: slack,
    });

    expect(app.client.emoji.list).toHaveBeenCalledTimes(1);
    expect(slack.reactions.add).toHaveBeenCalledWith({
      channel: "C1",
      timestamp: "5",
      name: "ship_it",
    });
  });

  test("usually skips the custom workspace emoji reaction", async () => {
    const agent = new SlackAgent({
      botToken: "xoxb-test",
      appToken: "xapp-test",
      allowedUserIds: new Set(["U_ALLOWED"]),
      agent: backend(mock(async () => "response")),
      random: () => 0.8,
    });
    app.client.emoji.list.mockImplementationOnce(async () => ({
      emoji: { party_parrot: "https://example.com/party.gif" },
    }));
    await agent.start();
    const slack = client();

    await app.handlers.get("app_mention")!({
      body: { event_id: "E_NO_PLAYFUL_REACTION" },
      event: { user: "U_ALLOWED", text: "request", channel: "C1", ts: "6" },
      client: slack,
    });

    expect(slack.reactions.add).not.toHaveBeenCalled();
    expect(slack.reactions.remove).not.toHaveBeenCalled();
  });

  test("resolves conversation identity, participants, and bounded history", async () => {
    const agent = new SlackAgent({
      botToken: "xoxb-test",
      appToken: "xapp-test",
      allowedUserIds: new Set(["U_ALLOWED"]),
      agent: backend(mock(async () => "response")),
    });
    app.client.conversations.replies
      .mockImplementationOnce(async () => ({
        messages: [
          { ts: "1700000000.000100", user: "U_ALLOWED", text: "Deploy status?" },
          { ts: "1700000001.000100", bot_id: "B1", user: "U_BOT", text: "Healthy." },
        ],
        response_metadata: { next_cursor: "page-2" },
      }))
      .mockImplementationOnce(async () => ({
        messages: [{ ts: "1700000002.000100", user: "U_ALLOWED", text: "Thanks" }],
      }));

    const details = await agent.inspectConversation("C1:1700000000.000100", 2);

    expect(details).toMatchObject({
      label: "#engineering / Deploy status?",
      channelName: "engineering",
      threadStarter: "Deploy status?",
      permalink: "https://example.slack.com/thread",
      participants: [{ id: "U_ALLOWED", name: "Jane", handle: "jane" }],
    });
    expect(details.history.map(({ authorName, text }) => ({ authorName, text }))).toEqual([
      { authorName: "Agent", text: "Healthy." },
      { authorName: "Jane", text: "Thanks" },
    ]);
    expect(app.client.conversations.replies).toHaveBeenNthCalledWith(2, {
      channel: "C1",
      ts: "1700000000.000100",
      limit: 100,
      cursor: "page-2",
    });
  });

  test("keeps session listing metadata cheap", async () => {
    const agent = new SlackAgent({
      botToken: "xoxb-test",
      appToken: "xapp-test",
      allowedUserIds: new Set(["U_ALLOWED"]),
      agent: backend(mock(async () => "response")),
    });
    app.client.conversations.replies.mockImplementationOnce(async () => ({
      messages: [{ ts: "1700000000.000100", user: "U_ALLOWED", text: "Deploy status?" }],
      response_metadata: { next_cursor: "ignored-page" },
    }));

    const details = await agent.inspectConversation("C1:1700000000.000100", 0);

    expect(details.history).toEqual([]);
    expect(app.client.conversations.replies).toHaveBeenCalledTimes(1);
    expect(app.client.chat.getPermalink).not.toHaveBeenCalled();
  });

  test("publishes attributed local operator exchanges to the originating Slack thread", async () => {
    const agent = new SlackAgent({
      botToken: "xoxb-test",
      appToken: "xapp-test",
      allowedUserIds: new Set(["U_ALLOWED"]),
      agent: backend(mock(async () => "response")),
    });

    await agent.publishOperatorExchange("C123:100.1", "check the build", "It passes.");

    expect(app.client.chat.postMessage).toHaveBeenNthCalledWith(1, {
      channel: "C123",
      thread_ts: "100.1",
      text: "*Local operator:* check the build",
      unfurl_links: false,
      unfurl_media: false,
    });
    expect(app.client.chat.postMessage).toHaveBeenNthCalledWith(2, {
      channel: "C123",
      thread_ts: "100.1",
      text: "*Agent (operator request):* It passes.",
      unfurl_links: false,
      unfurl_media: false,
    });
  });

  test("escapes and splits untrusted operator exchanges so Slack cannot render mentions", async () => {
    const agent = new SlackAgent({
      botToken: "xoxb-test",
      appToken: "xapp-test",
      allowedUserIds: new Set(["U_ALLOWED"]),
      agent: backend(mock(async () => "response")),
    });

    await agent.publishOperatorExchange(
      "C123:100.1",
      "<!channel> ping",
      `<@U999> & <https://evil.example|docs> ${"x".repeat(SLACK_MESSAGE_LIMIT)}`,
    );

    const texts = app.client.chat.postMessage.mock.calls.map((call: unknown[]) =>
      String((call[0] as { text: string }).text),
    );
    expect(texts[0]).toBe("*Local operator:* &lt;!channel&gt; ping");
    expect(texts.join("\n")).not.toContain("<!channel>");
    expect(texts.join("\n")).not.toContain("<@U999>");
    expect(texts[1]).toContain("&lt;@U999&gt; &amp; &lt;https://evil.example|docs&gt;");
    expect(texts.length).toBeGreaterThan(2);
    for (const text of texts) expect(text.length).toBeLessThanOrEqual(SLACK_MESSAGE_LIMIT + 40);
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
    slack.chat.postMessage.mockImplementation(async () => {
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

  test("explains an unauthorized mention once, then reacts to later messages", async () => {
    const run = mock(async () => "response");
    const operatorLogs: StructuredLog[] = [];
    new SlackAgent({
      botToken: "xoxb-test",
      appToken: "xapp-test",
      allowedUserIds: new Set(["U_ALLOWED"]),
      agent: backend(run),
      operatorLog: (record) => operatorLogs.push(record),
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

    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        app.handlers.get("app_mention")!({
          body: { event_id: `E_DENIED_${index}` },
          event: {
            user: "U_DENIED",
            text: "again",
            channel: "C1",
            ts: String(index + 2),
            thread_ts: "1",
            files: [{ id: `F${index}` }],
          },
          client: slack,
        }),
      ),
    );
    await app.handlers.get("app_mention")!({
      body: { event_id: "E_DENIED_0" },
      event: {
        user: "U_DENIED",
        text: "duplicate delivery",
        channel: "C1",
        ts: "2",
        thread_ts: "1",
      },
      client: slack,
    });

    expect(slack.chat.postMessage).toHaveBeenCalledTimes(1);
    expect(slack.reactions.add).toHaveBeenCalledTimes(20);
    expect(slack.reactions.add).toHaveBeenCalledWith({
      channel: "C1",
      timestamp: "2",
      name: "no_entry",
    });
    expect(slack.files.info).not.toHaveBeenCalled();
    expect(operatorLogs).toHaveLength(21);
    expect(operatorLogs[0]).toEqual({ event: "unauthorized", channel: "C1" });
  });

  test("reacts to a repeated authorization denial after restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "slack-desk-denials-"));
    const denialStatePath = join(directory, "slack-denials.json");
    try {
      new SlackAgent({
        botToken: "xoxb-test",
        appToken: "xapp-test",
        allowedUserIds: new Set(["U_ALLOWED"]),
        agent: backend(mock(async () => "response")),
        denialStatePath,
      });
      const firstSlack = client();
      await app.handlers.get("app_mention")!({
        body: { event_id: "E_DENIED_BEFORE_RESTART" },
        event: { user: "U_DENIED", text: "request", channel: "C1", ts: "1" },
        client: firstSlack,
      });

      new SlackAgent({
        botToken: "xoxb-test",
        appToken: "xapp-test",
        allowedUserIds: new Set(["U_ALLOWED"]),
        agent: backend(mock(async () => "response")),
        denialStatePath,
      });
      const restartedSlack = client();
      await app.handlers.get("app_mention")!({
        body: { event_id: "E_DENIED_AFTER_RESTART" },
        event: {
          user: "U_DENIED",
          text: "again",
          channel: "C1",
          ts: "2",
          thread_ts: "1",
        },
        client: restartedSlack,
      });

      expect(firstSlack.chat.postMessage).toHaveBeenCalledWith({
        channel: "C1",
        thread_ts: "1",
        text: "You are not authorized to use this agent.",
      });
      expect(restartedSlack.chat.postMessage).not.toHaveBeenCalled();
      expect(restartedSlack.reactions.add).toHaveBeenCalledWith({
        channel: "C1",
        timestamp: "2",
        name: "no_entry",
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("bounds Slack calls for a burst beyond requester admission", async () => {
    const held = deferred<string>();
    const rawBackend: AgentBackend = {
      run: async () => held.promise,
      dispose: () => {},
    };
    const fetcher = mock(async () => new Response("contents")) as unknown as typeof fetch;
    new SlackAgent({
      botToken: "xoxb-test",
      appToken: "xapp-test",
      allowedUserIds: new Set(["U_ALLOWED"]),
      agent: new QueuedAgentBackend(
        rawBackend,
        queueLimits({ maxPendingPerRequester: 1, rateLimitBurst: 20 }),
      ),
      fetch: fetcher,
    });
    const slack = client();
    slack.files.info.mockImplementation(async ({ file }: { file: string }) => ({
      ok: true,
      file: {
        id: file,
        name: `${file}.txt`,
        mimetype: "text/plain",
        size: 8,
        url_private_download: `https://files.slack.com/files-pri/T1-${file}/download/file.txt`,
      },
    }));
    const mention = app.handlers.get("app_mention")!;

    const handling = Array.from({ length: 20 }, (_, index) =>
      mention({
        body: { event_id: `E_BURST_${index}` },
        event: {
          user: "U_ALLOWED",
          text: "request",
          channel: "C1",
          ts: String(index + 1),
          files: [{ id: `F${index}` }],
        },
        client: slack,
      }),
    );
    await Bun.sleep(0);

    expect(slack.files.info).toHaveBeenCalledTimes(1);
    expect(slack.chat.postMessage).toHaveBeenCalledTimes(19);
    expect(
      slack.chat.postMessage.mock.calls.filter(
        ([message]) =>
          message.text === "The agent is at capacity. Try again after another request finishes.",
      ),
    ).toHaveLength(12);
    held.resolve("response");
    await Promise.all(handling);
    expect(slack.chat.postMessage).toHaveBeenCalledTimes(20);
  });

  test("replies once per conversation and reacts when Slack response capacity is full", async () => {
    const held = deferred<string>();
    const run = mock(async () => held.promise);
    const operatorLogs: StructuredLog[] = [];
    createAgent(run, undefined, (record) => operatorLogs.push(record));
    const slack = client();
    const mention = app.handlers.get("app_mention")!;

    const active = Array.from({ length: 8 }, (_, index) =>
      mention({
        body: { event_id: `E_ACTIVE_${index}` },
        event: {
          user: "U_ALLOWED",
          text: "request",
          channel: `C${index}`,
          ts: String(index + 1),
        },
        client: slack,
      }),
    );
    await Bun.sleep(0);

    await mention({
      body: { event_id: "E_CAPACITY_9" },
      event: {
        user: "U_ALLOWED",
        text: "ninth",
        channel: "C_OVERFLOW",
        ts: "9",
        thread_ts: "overflow-thread",
      },
      client: slack,
    });
    await mention({
      body: { event_id: "E_CAPACITY_10" },
      event: {
        user: "U_ALLOWED",
        text: "tenth",
        channel: "C_OVERFLOW",
        ts: "10",
        thread_ts: "overflow-thread",
      },
      client: slack,
    });

    expect(run).toHaveBeenCalledTimes(8);
    expect(
      slack.chat.postMessage.mock.calls.filter(
        ([message]) =>
          message.text === "The agent is at capacity. Try again after another request finishes.",
      ),
    ).toHaveLength(1);
    expect(slack.chat.postMessage).toHaveBeenCalledWith({
      channel: "C_OVERFLOW",
      thread_ts: "overflow-thread",
      text: "The agent is at capacity. Try again after another request finishes.",
    });
    expect(
      slack.reactions.add.mock.calls.filter(
        ([reaction]) => reaction.name === "x" && reaction.channel === "C_OVERFLOW",
      ),
    ).toEqual([
      [{ channel: "C_OVERFLOW", timestamp: "9", name: "x" }],
      [{ channel: "C_OVERFLOW", timestamp: "10", name: "x" }],
    ]);
    expect(operatorLogs).toEqual([{ event: "capacity_drop", active_responses: 8, limit: 8 }]);

    held.resolve("response");
    await Promise.all(active);
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
        context: {
          readThreadHistory: expect.any(Function),
          sendDirectMessage: expect.any(Function),
        },
      },
      {
        onQueued: expect.any(Function),
        onStarted: expect.any(Function),
        onToolUse: expect.any(Function),
      },
    );
    expect(slack.chat.postMessage).toHaveBeenCalledTimes(1);
    expect(slack.chat.postMessage).toHaveBeenCalledWith({
      channel: "C1",
      thread_ts: "1",
      text: "response",
    });
    expect(slack.chat.update).not.toHaveBeenCalled();
    expect(slack.reactions.add).not.toHaveBeenCalled();
    expect(slack.reactions.remove).not.toHaveBeenCalled();
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

  test("formats and escapes untrusted agent output for Slack", async () => {
    createAgent(mock(async () => "<!channel> see **this** <@U999> & <https://evil.example|docs>"));
    const slack = client();

    await app.handlers.get("app_mention")!({
      body: { event_id: "E_ESCAPED" },
      event: { user: "U_ALLOWED", text: "summarize", channel: "C1", ts: "1" },
      client: slack,
    });

    expect(slack.chat.postMessage).toHaveBeenCalledWith({
      channel: "C1",
      thread_ts: "1",
      text: "&lt;!channel&gt; see *this* &lt;@U999&gt; &amp; &lt;https://evil.example|docs&gt;",
    });
  });

  test("renders a user mention repeated from the Slack request", async () => {
    createAgent(mock(async () => "<@U04ET2XUC3B> — nice work!"));
    const slack = client();

    await app.handlers.get("app_mention")!({
      body: { event_id: "E_USER_MENTION" },
      event: {
        user: "U_ALLOWED",
        text: "<@U_BOT> compliment <@U04ET2XUC3B>",
        channel: "C1",
        ts: "1",
      },
      client: slack,
    });

    expect(slack.chat.postMessage).toHaveBeenCalledWith({
      channel: "C1",
      thread_ts: "1",
      text: "<@U04ET2XUC3B> — nice work!",
    });
  });

  test("renders a user mention established by an authorized user earlier in the thread", async () => {
    createAgent(mock(async () => "<@U04ET2XUC3B> — fair pushback."));
    app.client.conversations.replies.mockImplementation(async () => ({
      messages: [
        {
          user: "U_ALLOWED",
          text: "<@U_BOT> review <@U04ET2XUC3B>'s recent work",
          ts: "1",
        },
      ],
    }));
    const slack = client();

    await app.handlers.get("app_mention")!({
      body: { event_id: "E_THREAD_USER_MENTION" },
      event: {
        user: "U_ALLOWED",
        text: "<@U_BOT> respond to the attached screenshot",
        channel: "C1",
        ts: "2",
        thread_ts: "1",
      },
      client: slack,
    });

    expect(slack.chat.postMessage).toHaveBeenCalledWith({
      channel: "C1",
      thread_ts: "1",
      text: "<@U04ET2XUC3B> — fair pushback.",
    });
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
        context: {
          readThreadHistory: expect.any(Function),
          sendDirectMessage: expect.any(Function),
        },
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
        context: { sendDirectMessage: expect.any(Function) },
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
      text: "response",
    });
    expect(slack.chat.postMessage.mock.calls[1]?.[0]).toEqual({
      channel: "D1",
      thread_ts: undefined,
      text: "response",
    });
  });

  test("provides paginated current-thread history to the agent on demand", async () => {
    let history: unknown;
    const run = mock(async (request: Parameters<AgentBackend["run"]>[0]) => {
      history = await request.context?.readThreadHistory?.({ limit: 2 });
      return "summary";
    });
    createAgent(run);
    app.client.conversations.replies.mockImplementationOnce(async () => ({
      messages: [
        { ts: "1700000000.000100", user: "U_ALLOWED", text: "First decision" },
        { ts: "1700000001.000100", bot_id: "B1", user: "U_BOT", text: "Earlier answer" },
      ],
      response_metadata: { next_cursor: "page-2" },
    }));

    await app.handlers.get("app_mention")!({
      body: { event_id: "E_CATCH_UP" },
      event: {
        user: "U_ALLOWED",
        text: "<@U_BOT> summarize this thread",
        channel: "C1",
        ts: "1700000002.000100",
        thread_ts: "1700000000.000100",
      },
      client: client(),
    });

    expect(app.client.conversations.replies).toHaveBeenCalledWith({
      channel: "C1",
      ts: "1700000000.000100",
      limit: 2,
    });
    expect(history).toMatchObject({
      messages: [
        { authorName: "Jane", kind: "user", text: "First decision" },
        { authorName: "Agent", kind: "agent", text: "Earlier answer" },
      ],
      nextCursor: "page-2",
    });
  });

  test("lets the agent send attributed, sanitized, bounded direct messages", async () => {
    const results: unknown[] = [];
    const run = mock(async (request: Parameters<AgentBackend["run"]>[0]) => {
      const send = request.context!.sendDirectMessage!;
      results.push(
        await send({ userId: "<@U0BOB>", text: "Ping <@U0BOB> and <@U0EVE> <!channel>" }),
      );
      for (let attempt = 0; attempt < 5; attempt++) {
        results.push(await send({ userId: "U0BOB", text: "again" }).catch((error) => error));
      }
      return "done";
    });
    const operatorLog = mock(() => {});
    createAgent(run, undefined, operatorLog);
    app.client.chat.postMessage.mockImplementation(async () => ({ channel: "D_BOB", ts: "1.1" }));

    await app.handlers.get("message")!({
      body: { event_id: "E_DM_TOOL" },
      event: { user: "U_ALLOWED", text: "tell bob hi", channel: "D1", channel_type: "im", ts: "1" },
      client: client(),
    });

    expect(app.client.chat.postMessage).toHaveBeenNthCalledWith(1, {
      channel: "U0BOB",
      text: "*Message from <@U_ALLOWED>:*\nPing <@U0BOB> and &lt;@U0EVE&gt; &lt;!channel&gt;",
      unfurl_links: false,
      unfurl_media: false,
    });
    expect(results[0]).toEqual({
      recipientId: "U0BOB",
      recipientName: "Jane",
      channel: "D_BOB",
      ts: "1.1",
    });
    expect(app.client.chat.postMessage).toHaveBeenCalledTimes(5);
    expect((results[5] as Error).message).toContain("At most 5 direct messages");
    expect(operatorLog).toHaveBeenCalledWith({
      event: "direct_message_sent",
      recipient: "U0BOB",
      requester: "U_ALLOWED",
      messages: 1,
    });
  });

  test("scopes bot schedule management to creators and configured Slack operators", async () => {
    const schedules = new ScheduleService(
      join(mkdtempSync(join(tmpdir(), "slack-bot-schedules-")), "schedules.json"),
      async () => {},
    );
    const results: unknown[] = [];
    const run = mock(async (request: Parameters<AgentBackend["run"]>[0]) => {
      const actions = request.context!.schedules!;
      if (request.requesterId === "U0ALICE") {
        results.push(
          actions.create({
            userId: "",
            text: "remind me",
            at: new Date(Date.now() + 86_400_000).toISOString(),
          }),
        );
      } else {
        results.push(actions.list());
        if (request.requesterId === "U0ADMIN") {
          results.push(
            actions.update((results[0] as { id: string }).id, {
              userId: "",
              text: "updated",
              at: new Date(Date.now() + 86_400_000).toISOString(),
            }),
          );
        }
        try {
          actions.cancel((results[0] as { id: string }).id);
          results.push("cancelled");
        } catch (error) {
          results.push((error as Error).message);
        }
      }
      return "done";
    });
    new SlackAgent({
      botToken: "xoxb-test",
      appToken: "xapp-test",
      allowedUserIds: new Set(["U0ALICE", "U0OTHER", "U0ADMIN"]),
      operatorUserIds: new Set(["U0ADMIN"]),
      agent: backend(run),
      schedules,
    });
    for (const [index, user] of ["U0ALICE", "U0OTHER", "U0ADMIN"].entries()) {
      await app.handlers.get("message")!({
        body: { event_id: `E_SCHEDULE_${index}` },
        event: {
          user,
          text: "manage schedules",
          channel: `D${index}`,
          channel_type: "im",
          ts: `${index + 1}`,
        },
        client: client(),
      });
    }
    expect(results[0]).toMatchObject({ creatorId: "U0ALICE", userId: "U0ALICE" });
    expect(results[1]).toEqual([]);
    expect(results[2]).toBe("Schedule not found");
    expect(results[3]).toHaveLength(1);
    expect(results[4]).toMatchObject({
      userId: "U0ALICE",
      creatorId: "U0ALICE",
      authorId: "U0ADMIN",
      text: "updated",
    });
    expect(results[5]).toBe("cancelled");
    expect(schedules.list("local-operator", true)).toEqual([]);
  });

  test("rejects direct messages to bots, missing users, and malformed IDs", async () => {
    const agent = new SlackAgent({
      botToken: "xoxb-test",
      appToken: "xapp-test",
      allowedUserIds: new Set(["U_ALLOWED"]),
      agent: backend(mock(async () => "unused")),
    });
    app.client.users.info.mockImplementationOnce(
      async ({ user }) =>
        ({
          user: { id: user, is_bot: true },
        }) as never,
    );
    await expect(agent.sendDirectMessage({ userId: "U0BOT", text: "hi" })).rejects.toThrow(
      "only be sent to people",
    );
    app.client.users.info.mockImplementationOnce(async () => {
      throw Object.assign(new Error("An API error occurred"), {
        data: { error: "user_not_found" },
      });
    });
    await expect(agent.sendDirectMessage({ userId: "U0GONE", text: "hi" })).rejects.toThrow(
      "Slack user not found",
    );
    await expect(agent.sendDirectMessage({ userId: "C123", text: "hi" })).rejects.toThrow(
      "Slack member ID",
    );
    await expect(agent.sendDirectMessage({ userId: "U0BOB", text: "  " })).rejects.toThrow(
      "text is required",
    );
    expect(app.client.chat.postMessage).not.toHaveBeenCalled();
  });

  test("sends local operator direct messages as the bot without attribution", async () => {
    const agent = new SlackAgent({
      botToken: "xoxb-test",
      appToken: "xapp-test",
      allowedUserIds: new Set(["U_ALLOWED"]),
      agent: backend(mock(async () => "unused")),
    });

    await agent.sendDirectMessage({ userId: "U0BOB", text: "Standup moved, cc <@U0EVE>" });

    expect(app.client.chat.postMessage).toHaveBeenCalledWith({
      channel: "U0BOB",
      text: "Standup moved, cc <@U0EVE>",
      unfurl_links: false,
      unfurl_media: false,
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
        text: "Could you follow up?",
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
        text: "Please broadcast the follow up",
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
        prompt: "Please broadcast the follow up",
        context: {
          readThreadHistory: expect.any(Function),
          sendDirectMessage: expect.any(Function),
        },
      },
      {
        onQueued: expect.any(Function),
        onStarted: expect.any(Function),
        onToolUse: expect.any(Function),
      },
    );
  });

  test("ignores general thread observations but accepts laptop-prefixed prompts", async () => {
    const run = mock(async () => "response");
    createAgent(run);
    const slack = client();
    const mention = app.handlers.get("app_mention")!;
    const message = app.handlers.get("message")!;

    await mention({
      body: { event_id: "E_INTENT_THREAD" },
      event: { user: "U_ALLOWED", text: "start", channel: "C1", ts: "6" },
      client: slack,
    });
    for (const [eventId, text, ts] of [
      ["E_OBSERVATION", "FYI, production is healthy.", "7"],
      ["E_ACK", "Thanks!", "8"],
      ["E_HUMAN", "<@U_JANE> can you review this?", "9"],
    ]) {
      await message({
        body: { event_id: eventId },
        event: {
          channel_type: "channel",
          user: "U_ALLOWED",
          text,
          channel: "C1",
          ts,
          thread_ts: "6",
        },
        client: slack,
      });
    }
    await message({
      body: { event_id: "E_HUMAN_FILE" },
      event: {
        channel_type: "channel",
        subtype: "file_share",
        user: "U_ALLOWED",
        text: "<@U_JANE> here's the log",
        files: [{ id: "F_HUMAN" }],
        channel: "C1",
        ts: "9.5",
        thread_ts: "6",
      },
      client: slack,
    });
    await message({
      body: { event_id: "E_LAPTOP_PREFIX" },
      event: {
        channel_type: "channel",
        user: "U_ALLOWED",
        text: "laptop: check staging",
        channel: "C1",
        ts: "10",
        thread_ts: "6",
      },
      client: slack,
    });

    expect(run).toHaveBeenCalledTimes(2);
    expect(slack.files.info).not.toHaveBeenCalled();
    expect(run).toHaveBeenLastCalledWith(
      expect.objectContaining({ conversationId: "C1:6", prompt: "check staging" }),
      expect.any(Object),
    );
  });

  test("treats a terse message as an answer when the bot asked a question", async () => {
    const responses = ["Which branch should I inspect?", "I'll inspect main."];
    const run = mock(async () => responses.shift()!);
    createAgent(run);
    const slack = client();

    await app.handlers.get("app_mention")!({
      body: { event_id: "E_ASKING_THREAD" },
      event: { user: "U_ALLOWED", text: "inspect a branch", channel: "C1", ts: "11" },
      client: slack,
    });
    await app.handlers.get("message")!({
      body: { event_id: "E_TERSE_ANSWER" },
      event: {
        channel_type: "channel",
        user: "U_ALLOWED",
        text: "main",
        channel: "C1",
        ts: "12",
        thread_ts: "11",
      },
      client: slack,
    });

    expect(run).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenLastCalledWith(
      expect.objectContaining({ conversationId: "C1:11", prompt: "main" }),
      expect.any(Object),
    );
  });

  test("filters unsafe events and silently ignores unauthorized messages", async () => {
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
    await message({
      body: { event_id: "E_DENIED_DM" },
      event: {
        channel_type: "im",
        user: "U_DENIED",
        text: "denied direct message",
        channel: "D1",
        ts: "14",
      },
      client: slack,
    });

    expect(run).toHaveBeenCalledTimes(1);
    expect(slack.chat.postMessage).toHaveBeenCalledTimes(1);
    expect(slack.chat.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ text: "You are not authorized to use this agent." }),
    );
    expect(slack.reactions.add).not.toHaveBeenCalled();
  });

  test("restores channel-thread ownership from a persisted conversation after restart", async () => {
    const persisted = new Set<string>();
    const firstRun = mock(async ({ conversationId }: { conversationId: string }) => {
      persisted.add(conversationId);
      return "first response";
    });
    createAgent(firstRun);
    const slack = client();
    await app.handlers.get("app_mention")!({
      body: { event_id: "E_BEFORE_RESTART" },
      event: { user: "U_ALLOWED", text: "start", channel: "C1", ts: "20" },
      client: slack,
    });

    const restartedRun = mock(async () => "restarted response");
    const hasConversation = mock(async (id: string) => persisted.has(id));
    createAgent(restartedRun, hasConversation);
    const restartedMessage = app.handlers.get("message")!;
    const reply = {
      channel_type: "channel",
      user: "U_ALLOWED",
      text: "Could you follow up?",
      channel: "C1",
      ts: "21",
      thread_ts: "20",
    };
    await restartedMessage({
      body: { event_id: "E_ACCEPTED_AFTER_RESTART" },
      event: reply,
      client: slack,
    });
    for (const [eventId, ts] of [
      ["E_UNRELATED_AFTER_RESTART", "30"],
      ["E_UNRELATED_CACHED", "31"],
    ]) {
      await restartedMessage({
        body: { event_id: eventId },
        event: { ...reply, ts, thread_ts: "29" },
        client: slack,
      });
    }

    expect(restartedRun).toHaveBeenCalledTimes(1);
    expect(restartedRun).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: "C1:20", prompt: "Could you follow up?" }),
      expect.any(Object),
    );
    expect(hasConversation.mock.calls).toEqual([["C1:20"], ["C1:29"]]);
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
    expect(slack.chat.postMessage).toHaveBeenCalledTimes(1);
  });

  test("reports unexpected failures without exposing backend details", async () => {
    const records: RequestLog[] = [];
    const operatorLogs: StructuredLog[] = [];
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
      operatorLog: (record) => operatorLogs.push(record),
    });
    const slack = client();

    await app.handlers.get("app_mention")!({
      body: { event_id: "E_FAILURE" },
      event: { user: "U_ALLOWED", text: "request", channel: "C1", ts: "2" },
      client: slack,
    });

    expect(slack.chat.postMessage).toHaveBeenCalledWith({
      channel: "C1",
      thread_ts: "2",
      text: "The request failed unexpectedly. Try again or contact the operator with request ID `E_FAILURE`.",
    });
    expect(JSON.stringify(slack.chat.postMessage.mock.calls)).not.toContain("secret-token");
    expect(operatorLogs).toEqual([
      {
        event: "operator_error",
        component: "slack",
        message: "Unexpected agent request failure",
        request_id: "E_FAILURE",
        error_type: "Error",
      },
    ]);
    expect(JSON.stringify(operatorLogs)).not.toContain("secret-token");
    expect(slack.reactions.add).toHaveBeenCalledWith({
      channel: "C1",
      timestamp: "2",
      name: "x",
    });
    expect(slack.reactions.remove).not.toHaveBeenCalled();
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

  test("publishes Markdown bold using Slack mrkdwn delimiters", async () => {
    const run = mock(
      async () =>
        "**Still can’t execute privileged shell commands here.** Save your work, then run:\n\n```bash\nsudo shutdown -r now\n```",
    );
    createAgent(run);
    const slack = client();

    await app.handlers.get("app_mention")!({
      body: { event_id: "E_MARKDOWN" },
      event: { user: "U_ALLOWED", text: "request", channel: "C1", ts: "3" },
      client: slack,
    });

    expect(slack.chat.postMessage).toHaveBeenCalledWith({
      channel: "C1",
      thread_ts: "3",
      text: "*Still can’t execute privileged shell commands here.* Save your work, then run:\n\n```bash\nsudo shutdown -r now\n```",
    });
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

    const chunks = slack.chat.postMessage.mock.calls.map(([message]) => message.text as string);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((text) => text.length <= 3_500)).toBe(true);
    expect(chunks.join(" ")).toBe(output);
    expect(
      slack.chat.postMessage.mock.calls.every(
        ([message]) => message.channel === "C1" && message.thread_ts === "4",
      ),
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

    const published = slack.chat.postMessage.mock.calls.map(([message]) => message.text as string);
    expect(published).toHaveLength(3);
    expect(published.every((text) => text.length <= 3_500)).toBe(true);
    expect(published[2]).toContain("Output truncated");
  });

  test("retries one ratelimited final post", async () => {
    new SlackAgent({
      botToken: "xoxb-test",
      appToken: "xapp-test",
      allowedUserIds: new Set(["U_ALLOWED"]),
      agent: backend(mock(async () => "response")),
    });
    const slack = client();
    slack.chat.postMessage.mockImplementationOnce(async () => {
      throw {
        data: {
          error: "ratelimited",
          response_metadata: { retryAfter: 0 },
        },
      };
    });

    await app.handlers.get("app_mention")!({
      body: { event_id: "E_RATE_LIMITED_UPDATE" },
      event: { user: "U_ALLOWED", text: "request", channel: "C1", ts: "4" },
      client: slack,
    });

    expect(slack.chat.postMessage).toHaveBeenCalledTimes(2);
    expect(slack.chat.postMessage.mock.calls[0]?.[0]).toEqual(
      slack.chat.postMessage.mock.calls[1]?.[0],
    );
    expect(slack.chat.update).not.toHaveBeenCalled();
  });

  test("publishes a final reply without an interim message", async () => {
    const records: RequestLog[] = [];
    new SlackAgent({
      botToken: "xoxb-test",
      appToken: "xapp-test",
      allowedUserIds: new Set(["U_ALLOWED"]),
      agent: backend(mock(async () => "response")),
      log: (record) => records.push(record),
    });
    const slack = client();

    await app.handlers.get("app_mention")!({
      body: { event_id: "E_FINAL_ONLY" },
      event: { user: "U_ALLOWED", text: "request", channel: "C1", ts: "5" },
      client: slack,
    });

    expect(slack.chat.postMessage).toHaveBeenCalledWith({
      channel: "C1",
      thread_ts: "5",
      text: "response",
    });
    expect(slack.chat.update).not.toHaveBeenCalled();
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
    let posts = 0;
    slack.chat.postMessage.mockImplementation(async () => {
      if (++posts === 1) return { ts: "first-chunk" };
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
    slack.chat.postMessage.mockImplementation(async () => {
      throw new Error("post unavailable");
    });

    await app.handlers.get("app_mention")!({
      body: { event_id: "E_DELIVERY_FAILURE" },
      event: { user: "U_ALLOWED", text: "request", channel: "C1", ts: "7" },
      client: slack,
    });

    expect(slack.chat.postMessage).toHaveBeenCalledTimes(1);
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

  test("waits for the final reply while another request is queued", async () => {
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
      random: () => 0,
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

    expect(slack.chat.postMessage).not.toHaveBeenCalled();
    expect(slack.chat.update).not.toHaveBeenCalled();

    first.resolve("first response");
    await Promise.all([firstHandling, secondHandling]);
    expect(slack.chat.postMessage.mock.calls.map(([message]) => message.text)).toEqual([
      "first response",
      "second response",
    ]);
  });

  test("publishes one terminal timeout reply", async () => {
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
      slack.chat.postMessage.mock.calls.filter(([message]) =>
        (message.text as string).includes("focused request"),
      ),
    ).toHaveLength(1);
  });

  test("lets an operator cancel another user's request and reports who cancelled", async () => {
    const records: RequestLog[] = [];
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
      allowedUserIds: new Set(["U_ALLOWED", "U_OPERATOR"]),
      operatorUserIds: new Set(["U_OPERATOR"]),
      agent: new QueuedAgentBackend(rawBackend, queueLimits()),
      log: (record) => records.push(record),
      random: () => 0,
    });
    const slack = client();
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
        user: "U_OPERATOR",
        text: "!cancel",
        channel: "C1",
        ts: "12",
        thread_ts: "11",
      },
      client: slack,
    });
    await Promise.all([running, cancelling]);

    expect(slack.chat.postMessage).toHaveBeenCalledWith({
      channel: "C1",
      thread_ts: "11",
      text: "Request cancelled.",
    });
    expect(slack.chat.postMessage).toHaveBeenCalledWith({
      channel: "C1",
      thread_ts: "11",
      text: "<@U_OPERATOR> cancelled the active request.",
    });
    expect(slack.chat.update).not.toHaveBeenCalled();
    expect(records).toContainEqual(
      expect.objectContaining({
        request_id: "E_CANCEL_COMMAND",
        user: "U_OPERATOR",
        cancelled_by: "U_OPERATOR",
      }),
    );
  });

  test("keeps the DM layout and posts only after the reply is ready", async () => {
    const result = deferred<string>();
    const run = mock((_request: unknown, observer?: AgentRunObserver) => {
      observer?.onStarted?.();
      return result.promise;
    });
    new SlackAgent({
      botToken: "xoxb-test",
      appToken: "xapp-test",
      allowedUserIds: new Set(["U_ALLOWED"]),
      agent: backend(run),
      random: () => 0.99,
    });
    const slack = client();

    const handling = app.handlers.get("message")!({
      body: { event_id: "E_PENDING" },
      event: {
        channel_type: "im",
        user: "U_ALLOWED",
        text: "request",
        channel: "D1",
        ts: "5",
      },
      client: slack,
    });
    await Bun.sleep(0);

    expect(slack.chat.postMessage).not.toHaveBeenCalled();
    expect(slack.chat.update).not.toHaveBeenCalled();
    expect(slack.reactions.add).not.toHaveBeenCalled();
    expect(slack.reactions.remove).not.toHaveBeenCalled();

    result.resolve("response");
    await handling;

    expect(slack.chat.postMessage).toHaveBeenCalledTimes(1);
    expect(slack.chat.postMessage).toHaveBeenCalledWith({
      channel: "D1",
      thread_ts: undefined,
      text: "response",
    });
    expect(slack.reactions.add).not.toHaveBeenCalled();
    expect(slack.reactions.remove).not.toHaveBeenCalled();
  });

  test("does not let a failure reaction error mask the error response", async () => {
    const run = mock(async () => {
      throw new Error("backend unavailable");
    });
    createAgent(run);
    const slack = client();
    slack.reactions.add.mockImplementation(async () => {
      throw new Error("reaction unavailable");
    });

    await app.handlers.get("app_mention")!({
      body: { event_id: "E_REACTION_FAILURE" },
      event: { user: "U_ALLOWED", text: "request", channel: "C1", ts: "6" },
      client: slack,
    });

    expect(run).toHaveBeenCalledTimes(1);
    expect(slack.chat.postMessage).toHaveBeenCalledWith({
      channel: "C1",
      thread_ts: "6",
      text: "The request failed unexpectedly. Try again or contact the operator with request ID `E_REACTION_FAILURE`.",
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
        context: { sendDirectMessage: expect.any(Function) },
      },
      {
        onQueued: expect.any(Function),
        onStarted: expect.any(Function),
        onToolUse: expect.any(Function),
      },
    );
  });
});
