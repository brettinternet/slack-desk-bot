import { describe, expect, mock, test } from "bun:test";
import type { AgentBackend } from "../src/agent.ts";

interface SlackEventHandler {
  (input: { event: Record<string, unknown>; client: SlackClient }): Promise<void>;
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

describe("Slack authorization", () => {
  test("rejects unauthorized mentions before invoking the backend", async () => {
    const run = mock(async () => "response");
    const backend: AgentBackend = { run, dispose: () => {} };
    new SlackAgent({
      botToken: "xoxb-test",
      appToken: "xapp-test",
      allowedUserIds: new Set(["U_ALLOWED"]),
      agent: backend,
    });
    const slack = client();

    await app.handlers.get("app_mention")!({
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
    const backend: AgentBackend = { run, dispose: () => {} };
    new SlackAgent({
      botToken: "xoxb-test",
      appToken: "xapp-test",
      allowedUserIds: new Set(["U_ALLOWED"]),
      agent: backend,
    });
    const slack = client();

    await app.handlers.get("app_mention")!({
      event: { user: "U_ALLOWED", text: "request", channel: "C1", ts: "1" },
      client: slack,
    });

    expect(run).toHaveBeenCalledWith({ conversationId: "C1:1", prompt: "request" });
    expect(slack.chat.postMessage).toHaveBeenCalledWith({
      channel: "C1",
      thread_ts: "1",
      text: "response",
    });
  });
});
