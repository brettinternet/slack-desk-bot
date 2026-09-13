import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import {
  CodexBackend,
  CodexCapabilityError,
  CodexOutputError,
  CodexProviderError,
  prepareCodexPrompt,
} from "../src/codex-backend.ts";

interface FakeRun {
  events: string[];
  code?: number;
  stderr?: string;
  wait?: boolean;
  exitBeforeEvents?: boolean;
  /** Destroys stdin before the prompt is written, reproducing an EPIPE. */
  stdinEpipe?: boolean;
}

function fakeSpawner(runs: FakeRun[], calls: string[][]) {
  return ((command: string, args: readonly string[]) => {
    const run = runs.shift();
    if (!run) throw new Error("Unexpected spawn");
    calls.push([command, ...args]);
    const child = new EventEmitter() as EventEmitter & {
      stdin: PassThrough;
      stdout: PassThrough;
      stderr: PassThrough;
      kill: (signal?: string) => boolean;
    };
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {
      queueMicrotask(() => {
        child.emit("exit", null, "SIGTERM");
        child.stdout.end();
        child.stderr.end();
        child.emit("close", null, "SIGTERM");
      });
      return true;
    };
    if (run.stdinEpipe) {
      child.stdin.destroy(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
      queueMicrotask(() => {
        child.stdout.end();
        child.stderr.write(run.stderr ?? "");
        child.stderr.end();
        child.emit("close", run.code ?? 1, null);
      });
    }
    child.stdin.once("finish", () => {
      if (run.wait) return;
      queueMicrotask(() => {
        if (run.exitBeforeEvents) child.emit("exit", run.code ?? 0, null);
        for (const event of run.events) child.stdout.write(`${event}\n`);
        if (run.stderr) child.stderr.write(run.stderr);
        child.stdout.end();
        child.stderr.end();
        if (!run.exitBeforeEvents) child.emit("exit", run.code ?? 0, null);
        child.emit("close", run.code ?? 0, null);
      });
    });
    return child;
  }) as never;
}

function temporaryBackend(runs: FakeRun[], calls: string[][], now = () => 1234) {
  const home = mkdtempSync(join(tmpdir(), "slack-desk-codex-home-"));
  const backend = new CodexBackend(process.cwd(), {
    executable: "/usr/bin/true",
    home,
    now,
    spawnProcess: fakeSpawner(runs, calls),
  });
  return { backend, home };
}

const success = (threadId: string, text: string): FakeRun => ({
  events: [
    JSON.stringify({ type: "thread.started", thread_id: threadId }),
    JSON.stringify({ type: "turn.started" }),
    JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text },
    }),
    JSON.stringify({ type: "turn.completed" }),
  ],
});

describe("Codex input", () => {
  test("inlines text attachments and instructions", () => {
    expect(
      prepareCodexPrompt(
        "Review it",
        [{ kind: "text", name: "notes.md", mediaType: "text/markdown", text: "# Notes" }],
        "Be concise.",
      ),
    ).toBe(
      'Be concise.\n\nReview it\n\n<slack-file name="notes.md" media-type="text/markdown">\n# Notes\n</slack-file>',
    );
  });

  test("rejects images instead of writing them to disk", () => {
    expect(() =>
      prepareCodexPrompt("Review", [
        { kind: "image", name: "screen.png", mediaType: "image/png", data: "cG5n" },
      ]),
    ).toThrow(CodexCapabilityError);
  });
});

describe("Codex sessions", () => {
  test("creates, persists, restores, and resumes the exact thread", async () => {
    const calls: string[][] = [];
    const first = temporaryBackend([success("thread-123", "first")], calls);
    try {
      expect(
        await first.backend.run({ conversationId: "C1:1", requesterId: "U1", prompt: "hello" }),
      ).toBe("first");
      first.backend.dispose();

      const restored = new CodexBackend(process.cwd(), {
        executable: "/usr/bin/true",
        home: first.home,
        spawnProcess: fakeSpawner([success("thread-123", "second")], calls),
      });
      expect(await restored.hasConversation("C1:1")).toBe(true);
      expect((await restored.listConversations())[0]?.sessionId).toBe("thread-123");
      expect(
        await restored.run({ conversationId: "C1:1", requesterId: "U1", prompt: "continue" }),
      ).toBe("second");
      expect(calls[0]).toContain("--sandbox");
      expect(calls[1]).toContain("resume");
      expect(calls[1]).toContain("thread-123");
      expect(calls[1]).not.toContain("--sandbox");
      expect(calls[1]).toContain('sandbox_mode="read-only"');
      restored.dispose();
    } finally {
      rmSync(first.home, { recursive: true, force: true });
    }
  });

  test("reports tools, status, reset, and retained provider history", async () => {
    const calls: string[][] = [];
    const run = success("thread-456", "done");
    run.events.splice(
      1,
      0,
      JSON.stringify({ type: "item.started", item: { type: "command_execution" } }),
    );
    const { backend, home } = temporaryBackend([run], calls);
    let tools = 0;
    try {
      await backend.run(
        { conversationId: "C2:2", requesterId: "U2", prompt: "inspect" },
        { onToolUse: () => tools++ },
      );
      expect(tools).toBe(1);
      expect(await backend.sessionCommand("C2:2", "status")).toContain(
        "Session: thread-4\nState: inactive\nBackend: Codex CLI\nMode: read-only",
      );
      expect(await backend.sessionCommand("C2:2", "reset")).toContain(
        "Previous Codex history was retained",
      );
      expect(await backend.hasConversation("C2:2")).toBe(false);
    } finally {
      backend.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("cancels an active process and disposal terminates remaining processes", async () => {
    const calls: string[][] = [];
    const first = temporaryBackend([{ events: [], wait: true }], calls);
    try {
      const controller = new AbortController();
      const cancelled = new Error("cancelled");
      const pending = first.backend.run({
        conversationId: "C3:3",
        requesterId: "U3",
        prompt: "wait",
        signal: controller.signal,
      });
      controller.abort(cancelled);
      await expect(pending).rejects.toBe(cancelled);

      const second = first.backend.run({
        conversationId: "C4:4",
        requesterId: "U4",
        prompt: "wait",
      });
      first.backend.dispose();
      await expect(second).rejects.toThrow();
    } finally {
      rmSync(first.home, { recursive: true, force: true });
    }
  });
});

describe("Codex output", () => {
  test("drains final JSONL emitted after process exit", async () => {
    const calls: string[][] = [];
    const run = { ...success("thread-drain", "complete"), exitBeforeEvents: true };
    const { backend, home } = temporaryBackend([run], calls);
    try {
      await expect(
        backend.run({ conversationId: "C", requesterId: "U", prompt: "hello" }),
      ).resolves.toBe("complete");
    } finally {
      backend.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("reports stdin failures and stderr instead of crashing the service", async () => {
    const unhandled: unknown[] = [];
    const capture = (error: unknown) => unhandled.push(error);
    process.on("unhandledRejection", capture);
    process.on("uncaughtException", capture);
    const epipe = temporaryBackend([{ events: [], stdinEpipe: true, code: 1 }], []);
    try {
      await expect(
        epipe.backend.run({ conversationId: "C", requesterId: "U", prompt: "hello" }),
      ).rejects.toThrow(/did not accept the prompt|EPIPE/);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", capture);
      process.off("uncaughtException", capture);
      epipe.backend.dispose();
      rmSync(epipe.home, { recursive: true, force: true });
    }

    const failing = temporaryBackend([{ events: [], code: 3, stderr: "boom: bad flag" }], []);
    try {
      await expect(
        failing.backend.run({ conversationId: "C", requesterId: "U", prompt: "hello" }),
      ).rejects.toThrow("boom: bad flag");
    } finally {
      failing.backend.dispose();
      rmSync(failing.home, { recursive: true, force: true });
    }
  });

  test("starts with an empty mapping when the store is corrupt", async () => {
    const home = mkdtempSync(join(tmpdir(), "slack-desk-codex-corrupt-"));
    try {
      writeFileSync(join(home, "conversations.json"), '{"version":1,"conversations":{"C1:1"');
      const backend = new CodexBackend(process.cwd(), {
        executable: "/usr/bin/true",
        home,
        spawnProcess: fakeSpawner([success("thread-new", "fresh")], []),
      });
      expect(await backend.hasConversation("C1:1")).toBe(false);
      expect(await backend.run({ conversationId: "C1:1", requesterId: "U", prompt: "hello" })).toBe(
        "fresh",
      );
      backend.dispose();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("rejects malformed output, provider failures, and nonzero exits", async () => {
    const cases: Array<[FakeRun, new (...args: never[]) => Error]> = [
      [{ events: ["not-json"] }, CodexOutputError],
      [
        {
          events: [
            JSON.stringify({ type: "thread.started", thread_id: "t" }),
            JSON.stringify({ type: "turn.failed", error: { message: "rate limited" } }),
          ],
        },
        CodexProviderError,
      ],
      [{ events: [], code: 2, stderr: "bad invocation" }, CodexOutputError],
    ];
    for (const [run, errorType] of cases) {
      const { backend, home } = temporaryBackend([run], []);
      try {
        await expect(
          backend.run({ conversationId: "C", requesterId: "U", prompt: "hello" }),
        ).rejects.toBeInstanceOf(errorType);
      } finally {
        backend.dispose();
        rmSync(home, { recursive: true, force: true });
      }
    }
  });
});
