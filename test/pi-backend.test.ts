import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentSession,
  type AgentSessionEvent,
  type SessionInfo,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
  AgentResponseError,
  createPiResources,
  createResponseCollector,
  PiBackend,
  preparePiPrompt,
  toolsForMode,
} from "../src/pi-backend.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function testConversationStorePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "slack-pi-index-"));
  temporaryDirectories.push(directory);
  return join(directory, "conversations.json");
}

function event(value: object): AgentSessionEvent {
  return value as AgentSessionEvent;
}

interface FakeSessionControls {
  disposed: string[];
  names: string[];
  model?: AgentSession["model"];
  stats?: Partial<ReturnType<AgentSession["getSessionStats"]>>;
  onPrompt?: () => Promise<void>;
  onAbort?: () => Promise<void>;
}

function fakeSession(manager: SessionManager, controls: FakeSessionControls): AgentSession {
  const id = manager.getSessionId();
  return {
    sessionId: id,
    sessionFile: manager.getSessionFile(),
    subscribe: () => () => {},
    prompt: async () => controls.onPrompt?.(),
    abort: async () => controls.onAbort?.(),
    dispose: () => controls.disposed.push(id),
    setSessionName: (name: string) => controls.names.push(name),
    model: controls.model,
    getSessionStats: () => ({
      sessionId: id,
      sessionFile: manager.getSessionFile(),
      userMessages: 0,
      assistantMessages: 0,
      toolCalls: 0,
      toolResults: 0,
      totalMessages: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      cost: 0,
      ...controls.stats,
    }),
  } as unknown as AgentSession;
}

function sessionInfo(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    path: "/tmp/persisted-slack-session.jsonl",
    id: "persisted-session-id",
    cwd: process.cwd(),
    name: "slack-agent:thread",
    created: new Date("2025-01-01T00:00:00Z"),
    modified: new Date("2025-01-02T00:00:00Z"),
    messageCount: 4,
    firstMessage: "hello",
    allMessagesText: "hello",
    ...overrides,
  };
}

describe("Pi configuration", () => {
  test("selects file and brokered tools independently", () => {
    expect(toolsForMode("read-only")).toEqual(["read", "grep", "find", "ls"]);
    expect(toolsForMode("read-write")).toEqual(["read", "grep", "find", "ls", "edit", "write"]);
    expect(toolsForMode("read-only", "brokered")).toEqual([
      "read",
      "grep",
      "find",
      "ls",
      "git_inspect",
      "repo_fun",
      "system_info",
    ]);
    expect(toolsForMode("read-write", "brokered")).toEqual([
      "read",
      "grep",
      "find",
      "ls",
      "edit",
      "write",
      "git_inspect",
      "repo_fun",
      "system_info",
    ]);
  });

  test("loads only the service-owned broker when explicitly enabled", async () => {
    const disabled = createPiResources(process.cwd());
    const enabled = createPiResources(process.cwd(), { commandMode: "brokered" });
    await disabled.resourceLoader.reload();
    await enabled.resourceLoader.reload();

    expect(
      disabled.resourceLoader
        .getExtensions()
        .extensions.some((extension) => extension.path === "<inline:slack-brokered-tools>"),
    ).toBe(false);
    expect(
      enabled.resourceLoader
        .getExtensions()
        .extensions.some((extension) => extension.path === "<inline:slack-brokered-tools>"),
    ).toBe(true);
  });

  test("loads the conversation-scoped thread history tool when configured", async () => {
    const { resourceLoader } = createPiResources(process.cwd(), {
      threadHistoryReader: async () => ({ messages: [] }),
    });
    await resourceLoader.reload();

    expect(
      resourceLoader
        .getExtensions()
        .extensions.some((extension) => extension.path === "<inline:slack-thread-history-tool>"),
    ).toBe(true);
  });

  test("loads the requester-scoped direct message tool when configured", async () => {
    const { resourceLoader } = createPiResources(process.cwd(), {
      directMessageSender: async () => ({
        recipientId: "U0BOB",
        recipientName: "Bob",
        channel: "D1",
        ts: "1.1",
      }),
    });
    await resourceLoader.reload();

    expect(
      resourceLoader
        .getExtensions()
        .extensions.some((extension) => extension.path === "<inline:slack-direct-message-tool>"),
    ).toBe(true);
  });

  test("loads the conversation-scoped schedule tool when configured", async () => {
    const { resourceLoader } = createPiResources(process.cwd(), {
      scheduleActions: () => ({
        list: () => [],
        create: () => {
          throw new Error("test");
        },
        update: () => {
          throw new Error("test");
        },
        cancel: () => {},
      }),
    });
    await resourceLoader.reload();
    expect(
      resourceLoader
        .getExtensions()
        .extensions.some((extension) => extension.path === "<inline:slack-schedule-tool>"),
    ).toBe(true);
  });

  test("appends Slack-specific instructions to the system prompt", async () => {
    const { resourceLoader } = createPiResources(process.cwd(), {
      instructions: "Keep Slack replies brief.",
    });
    await resourceLoader.reload();

    expect(resourceLoader.getAppendSystemPrompt()).toContain("Keep Slack replies brief.");
  });

  test("does not load tools from user-level extensions", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "slack-agent-user-resources-"));
    const workspace = mkdtempSync(join(tmpdir(), "slack-agent-workspace-"));
    const marker = `__slack_agent_user_extension_${randomUUID().replaceAll("-", "")}`;
    const extensionPath = join(agentDir, "extensions", "user.ts");
    mkdirSync(join(agentDir, "extensions"), { recursive: true });
    writeFileSync(
      extensionPath,
      `export default function (pi) {
        globalThis[${JSON.stringify(marker)}] = true;
        pi.registerTool({
          name: "unsafe_user_tool",
          label: "Unsafe",
          description: "Must not load",
          parameters: { type: "object", properties: {} },
          execute: async () => ({ content: [{ type: "text", text: "unsafe" }], details: {} }),
        });
      }`,
    );

    try {
      const { resourceLoader } = createPiResources(workspace, { agentDir });
      await resourceLoader.reload();
      const extensions = resourceLoader.getExtensions().extensions;

      expect((globalThis as Record<string, unknown>)[marker]).toBeUndefined();
      expect(extensions.map((extension) => extension.path)).not.toContain(extensionPath);
      expect(
        extensions.some((extension) => extension.path === "<inline:slack-workspace-policy>"),
      ).toBe(true);
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("never loads extensions or system prompts from the target workspace", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "slack-agent-trust-"));
    const marker = `__slack_agent_untrusted_${randomUUID().replaceAll("-", "")}`;
    const extensionPath = join(workspace, ".pi", "extensions", "project.ts");
    mkdirSync(join(workspace, ".pi", "extensions"), { recursive: true });
    writeFileSync(
      extensionPath,
      `export default function () { globalThis[${JSON.stringify(marker)}] = true; }`,
    );
    writeFileSync(join(workspace, ".pi", "SYSTEM.md"), "Project-controlled system prompt");

    try {
      const { settingsManager, resourceLoader } = createPiResources(workspace);
      await resourceLoader.reload();

      expect(settingsManager.isProjectTrusted()).toBe(false);
      expect((globalThis as Record<string, unknown>)[marker]).toBeUndefined();
      expect(
        resourceLoader.getExtensions().extensions.map((extension) => extension.path),
      ).not.toContain(extensionPath);
      expect(resourceLoader.getSystemPrompt()).not.toBe("Project-controlled system prompt");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

describe("Pi attachment input", () => {
  test("formats text files and passes images separately", () => {
    expect(
      preparePiPrompt("Review these", [
        { kind: "text", name: "notes.md", mediaType: "text/markdown", text: "# Notes" },
        { kind: "image", name: "screen.png", mediaType: "image/png", data: "cG5n" },
      ]),
    ).toEqual({
      text: 'Review these\n\n<slack-file name="notes.md" media-type="text/markdown">\n# Notes\n</slack-file>',
      images: [{ type: "image", data: "cG5n", mimeType: "image/png" }],
    });
  });

  test("supplies a prompt for image-only messages", () => {
    expect(
      preparePiPrompt("", [
        { kind: "image", name: "screen.png", mediaType: "image/png", data: "cG5n" },
      ]).text,
    ).toBe("Review the attached Slack file(s).");
  });
});

describe("Pi response collection", () => {
  test("counts each started tool execution", () => {
    let toolCount = 0;
    const collector = createResponseCollector({ onToolUse: () => toolCount++ });

    collector.handle(event({ type: "tool_execution_start" }));
    collector.handle(event({ type: "tool_execution_update" }));
    collector.handle(event({ type: "tool_execution_end" }));
    collector.handle(event({ type: "tool_execution_start" }));

    expect(toolCount).toBe(2);
  });

  test("keeps completed assistant messages and separates turns", () => {
    const collector = createResponseCollector();
    collector.handle(event({ type: "message_start", message: { role: "assistant" } }));
    collector.handle(
      event({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "Inspecting" },
      }),
    );
    collector.handle(
      event({
        type: "message_end",
        message: { role: "assistant", stopReason: "toolUse" },
      }),
    );
    collector.handle(event({ type: "message_start", message: { role: "assistant" } }));
    collector.handle(
      event({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "Done" },
      }),
    );
    collector.handle(
      event({
        type: "message_end",
        message: { role: "assistant", stopReason: "stop" },
      }),
    );

    expect(collector.text()).toBe("Inspecting\n\nDone");
  });

  test("discards partial text from failed attempts", () => {
    const collector = createResponseCollector();
    collector.handle(event({ type: "message_start", message: { role: "assistant" } }));
    collector.handle(
      event({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "partial" },
      }),
    );
    collector.handle(
      event({
        type: "message_end",
        message: { role: "assistant", stopReason: "error" },
      }),
    );
    collector.handle(event({ type: "message_start", message: { role: "assistant" } }));
    collector.handle(
      event({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "complete" },
      }),
    );
    collector.handle(
      event({
        type: "message_end",
        message: { role: "assistant", stopReason: "stop" },
      }),
    );

    expect(collector.text()).toBe("complete");
  });

  test("reports a failure instead of silently returning earlier text when the final turn errors", () => {
    const collector = createResponseCollector();
    collector.handle(event({ type: "message_start", message: { role: "assistant" } }));
    collector.handle(
      event({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "Looking into it" },
      }),
    );
    collector.handle(
      event({ type: "message_end", message: { role: "assistant", stopReason: "toolUse" } }),
    );
    collector.handle(event({ type: "message_start", message: { role: "assistant" } }));
    collector.handle(
      event({
        type: "message_end",
        message: { role: "assistant", stopReason: "error", errorMessage: "rate limited" },
      }),
    );

    expect(() => collector.text()).toThrow(AgentResponseError);
  });
});

describe("Pi session management", () => {
  test("opens the persisted session for a conversation", async () => {
    const controls: FakeSessionControls = { disposed: [], names: [] };
    let openedPath: string | undefined;
    const backend = new PiBackend(process.cwd(), {
      sessionDir: "/tmp",
      conversationStorePath: testConversationStorePath(),
      sessionLister: async () => [sessionInfo()],
      sessionFactory: async (manager) => {
        openedPath = manager.getSessionFile();
        return fakeSession(manager, controls);
      },
    });

    expect(await backend.hasConversation("thread")).toBe(true);
    expect(await backend.hasConversation("unrelated")).toBe(false);
    await backend.run({ conversationId: "thread", requesterId: "user", prompt: "continue" });
    expect(openedPath).toBe("/tmp/persisted-slack-session.jsonl");
    expect(controls.names).toEqual([]);
    backend.dispose();
  });

  test("lists safe conversation metadata and excludes reset archives", async () => {
    const backend = new PiBackend(process.cwd(), {
      sessionDir: "/tmp",
      conversationStorePath: testConversationStorePath(),
      sessionLister: async () => [
        sessionInfo(),
        sessionInfo({
          id: "archived-session-id",
          name: "slack-agent:thread:reset:123",
        }),
      ],
    });

    expect(await backend.listConversations()).toEqual([
      {
        conversationId: "thread",
        sessionId: "persisted-session-id",
        state: "inactive",
        lastActiveAt: new Date("2025-01-02T00:00:00Z").getTime(),
      },
    ]);
    backend.dispose();
  });

  test("migrates existing sessions once and uses the persisted index after restart", async () => {
    const conversationStorePath = testConversationStorePath();
    let scans = 0;
    const migrating = new PiBackend(process.cwd(), {
      sessionDir: "/tmp",
      conversationStorePath,
      sessionLister: async () => {
        scans++;
        return [sessionInfo()];
      },
    });

    expect(await migrating.hasConversation("thread")).toBe(true);
    migrating.dispose();

    const restored = new PiBackend(process.cwd(), {
      sessionDir: "/tmp",
      conversationStorePath,
      sessionLister: async () => {
        scans++;
        return [];
      },
    });
    expect(await restored.hasConversation("thread")).toBe(true);
    expect(await restored.hasConversation("missing")).toBe(false);
    expect(await restored.listConversations()).toHaveLength(1);
    expect(scans).toBe(1);
    restored.dispose();
  });

  test("bounds live sessions with LRU eviction", async () => {
    const controls: FakeSessionControls = { disposed: [], names: [] };
    const created: string[] = [];
    const backend = new PiBackend(process.cwd(), {
      sessionDir: "/tmp",
      conversationStorePath: testConversationStorePath(),
      maxActiveSessions: 1,
      sessionLister: async () => [],
      freshSessionManagerFactory: () => SessionManager.inMemory(process.cwd()),
      sessionFactory: async (manager) => {
        created.push(manager.getSessionId());
        return fakeSession(manager, controls);
      },
    });

    await backend.run({ conversationId: "one", requesterId: "user", prompt: "a" });
    await backend.run({ conversationId: "two", requesterId: "user", prompt: "b" });
    expect(created).toHaveLength(2);
    expect(controls.disposed).toContain(created[0]);
    backend.dispose();
  });

  test("reports live model, context usage, and cumulative cost", async () => {
    const controls: FakeSessionControls = {
      disposed: [],
      names: [],
      model: { provider: "anthropic", id: "claude-sonnet" } as AgentSession["model"],
      stats: {
        totalMessages: 7,
        cost: 1.23456,
        contextUsage: { tokens: 40_000, contextWindow: 100_000, percent: 40 },
      },
    };
    const backend = new PiBackend(process.cwd(), {
      sessionDir: "/tmp",
      conversationStorePath: testConversationStorePath(),
      sessionLister: async () => [],
      freshSessionManagerFactory: () => SessionManager.inMemory(process.cwd()),
      sessionFactory: async (manager) => fakeSession(manager, controls),
    });

    await backend.run({ conversationId: "thread", requesterId: "user", prompt: "work" });

    expect(await backend.sessionCommand("thread", "status")).toContain(
      "State: idle\nModel: anthropic/claude-sonnet\nMessages: 7\nContext: 40.0%\nCost: $1.235",
    );
    backend.dispose();
  });

  test("keeps persisted-only status unchanged without creating a session", async () => {
    let creations = 0;
    const backend = new PiBackend(process.cwd(), {
      sessionDir: "/tmp",
      conversationStorePath: testConversationStorePath(),
      sessionLister: async () => [sessionInfo()],
      sessionFactory: async (manager) => {
        creations++;
        return fakeSession(manager, { disposed: [], names: [] });
      },
    });

    expect(await backend.sessionCommand("thread", "status")).toBe(
      "Session: persiste\nState: inactive\nMessages: 4\nLast active: 2025-01-02T00:00:00.000Z\nPersisted: yes",
    );
    expect(creations).toBe(0);
    backend.dispose();
  });

  test("status does not create a missing session", async () => {
    let creations = 0;
    const backend = new PiBackend(process.cwd(), {
      sessionDir: "/tmp",
      conversationStorePath: testConversationStorePath(),
      sessionLister: async () => [],
      sessionFactory: async (manager) => {
        creations++;
        return fakeSession(manager, { disposed: [], names: [] });
      },
    });

    expect(await backend.sessionCommand("missing", "status")).toBe(
      "No session exists for this conversation.",
    );
    expect(creations).toBe(0);
    backend.dispose();
  });

  test("aborts an active request through its signal", async () => {
    let finish!: () => void;
    const prompt = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const controls: FakeSessionControls = {
      disposed: [],
      names: [],
      onPrompt: () => prompt,
      onAbort: async () => finish(),
    };
    const backend = new PiBackend(process.cwd(), {
      sessionDir: "/tmp",
      conversationStorePath: testConversationStorePath(),
      sessionLister: async () => [],
      freshSessionManagerFactory: () => SessionManager.inMemory(process.cwd()),
      sessionFactory: async (manager) => fakeSession(manager, controls),
    });

    const controller = new AbortController();
    const cancellation = new Error("cancelled");
    const running = backend.run({
      conversationId: "thread",
      requesterId: "user",
      prompt: "work",
      signal: controller.signal,
    });
    await Bun.sleep(0);
    controller.abort(cancellation);
    await expect(running).rejects.toBe(cancellation);
    backend.dispose();
  });
});
