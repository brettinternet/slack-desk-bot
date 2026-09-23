import { afterEach, describe, expect, test } from "bun:test";
import { lstat, mkdtemp, rmdir } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { QueuedAgentBackend, type AgentBackend, type QueueLimits } from "../src/agent.ts";
import { ConversationCoordinator } from "../src/conversation-coordinator.ts";
import { LocalControlServer, MAX_LOCAL_FRAME_BYTES } from "../src/local-control.ts";

const limits: QueueLimits = {
  timeoutMs: 1_000,
  queueWaitMs: 1_000,
  maxQueuedPerConversation: 2,
  maxConcurrentConversations: 1,
  maxGlobalQueue: 4,
  maxPendingPerRequester: 4,
  rateLimitBurst: 10,
  rateLimitRefillMs: 1_000,
};

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    try {
      await rmdir(directory);
    } catch {}
  }
});

async function socketPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "slack-desk-control-"));
  directories.push(directory);
  return join(directory, "control.sock");
}

class ProtocolClient {
  private buffer = "";
  private readonly messages: any[] = [];
  private waiters: Array<{
    predicate: (message: any) => boolean;
    resolve: (message: any) => void;
  }> = [];

  private constructor(readonly socket: Socket) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      this.buffer += String(chunk);
      let newline: number;
      while ((newline = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        if (line) this.push(JSON.parse(line));
      }
    });
  }

  static connect(path: string): Promise<ProtocolClient> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(path);
      socket.once("connect", () => resolve(new ProtocolClient(socket)));
      socket.once("error", reject);
    });
  }

  send(type: string, requestId: string, fields = {}): void {
    this.socket.write(`${JSON.stringify({ v: 1, type, requestId, ...fields })}\n`);
  }

  next(): Promise<any> {
    return this.waitFor(() => true);
  }

  response(requestId: string): Promise<any> {
    return this.waitFor(
      (message) => message.type === "response" && message.requestId === requestId,
    );
  }

  event(type: string): Promise<any> {
    return this.waitFor((message) => message.type === "event" && message.event.type === type);
  }

  private waitFor(predicate: (message: any) => boolean): Promise<any> {
    const index = this.messages.findIndex(predicate);
    if (index >= 0) return Promise.resolve(this.messages.splice(index, 1)[0]);
    return new Promise((resolve) => this.waiters.push({ predicate, resolve }));
  }

  private push(message: unknown): void {
    const index = this.waiters.findIndex(({ predicate }) => predicate(message));
    if (index >= 0) this.waiters.splice(index, 1)[0]!.resolve(message);
    else this.messages.push(message);
  }
}

function fixture(run?: AgentBackend["run"]) {
  const calls: string[] = [];
  const backend: AgentBackend = {
    hasConversation: async (id) => id === "C123:100.1",
    listConversations: async () => [
      {
        conversationId: "C123:100.1",
        sessionId: "f82ab719-full-session-id",
        state: "idle",
        lastActiveAt: 1_700_000_000_000,
      },
    ],
    run:
      run ??
      (async ({ prompt }) => {
        calls.push(prompt);
        return `answer:${prompt}`;
      }),
    sessionCommand: async (_, command) => (command === "status" ? "State: idle" : "reset"),
    dispose: () => {},
  };
  const coordinator = new ConversationCoordinator(new QueuedAgentBackend(backend, limits));
  return { calls, coordinator };
}

describe("local conversation control", () => {
  test("orders Slack and operator turns in one conversation and publishes bounded events", async () => {
    const path = await socketPath();
    const { calls, coordinator } = fixture();
    const exchanges: unknown[] = [];
    coordinator.onOperatorExchange((exchange) => {
      exchanges.push(exchange);
    });
    coordinator.onOperatorExchange(async () => {
      throw new Error("Slack delivery unavailable");
    });
    const inspectedLimits: number[] = [];
    const inspector = {
      inspectConversation: async (_conversationId: string, historyLimit: number) => {
        inspectedLimits.push(historyLimit);
        return {
          label: "#engineering / deploys",
          participants: [{ id: "U123", name: "Jane" }],
          history:
            historyLimit > 0
              ? [
                  {
                    timestamp: 1_700_000_000_000,
                    authorName: "Jane",
                    kind: "user" as const,
                    text: "Ship it",
                  },
                ]
              : [],
        };
      },
    };
    const server = new LocalControlServer({ socketPath: path, coordinator, inspector });
    await server.start();
    const client = await ProtocolClient.connect(path);

    client.send("list", "list");
    expect((await client.response("list")).result[0]).toMatchObject({
      sessionId: "f82ab719-full-session-id",
      conversationId: "C123:100.1",
      details: { label: "#engineering / deploys", history: [] },
    });
    client.send("attach", "attach", { sessionId: "f82ab719", historyLimit: 5 });
    expect((await client.response("attach")).result).toMatchObject({
      details: { history: [{ authorName: "Jane", text: "Ship it" }] },
    });
    expect(inspectedLimits).toEqual([0, 5]);

    const slack = coordinator.run({
      conversationId: "C123:100.1",
      requesterId: "U123",
      prompt: `from Slack\n${"x".repeat(220)}`,
    });
    expect((await client.event("queued")).event).toEqual({
      type: "queued",
      conversationId: "C123:100.1",
      requesterKind: "slack",
      promptExcerpt: `from Slack ${"x".repeat(188)}…`,
    });
    expect((await client.event("started")).event).toEqual({
      type: "started",
      conversationId: "C123:100.1",
      requesterKind: "slack",
      promptExcerpt: `from Slack ${"x".repeat(188)}…`,
    });
    client.send("run", "run", { prompt: "from terminal" });
    expect(await slack).toBe(`answer:from Slack\n${"x".repeat(220)}`);
    expect((await client.event("queued")).event).toMatchObject({
      requesterKind: "operator",
      promptExcerpt: "from terminal",
    });
    expect((await client.response("run")).result).toEqual({ response: "answer:from terminal" });
    expect(calls).toEqual([`from Slack\n${"x".repeat(220)}`, "from terminal"]);
    expect(exchanges).toEqual([
      {
        conversationId: "C123:100.1",
        prompt: "from terminal",
        response: "answer:from terminal",
      },
    ]);

    client.socket.destroy();
    await server.stop();
    coordinator.dispose();
  });

  test("supports status, operator cancellation, disconnect, and reconnect", async () => {
    const path = await socketPath();
    const { coordinator } = fixture(
      ({ signal }) =>
        new Promise((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason))),
    );
    const server = new LocalControlServer({ socketPath: path, coordinator });
    await server.start();
    let client = await ProtocolClient.connect(path);
    client.send("attach", "a1", { sessionId: "f82ab719" });
    await client.response("a1");
    client.send("run", "run", { prompt: "wait" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    client.send("cancel", "cancel");
    expect((await client.response("cancel")).result).toEqual({ cancelled: true });
    expect((await client.response("run")).ok).toBe(false);
    client.socket.destroy();

    client = await ProtocolClient.connect(path);
    client.send("attach", "a2", { sessionId: "f82ab719" });
    await client.response("a2");
    client.send("status", "status");
    expect((await client.response("status")).result).toEqual({ status: "State: idle" });
    client.socket.destroy();
    await server.stop();
    coordinator.dispose();
  });

  test("sends operator direct messages without attaching to a session", async () => {
    const path = await socketPath();
    const { coordinator } = fixture();
    const sent: unknown[] = [];
    const server = new LocalControlServer({
      socketPath: path,
      coordinator,
      sendDirectMessage: async (message) => {
        sent.push(message);
        return { recipientId: "U0BOB", recipientName: "Bob", channel: "D1", ts: "1.1" };
      },
    });
    await server.start();
    const client = await ProtocolClient.connect(path);

    client.send("dm", "dm", { userId: "U0BOB", text: "hello" });
    expect((await client.response("dm")).result).toMatchObject({ recipientName: "Bob" });
    client.send("dm", "bad", { userId: "U0BOB" });
    expect((await client.response("bad")).error).toBe("userId and text are required");
    expect(sent).toEqual([{ userId: "U0BOB", text: "hello" }]);

    client.socket.destroy();
    await server.stop();
    coordinator.dispose();
  });

  test("rejects malformed, oversized, unauthorized, and colliding clients", async () => {
    const path = await socketPath();
    const { coordinator } = fixture();
    const server = new LocalControlServer({ socketPath: path, coordinator });
    const permissive = process.umask(0o000);
    try {
      await server.start();
    } finally {
      process.umask(permissive);
    }
    // Owner-only from the first accept, even under a permissive umask.
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    expect((await lstat(dirname(path))).mode & 0o777).toBe(0o700);
    await expect(new LocalControlServer({ socketPath: path, coordinator }).start()).rejects.toThrow(
      "Another SlackDeskBot process",
    );

    const client = await ProtocolClient.connect(path);
    client.socket.write("not json\n");
    expect((await client.next()).ok).toBe(false);
    client.socket.write(`${"x".repeat(MAX_LOCAL_FRAME_BYTES + 1)}\n`);
    expect((await client.next()).error).toContain("maximum size");
    client.socket.destroy();
    await server.stop();

    const denied = new LocalControlServer({
      socketPath: path,
      coordinator,
      acceptPeer: () => false,
    });
    await denied.start();
    const unauthorized = await ProtocolClient.connect(path);
    await new Promise<void>((resolve) => unauthorized.socket.once("close", () => resolve()));
    await denied.stop();
    coordinator.dispose();
  });
});
