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
  };
}

function backend(run: ReturnType<typeof mock>): CancellableAgentBackend {
  return { run, cancelActive: () => false, dispose: () => {} };
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
});
