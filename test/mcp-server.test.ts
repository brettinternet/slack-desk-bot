import { expect, test } from "bun:test";
import { mkdtemp, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { type AgentBackend, QueuedAgentBackend } from "../src/agent.ts";
import { ConversationCoordinator } from "../src/conversation-coordinator.ts";
import { LocalControlServer } from "../src/local-control.ts";
import { createMcpServer } from "../src/mcp-server.ts";

test("MCP advertises lookup and explicit-ID DM and forwards through the socket", async () => {
  const directory = await mkdtemp(join(tmpdir(), "slack-mcp-"));
  const socketPath = join(directory, "control.sock");
  const backend: AgentBackend = {
    run: async () => "unused",
    dispose: () => {},
  };
  const coordinator = new ConversationCoordinator(
    new QueuedAgentBackend(backend, {
      timeoutMs: 1_000,
      queueWaitMs: 1_000,
      maxQueuedPerConversation: 1,
      maxConcurrentConversations: 1,
      maxGlobalQueue: 1,
      maxPendingPerRequester: 1,
      rateLimitBurst: 1,
      rateLimitRefillMs: 1_000,
    }),
  );
  const sent: unknown[] = [];
  const local = new LocalControlServer({
    socketPath,
    coordinator,
    findPeople: async (query) => [{ userId: "U0BOB", name: query, match: "name" }],
    sendDirectMessage: async (message) => {
      sent.push(message);
      if (message.text === "slow") await new Promise((resolve) => setTimeout(resolve, 70));
      return { recipientId: message.userId, recipientName: "Bob", channel: "D1", ts: "1" };
    },
  });
  await local.start();
  const server = createMcpServer(socketPath);
  const client = new Client({ name: "test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    expect((await client.listTools()).tools.map(({ name }) => name).sort()).toEqual([
      "find_people",
      "send_dm",
    ]);
    const lookup = await client.callTool({ name: "find_people", arguments: { query: "Bob" } });
    expect(lookup.content).toEqual([
      { type: "text", text: '[{"userId":"U0BOB","name":"Bob","match":"name"}]' },
    ]);
    expect(sent).toEqual([]);
    const invalid = await client.callTool({
      name: "send_dm",
      arguments: { user_id: "Bob", text: "hi" },
    });
    expect(invalid.isError).toBe(true);
    expect(sent).toEqual([]);
    const receipt = await client.callTool({
      name: "send_dm",
      arguments: { user_id: "U0BOB", text: "hi" },
    });
    expect(receipt.content).toEqual([
      {
        type: "text",
        text: '{"recipientId":"U0BOB","recipientName":"Bob","channel":"D1","ts":"1"}',
      },
    ]);
    expect(sent).toEqual([{ userId: "U0BOB", text: "hi" }]);

    const shortServer = createMcpServer(socketPath, 20);
    const shortClient = new Client({ name: "short-timeout", version: "1" });
    const [shortClientTransport, shortServerTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([
        shortClient.connect(shortClientTransport),
        shortServer.connect(shortServerTransport),
      ]);
      const unknown = await shortClient.callTool({
        name: "send_dm",
        arguments: { user_id: "U0BOB", text: "slow" },
      });
      expect(unknown.isError).toBe(true);
      expect(JSON.stringify(unknown)).toContain("Do not resend");
      expect(sent).toEqual([
        { userId: "U0BOB", text: "hi" },
        { userId: "U0BOB", text: "slow" },
      ]);
      await new Promise((resolve) => setTimeout(resolve, 80));
    } finally {
      await shortClient.close();
      await shortServer.close();
    }

    // Exercise the actual stdio entrypoint, not just its in-process tool registration.
    const stdioClient = new Client({ name: "stdio-test", version: "1" });
    const stdio = new StdioClientTransport({
      command: process.execPath,
      args: [join(import.meta.dir, "../src/mcp-server.ts")],
      env: { ...process.env, SLACK_AGENT_SOCKET_PATH: socketPath } as Record<string, string>,
    });
    try {
      await stdioClient.connect(stdio);
      expect((await stdioClient.listTools()).tools).toHaveLength(2);
      const result = await stdioClient.callTool({
        name: "find_people",
        arguments: { query: "Bob" },
      });
      expect(result.content).toEqual(lookup.content);
    } finally {
      await stdioClient.close();
    }
  } finally {
    await client.close();
    await server.close();
    await local.stop();
    coordinator.dispose();
    await rmdir(directory);
  }
});
