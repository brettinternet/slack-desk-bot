import { describe, expect, mock, test } from "bun:test";
import type { CancellableAgentBackend } from "../src/agent.ts";

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

class MockSlackApp {
  readonly handlers = new Map<string, SlackEventHandler>();

  constructor() {
    app = this;
  }

  event(name: string, handler: SlackEventHandler): void {
    this.handlers.set(name, handler);
  }
}

mock.module("@slack/bolt", () => ({
  App: MockSlackApp,
  LogLevel: { INFO: "info" },
}));

const { SlackAgent } = await import("../src/slack.ts");

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

describe("SlackAgent transport", () => {
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

    expect(run).toHaveBeenCalledWith({
      conversationId: "C1:1",
      requesterId: "U_ALLOWED",
      prompt: "request",
    });
    expect(slack.chat.postMessage).toHaveBeenCalledWith({
      channel: "C1",
      thread_ts: "1",
      text: "Working…",
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
    expect(run).toHaveBeenCalledWith({
      conversationId: "C1:1",
      requesterId: "U_ALLOWED",
      prompt: "thread request",
    });
    expect(run).toHaveBeenCalledWith({
      conversationId: "dm:D1",
      requesterId: "U_ALLOWED",
      prompt: "dm request",
    });
    expect(slack.chat.postMessage.mock.calls[0]?.[0]).toEqual({
      channel: "C1",
      thread_ts: "1",
      text: "Working…",
    });
    expect(slack.chat.postMessage.mock.calls[1]?.[0]).toEqual({
      channel: "D1",
      thread_ts: undefined,
      text: "Working…",
    });
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

  test("reports failures and clears the working reaction", async () => {
    const run = mock(async () => {
      throw new Error("backend unavailable");
    });
    new SlackAgent({
      botToken: "xoxb-test",
      appToken: "xapp-test",
      allowedUserIds: new Set(["U_ALLOWED"]),
      agent: backend(run),
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
      text: "Agent request failed: backend unavailable",
    });
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

    expect(run).toHaveBeenCalledWith({
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
    });
  });
});
