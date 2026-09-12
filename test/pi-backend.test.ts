import { describe, expect, test } from "bun:test";
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

function event(value: object): AgentSessionEvent {
  return value as AgentSessionEvent;
}

interface FakeSessionControls {
  disposed: string[];
  names: string[];
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
  test("excludes write tools unless explicitly enabled", () => {
    expect(toolsForMode("read-only")).toEqual(["read", "grep", "find", "ls"]);
    expect(toolsForMode("read-write")).toEqual(["read", "grep", "find", "ls", "edit", "write"]);
  });

  test("appends Slack-specific instructions to the system prompt", async () => {
    const { resourceLoader } = createPiResources(process.cwd(), "Keep Slack replies brief.");
    await resourceLoader.reload();

    expect(resourceLoader.getAppendSystemPrompt()).toContain("Keep Slack replies brief.");
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
      sessionLister: async () => [sessionInfo()],
      sessionFactory: async (manager) => {
        openedPath = manager.getSessionFile();
        return fakeSession(manager, controls);
      },
    });

    await backend.run({ conversationId: "thread", requesterId: "user", prompt: "continue" });
    expect(openedPath).toBe("/tmp/persisted-slack-session.jsonl");
    expect(controls.names).toEqual([]);
    backend.dispose();
  });

  test("bounds live sessions with LRU eviction", async () => {
    const controls: FakeSessionControls = { disposed: [], names: [] };
    const created: string[] = [];
    const backend = new PiBackend(process.cwd(), {
      sessionDir: "/tmp",
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

  test("status does not create a session", async () => {
    let creations = 0;
    const backend = new PiBackend(process.cwd(), {
      sessionDir: "/tmp",
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
