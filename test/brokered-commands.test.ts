import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BrokeredCommandExecutor,
  type BrokeredCommandSpec,
  executeBrokeredCommand,
  runGitInspection,
  runSystemInfo,
} from "../src/brokered-commands.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), "slack-brokered-"));
  temporaryDirectories.push(workspace);
  return workspace;
}

function initializeRepository(): string {
  const workspace = temporaryWorkspace();
  execFileSync("/usr/bin/git", ["init", "-q", workspace]);
  execFileSync("/usr/bin/git", ["-C", workspace, "config", "user.name", "Test User"]);
  execFileSync("/usr/bin/git", ["-C", workspace, "config", "user.email", "test@example.com"]);
  writeFileSync(join(workspace, "visible.ts"), "export const answer = 42;\n");
  writeFileSync(join(workspace, ".env"), "SECRET=hidden\n");
  execFileSync("/usr/bin/git", ["-C", workspace, "add", "visible.ts", ".env"]);
  execFileSync("/usr/bin/git", ["-C", workspace, "commit", "-q", "-m", "Initial commit"]);
  return workspace;
}

function successful(stdout = "ok\n") {
  return { stdout, stderr: "", code: 0, signal: null } as const;
}

describe("brokered command process", () => {
  test("passes arguments literally without shell interpretation", async () => {
    const workspace = temporaryWorkspace();
    const result = await executeBrokeredCommand({
      executable: "/usr/bin/printf",
      arguments: ["%s", "hello; /usr/bin/false"],
      cwd: workspace,
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("hello; /usr/bin/false");
  });

  test("replaces the service environment instead of inheriting credentials", async () => {
    const workspace = temporaryWorkspace();
    const result = await executeBrokeredCommand({
      executable: "/usr/bin/env",
      arguments: [],
      cwd: workspace,
    });

    expect(result.stdout).toContain("HOME=/var/empty");
    expect(result.stdout).toContain("GIT_TERMINAL_PROMPT=0");
    expect(result.stdout).not.toContain("SLACK_");
  });

  test("enforces command timeout and capture limits", async () => {
    const workspace = temporaryWorkspace();
    await expect(
      executeBrokeredCommand({
        executable: "/bin/sleep",
        arguments: ["2"],
        cwd: workspace,
        timeoutMs: 10,
      }),
    ).rejects.toThrow("timed out");
    await expect(
      executeBrokeredCommand({
        executable: "/usr/bin/yes",
        arguments: [],
        cwd: workspace,
      }),
    ).rejects.toThrow("capture limit");
  });
});

describe("Git inspection broker", () => {
  test("supports useful repository, history, and authorship operations", async () => {
    const workspace = initializeRepository();

    expect(await runGitInspection({ action: "overview" }, workspace)).toContain("Initial commit");
    expect(await runGitInspection({ action: "log" }, workspace)).toContain("Initial commit");
    expect(await runGitInspection({ action: "contributors" }, workspace)).toContain("Test User");
    expect(
      await runGitInspection({ action: "show_file", path: "visible.ts" }, workspace),
    ).toContain("answer = 42");
    expect(await runGitInspection({ action: "blame", path: "visible.ts" }, workspace)).toContain(
      "Test User",
    );
    expect(
      await runGitInspection({ action: "file_history", path: "visible.ts" }, workspace),
    ).toContain("Initial commit");
    expect(await runGitInspection({ action: "stats" }, workspace)).toContain("Tracked files: 1");
    expect(await runGitInspection({ action: "hotspots" }, workspace)).toContain("visible.ts");
  });

  test("shows literal file diffs while omitting sensitive status paths", async () => {
    const workspace = initializeRepository();
    writeFileSync(join(workspace, "visible.ts"), "export const answer = 43;\n");
    writeFileSync(join(workspace, ".env"), "SECRET=changed\n");

    const status = await runGitInspection({ action: "status" }, workspace);
    const diff = await runGitInspection({ action: "diff", path: "visible.ts" }, workspace);

    expect(status).toContain("visible.ts");
    expect(status).not.toContain(".env");
    expect(diff).toContain("answer = 43");
    expect(diff).not.toContain("SECRET");

    execFileSync("/usr/bin/git", ["-C", workspace, "add", "visible.ts"]);
    expect(
      await runGitInspection({ action: "diff", path: "visible.ts", staged: true }, workspace),
    ).toContain("answer = 43");

    writeFileSync(join(workspace, "new.ts"), "export const fresh = true;\n");
    expect(await runGitInspection({ action: "diff", path: "new.ts" }, workspace)).toContain(
      "+export const fresh = true;",
    );
  });

  test("rejects missing, outside, symlinked, sensitive, and option-like paths", async () => {
    const workspace = initializeRepository();
    const outside = temporaryWorkspace();
    writeFileSync(join(outside, "outside.ts"), "outside\n");
    symlinkSync(join(outside, "outside.ts"), join(workspace, "escape.ts"));

    await expect(runGitInspection({ action: "diff" }, workspace)).rejects.toThrow(
      "path is required",
    );
    await expect(
      runGitInspection({ action: "show_file", path: "../outside.ts" }, workspace),
    ).rejects.toThrow("inside the configured workspace");
    await expect(
      runGitInspection({ action: "show_file", path: "escape.ts" }, workspace),
    ).rejects.toThrow("outside the configured workspace");
    await expect(
      runGitInspection({ action: "show_file", path: ".env" }, workspace),
    ).rejects.toThrow("sensitive workspace paths");
    await expect(
      runGitInspection({ action: "show_file", path: ".git/config" }, workspace),
    ).rejects.toThrow("sensitive workspace paths");
  });

  test("rejects revision and line-range injection", async () => {
    const workspace = initializeRepository();

    await expect(
      runGitInspection(
        { action: "show_file", path: "visible.ts", revision: "HEAD; touch owned" },
        workspace,
      ),
    ).rejects.toThrow("simple commit ID");
    await expect(
      runGitInspection({ action: "blame", path: "visible.ts", startLine: 1 }, workspace),
    ).rejects.toThrow("provided together");
    await expect(
      runGitInspection(
        { action: "blame", path: "visible.ts", startLine: 2, endLine: 1 },
        workspace,
      ),
    ).rejects.toThrow("endLine");
  });

  test("refuses to inspect an enclosing repository from a workspace subdirectory", async () => {
    const repository = initializeRepository();
    const workspace = join(repository, "packages", "app");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(repository, "sibling-secret.txt"), "not in workspace\n");

    await expect(runGitInspection({ action: "status" }, workspace)).rejects.toThrow(
      "requires SLACK_AGENT_CWD to be the repository root",
    );
    await expect(
      runGitInspection({ action: "show_file", path: "sibling-secret.txt" }, workspace),
    ).rejects.toThrow("refusing to inspect an enclosing repository");
  });

  test("uses only the fixed Git executable and hardened arguments", async () => {
    const workspace = initializeRepository();
    const calls: BrokeredCommandSpec[] = [];
    const execute: BrokeredCommandExecutor = async (spec) => {
      calls.push(spec);
      return successful(
        spec.arguments.includes("--show-toplevel")
          ? `${realpathSync(workspace)}\n`
          : "abc123 2025-01-01 Test — Message\n",
      );
    };

    await runGitInspection({ action: "log", limit: 3 }, workspace, undefined, execute);

    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.executable === "/usr/bin/git")).toBe(true);
    expect(calls[1]?.arguments).toContain("core.pager=cat");
    expect(calls[1]?.arguments).not.toContain("sh");
    expect(calls[1]?.arguments).toContain("-3");
  });

  test("filters sensitive files from hotspot aggregation", async () => {
    const workspace = initializeRepository();
    const execute: BrokeredCommandExecutor = async (spec) =>
      successful(
        spec.arguments.includes("--show-toplevel")
          ? `${realpathSync(workspace)}\n`
          : "visible.ts\n.env\nvisible.ts\n.pi/agent/config.json\n",
      );

    const result = await runGitInspection(
      { action: "hotspots", days: 14 },
      workspace,
      undefined,
      execute,
    );

    expect(result).toContain("visible.ts — 2 commits");
    expect(result).not.toContain(".env");
    expect(result).not.toContain(".pi");
  });
});

describe("macOS system information broker", () => {
  test("maps every action to a fixed executable and fixed arguments", async () => {
    const workspace = temporaryWorkspace();
    const calls: BrokeredCommandSpec[] = [];
    const execute: BrokeredCommandExecutor = async (spec) => {
      calls.push(spec);
      return successful();
    };
    const actions = [
      "battery",
      "uptime",
      "os_version",
      "disk_space",
      "memory_pressure",
      "thermal_pressure",
      "computer_name",
      "clock",
      "kernel",
    ] as const;

    for (const action of actions) {
      expect(await runSystemInfo({ action }, workspace, undefined, execute, "darwin")).toBe("ok");
    }

    expect(calls.map((call) => call.executable)).toEqual([
      "/usr/bin/pmset",
      "/usr/bin/uptime",
      "/usr/bin/sw_vers",
      "/bin/df",
      "/usr/bin/memory_pressure",
      "/usr/bin/pmset",
      "/usr/sbin/scutil",
      "/bin/date",
      "/usr/bin/uname",
    ]);
    expect(calls[0]?.arguments).toEqual(["-g", "batt"]);
    expect(calls[3]?.arguments).toEqual(["-h", realpathSync(workspace)]);
    expect(calls[5]?.arguments).toEqual(["-g", "therm"]);
  });

  test("does not claim host support on non-macOS systems", async () => {
    const workspace = temporaryWorkspace();
    await expect(
      runSystemInfo({ action: "battery" }, workspace, undefined, undefined, "linux"),
    ).rejects.toThrow("only on macOS");
  });
});
