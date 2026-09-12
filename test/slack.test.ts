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
  chat: { postMessage: ReturnType<typeof mock> };
  reactions: { add: ReturnType<typeof mock> };
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
    chat: { postMessage: mock(async () => {}) },
    reactions: { add: mock(async () => {}) },
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

describe("Slack authorization", () => {
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
