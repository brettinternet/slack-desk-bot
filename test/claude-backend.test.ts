import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
  ClaudeBackend,
  ClaudeCapabilityError,
  ClaudeOutputError,
  ClaudeProviderError,
  claudeSandboxProfile,
  prepareClaudePrompt,
} from "../src/claude-backend.ts";

interface FakeRun {
  events: string[];
  code?: number;
  wait?: boolean;
}
function fakeSpawner(runs: FakeRun[], calls: string[][]) {
  return ((command: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
    const run = runs.shift();
    if (!run) throw new Error("Unexpected spawn");
    calls.push([command, ...args]);
    expect(options.env?.ANTHROPIC_API_KEY).toBeUndefined();
    const child = new EventEmitter() as EventEmitter & {
      stdin: PassThrough;
      stdout: PassThrough;
      stderr: PassThrough;
      kill: () => boolean;
    };
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {
      queueMicrotask(() => {
        child.stdout.end();
        child.stderr.end();
        child.emit("close", null, "SIGTERM");
      });
      return true;
    };
    child.stdin.once("finish", () => {
      if (run.wait) return;
      queueMicrotask(() => {
        for (const event of run.events) child.stdout.write(`${event}\n`);
        child.stdout.end();
        child.stderr.end();
        child.emit("close", run.code ?? 0, null);
      });
    });
    return child;
  }) as never;
}
function backend(
  runs: FakeRun[],
  calls: string[][],
  mode: "read-only" | "read-write" = "read-only",
) {
  const root = mkdtempSync(join(tmpdir(), "slack-desk-claude-"));
  const workspace = join(root, "workspace");
  const home = join(root, "home");
  mkdirSync(workspace);
  mkdirSync(home);
  writeFileSync(join(workspace, "visible.txt"), "visible");
  return {
    root,
    backend: new ClaudeBackend(workspace, {
      executable: "/usr/bin/true",
      home,
      mode,
      platform: "darwin",
      spawnProcess: fakeSpawner(runs, calls),
    }),
    workspace,
    home,
  };
}
const success = (id: string, result: string): FakeRun => ({
  events: [
    JSON.stringify({ type: "system", subtype: "init", session_id: id }),
    JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", name: "Read", input: { file_path: "visible.txt" } }],
      },
    }),
    JSON.stringify({ type: "result", subtype: "success", is_error: false, result, session_id: id }),
  ],
});

describe("Claude input and policy", () => {
  test("inlines text and rejects images", () => {
    expect(
      prepareClaudePrompt(
        "Review",
        [{ kind: "text", name: "a.txt", mediaType: "text/plain", text: "hello" }],
        "Be brief",
      ),
    ).toContain('<slack-file name="a.txt" media-type="text/plain">\nhello');
    expect(() =>
      prepareClaudePrompt("Review", [
        { kind: "image", name: "a.png", mediaType: "image/png", data: "x" },
      ]),
    ).toThrow(ClaudeCapabilityError);
  });
  test("grants Claude's fixed runtime directories write access without widening the workspace", () => {
    const root = mkdtempSync(join(tmpdir(), "slack-desk-claude-profile-"));
    const workspace = join(root, "workspace");
    const home = join(root, "home");
    mkdirSync(workspace);
    mkdirSync(home);
    try {
      const readOnly = claudeSandboxProfile(workspace, home, "/usr/bin/true", "read-only");
      const readWrite = claudeSandboxProfile(workspace, home, "/usr/bin/true", "read-write");
      const uid = process.getuid?.() ?? 0;
      expect(readOnly).toContain(`(allow file-write* (subpath "/private/tmp/claude-${uid}"))`);
      expect(readOnly).toContain('(allow file-write* (subpath "/private/tmp/cc-socks"))');
      expect(readOnly).not.toContain(
        `allow file-write* (subpath ${JSON.stringify(realpathSync(workspace))})`,
      );
      expect(readWrite).toContain(
        `allow file-write* (subpath ${JSON.stringify(realpathSync(workspace))})`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("Claude sessions and stream output", () => {
  test("persists and resumes exact session, reports tool use and mode arguments", async () => {
    const calls: string[][] = [];
    const first = backend([success("session-123", "first")], calls, "read-write");
    try {
      let tools = 0;
      expect(
        await first.backend.run(
          { conversationId: "C1", requesterId: "U1", prompt: "hello" },
          { onToolUse: () => tools++ },
        ),
      ).toBe("first");
      expect(tools).toBe(1);
      expect(readFileSync(join(first.home, "conversations.json"), "utf8")).toContain("session-123");
      first.backend.dispose();
      const resumed = new ClaudeBackend(first.workspace, {
        executable: "/usr/bin/true",
        home: first.home,
        mode: "read-write",
        platform: "darwin",
        spawnProcess: fakeSpawner([success("session-123", "second")], calls),
      });
      expect(
        await resumed.run({ conversationId: "C1", requesterId: "U1", prompt: "continue" }),
      ).toBe("second");
      expect(calls[0]).toContain("--session-id");
      expect(calls[0]).toContain("--tools");
      expect(calls[0]).toContain("Read,Glob,Grep,Edit,Write");
      expect(calls[0]).toContain("--restricted");
      expect(calls[0]).toContain("--disable-slash-commands");
      expect(calls[0]).not.toContain("hello");
      expect(calls.at(-1)).toContain("--resume");
      expect(calls.at(-1)).toContain("session-123");
      expect(calls.at(-1)).not.toContain("Bash");
      resumed.dispose();
    } finally {
      rmSync(first.root, { recursive: true, force: true });
    }
  });
  test("rejects provider, malformed, and nonzero output without persisting failures", async () => {
    for (const [run, error] of [
      [
        {
          events: [
            JSON.stringify({ type: "result", subtype: "error", is_error: true, result: "bad" }),
          ],
        },
        ClaudeProviderError,
      ],
      [{ events: ["not-json"] }, ClaudeOutputError],
      [{ events: [], code: 2 }, ClaudeOutputError],
    ] as Array<[FakeRun, new (...args: never[]) => Error]>) {
      const calls: string[][] = [];
      const item = backend([run], calls);
      try {
        await expect(
          item.backend.run({ conversationId: "C", requesterId: "U", prompt: "x" }),
        ).rejects.toBeInstanceOf(error);
        expect(await item.backend.hasConversation("C")).toBe(false);
      } finally {
        item.backend.dispose();
        rmSync(item.root, { recursive: true, force: true });
      }
    }
  });
  test("cancels and disposes active processes", async () => {
    const item = backend([{ events: [], wait: true }], []);
    const controller = new AbortController();
    const reason = new Error("cancelled");
    try {
      const pending = item.backend.run({
        conversationId: "C",
        requesterId: "U",
        prompt: "wait",
        signal: controller.signal,
      });
      controller.abort(reason);
      await expect(pending).rejects.toBe(reason);
    } finally {
      item.backend.dispose();
      rmSync(item.root, { recursive: true, force: true });
    }
  });
});
