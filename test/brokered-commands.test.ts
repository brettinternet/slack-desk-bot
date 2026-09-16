import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitSlackIdentityResolver } from "../src/git-slack-identities.ts";
import {
  type BrokeredCommandExecutor,
  type BrokeredCommandSpec,
  executeBrokeredCommand,
  runGitInspection,
  runRepoFun,
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

function initializeRepository(workspace = temporaryWorkspace()): string {
  mkdirSync(workspace, { recursive: true });
  execFileSync("/usr/bin/git", ["init", "-q", "-b", "main", workspace]);
  execFileSync("/usr/bin/git", ["-C", workspace, "config", "user.name", "Test User"]);
  execFileSync("/usr/bin/git", ["-C", workspace, "config", "user.email", "test@example.com"]);
  writeFileSync(join(workspace, "visible.ts"), "export const answer = 42;\n");
  writeFileSync(join(workspace, ".env"), "SECRET=hidden\n");
  execFileSync("/usr/bin/git", ["-C", workspace, "add", "visible.ts", ".env"]);
  execFileSync("/usr/bin/git", [
    "-C",
    workspace,
    "commit",
    "-q",
    "--author=Test User <test@example.com>",
    "-m",
    "Initial commit",
  ]);
  return workspace;
}

function repositoryWithHistory(): string {
  const workspace = initializeRepository();
  mkdirSync(join(workspace, "src"));
  writeFileSync(join(workspace, "visible.ts"), "export const answer = 43;\n");
  writeFileSync(join(workspace, "src", "second.ts"), "export const second = true;\n");
  execFileSync("/usr/bin/git", ["-C", workspace, "add", "visible.ts", "src/second.ts"]);
  execFileSync("/usr/bin/git", ["-C", workspace, "config", "user.name", "Second User"]);
  execFileSync("/usr/bin/git", ["-C", workspace, "config", "user.email", "second@example.com"]);
  execFileSync("/usr/bin/git", [
    "-C",
    workspace,
    "commit",
    "-q",
    "--author=Second User <second@example.com>",
    "-m",
    "Add second feature",
  ]);
  execFileSync("/usr/bin/git", ["-C", workspace, "tag", "v1", "HEAD~1"]);
  execFileSync("/usr/bin/git", ["-C", workspace, "branch", "stale-example", "HEAD~1"]);
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
        executable: process.execPath,
        arguments: ["-e", 'process.stdout.write("x".repeat(1024 * 1024 + 1))'],
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

  test("maps canonical commit emails to Slack users in contributor reports", async () => {
    const workspace = initializeRepository();
    const resolver = new GitSlackIdentityResolver(async () => [
      { id: "U0123", email: "test@example.com", name: "Test Person" },
    ]);

    expect(
      await runGitInspection({ action: "identities" }, workspace, undefined, undefined, resolver),
    ).toContain("Test User <test@example.com> → Test Person (U0123, email)");
    expect(
      await runGitInspection({ action: "contributors" }, workspace, undefined, undefined, resolver),
    ).toContain("Test User (Slack: Test Person, U0123)");
  });

  test("selects a nested repository without broadening workspace access", async () => {
    const workspace = temporaryWorkspace();
    const repository = initializeRepository(join(workspace, "houston"));

    expect(
      await runGitInspection(
        { action: "blame", repository: "houston", path: "visible.ts" },
        workspace,
      ),
    ).toContain("Test User");
    writeFileSync(join(repository, ".env"), "SECRET=changed\n");
    const overview = await runGitInspection(
      { action: "overview", repository: "houston" },
      workspace,
    );
    expect(overview).toContain("Initial commit");
    expect(overview).not.toContain(".env");

    const outside = initializeRepository();
    symlinkSync(outside, join(workspace, "linked-repository"));
    await expect(
      runGitInspection({ action: "overview", repository: "linked-repository" }, workspace),
    ).rejects.toThrow("inside the configured workspace");
    await expect(
      runGitInspection({ action: "overview", repository: "../outside" }, workspace),
    ).rejects.toThrow("inside the configured workspace");
    expect(repository).toBe(join(workspace, "houston"));
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
    ).rejects.toThrow("inside the selected repository");
    await expect(
      runGitInspection({ action: "show_file", path: "escape.ts" }, workspace),
    ).rejects.toThrow("outside the selected repository");
    await expect(
      runGitInspection({ action: "show_file", path: ".env" }, workspace),
    ).rejects.toThrow("sensitive workspace paths");
    await expect(
      runGitInspection({ action: "show_file", path: ".git/config" }, workspace),
    ).rejects.toThrow("sensitive workspace paths");

    // `git blame` accepts one literal pathname, not a pathspec; wildcard-looking names must not
    // expand to a tracked sensitive file.
    await expect(runGitInspection({ action: "blame", path: ".env*" }, workspace)).rejects.toThrow(
      "no such path",
    );
    await expect(
      runGitInspection({ action: "file_ownership", path: ".env*" }, workspace),
    ).rejects.toThrow("no such path");
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

  test("refuses to inspect an enclosing repository from a selected subdirectory", async () => {
    const repository = initializeRepository();
    const workspace = join(repository, "packages", "app");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(repository, "sibling-secret.txt"), "not in workspace\n");

    await expect(runGitInspection({ action: "status" }, workspace)).rejects.toThrow(
      "must identify a Git repository root",
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

  test("provides the complete local repository insight catalog", async () => {
    const workspace = repositoryWithHistory();
    const results = await Promise.all([
      runGitInspection({ action: "commit_details" }, workspace),
      runGitInspection({ action: "search_commits", query: "second" }, workspace),
      runGitInspection(
        { action: "branch_divergence", baseRevision: "HEAD~1", headRevision: "HEAD" },
        workspace,
      ),
      runGitInspection(
        { action: "release_notes", baseRevision: "HEAD~1", headRevision: "HEAD" },
        workspace,
      ),
      runGitInspection({ action: "activity_calendar" }, workspace),
      runGitInspection({ action: "code_age" }, workspace),
      runGitInspection({ action: "file_ownership", path: "visible.ts" }, workspace),
      runGitInspection({ action: "bus_factor" }, workspace),
      runGitInspection({ action: "stale_branches" }, workspace),
      runGitInspection({ action: "largest_files" }, workspace),
      runGitInspection({ action: "oldest_files" }, workspace),
      runGitInspection({ action: "change_coupling" }, workspace),
      runGitInspection({ action: "commit_streaks" }, workspace),
      runGitInspection({ action: "repo_health" }, workspace),
      runGitInspection({ action: "contributor_trivia" }, workspace),
    ]);

    for (const result of results) expect(result.length).toBeGreaterThan(10);
    expect(results[0]).toContain("Subject: Add second feature");
    expect(results[1]).toContain("Add second feature");
    expect(results[2]).toContain("Head HEAD: 1 unique commit");
    expect(results[3]).toContain("Add second feature");
    expect(results[5]).toContain("Tracked files aged");
    expect(results[6]).toContain("Second User");
    expect(results[10]).toContain("visible.ts");
    expect(results[11]).toContain("src/second.ts ↔ visible.ts");
    expect(results[13]).toContain("Branch: main");
    expect(results[14]).toContain("Most prolific contributor");

    const initial = await runGitInspection(
      { action: "commit_details", revision: "HEAD~1" },
      workspace,
    );
    expect(initial).toContain("visible.ts");
    expect(initial).not.toContain(".env");
  });

  test("validates fixed-string and ref inputs for new insights", async () => {
    const workspace = repositoryWithHistory();
    await expect(runGitInspection({ action: "search_commits" }, workspace)).rejects.toThrow(
      "query is required",
    );
    await expect(
      runGitInspection(
        { action: "branch_divergence", baseRevision: "HEAD; touch nope" },
        workspace,
      ),
    ).rejects.toThrow("simple commit ID");
    await expect(
      runGitInspection({ action: "activity_calendar", days: 2 }, workspace),
    ).rejects.toThrow("days");
  });
});

describe("repository fun broker", () => {
  test("generates every playful report without adding side effects", async () => {
    const workspace = repositoryWithHistory();
    const actions = [
      "personality",
      "birthday",
      "ancient_artifacts",
      "hot_zone",
      "team_constellation",
      "commit_weather",
      "fortune",
      "activity_sparkline",
      "milestones",
      "trivia",
    ] as const;

    const results = await Promise.all(actions.map((action) => runRepoFun({ action }, workspace)));

    expect(results.every((result) => result.length > 15)).toBe(true);
    expect(results[0]).toContain("Repository personality");
    expect(results[1]).toContain("Codebase birthday");
    expect(results[4]).toContain("Team constellation");
    expect(results[6]).toContain("Repository fortune");
    expect(results[7]).toMatch(/[▁▂▃▄▅▆▇█]/);
    expect(results[9]).not.toContain("second@example.com");
  });

  test("selects a nested repository within the workspace boundary", async () => {
    const workspace = temporaryWorkspace();
    initializeRepository(join(workspace, "nested"));

    const result = await runRepoFun({ action: "birthday", repository: "nested" }, workspace);

    expect(result).toContain("Codebase birthday");
    expect(result).toContain("Initial commit");
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

  test("provides and redacts the expanded host insight catalog", async () => {
    const workspace = temporaryWorkspace();
    const execute: BrokeredCommandExecutor = async (spec) => {
      const joined = `${spec.executable} ${spec.arguments.join(" ")}`;
      if (joined.includes("SPPowerDataType")) {
        return successful(
          JSON.stringify({
            SPPowerDataType: [
              {
                sppower_battery_health_info: {
                  sppower_battery_health: "Good",
                  sppower_battery_health_maximum_capacity: "97%",
                  sppower_battery_cycle_count: 42,
                },
                sppower_battery_charge_info: {
                  sppower_battery_state_of_charge: 80,
                  sppower_battery_is_charging: "TRUE",
                },
                sppower_battery_model_info: { sppower_battery_serial_number: "PRIVATE-SERIAL" },
              },
            ],
          }),
        );
      }
      if (joined.includes("SPDisplaysDataType")) {
        return successful(
          JSON.stringify({
            SPDisplaysDataType: [
              {
                spdisplays_ndrvs: [
                  {
                    _name: "Studio Display",
                    _spdisplays_resolution: "2560 x 1440 @ 60Hz",
                    _spdisplays_pixels: "5120 x 2880",
                    _spdisplays_display_serial_number: "PRIVATE-DISPLAY-SERIAL",
                    spdisplays_main: "spdisplays_yes",
                  },
                ],
              },
            ],
          }),
        );
      }
      if (spec.executable === "/usr/bin/vm_stat") {
        return successful(
          "Mach Virtual Memory Statistics: (page size of 4096 bytes)\nPages free: 100.\nPages active: 200.\nPages inactive: 300.\nPages speculative: 10.\nPages wired down: 50.\nPages occupied by compressor: 25.\n",
        );
      }
      if (spec.executable === "/usr/sbin/sysctl") {
        return successful(
          spec.arguments.includes("hw.memsize")
            ? "17179869184\ntotal = 1.00G  used = 0.25G  free = 0.75G\n"
            : "Apple Test CPU\n8\n10\n",
        );
      }
      if (spec.executable === "/bin/df") {
        return successful(
          "Filesystem Size Used Avail Capacity Mounted on\n/dev/test 1Ti 1Gi 999Gi 1% /\n",
        );
      }
      if (joined.includes("pmset -g custom")) {
        return successful(
          "Battery Power:\n sleep 5\n displaysleep 10\n hibernatefile /private/secret\nAC Power:\n sleep 0\n",
        );
      }
      if (spec.executable === "/usr/bin/xcodebuild")
        return successful("Xcode 26.0\nBuild version TEST\n");
      if (spec.executable === "/usr/bin/clang")
        return successful("Apple clang version 17\nTarget: arm64\n");
      if (joined.includes("pmset -g batt")) return successful("Now drawing from AC Power\n");
      if (joined.includes("pmset -g therm")) return successful("No thermal warning\n");
      if (spec.executable === "/usr/bin/memory_pressure")
        return successful("System-wide memory free percentage: 70%\n");
      if (spec.executable === "/usr/bin/uptime")
        return successful("up 4 days, load averages: 1 1 1\n");
      if (spec.executable.endsWith("/hum")) {
        return successful(
          JSON.stringify({
            state: "running",
            readiness: "ready",
            started_at: new Date(Date.now() - 60_000).toISOString(),
            restart_count: 3,
            relaunches: 1,
            argv: ["private", "ignored"],
          }),
        );
      }
      return successful("tool 1.0\n");
    };

    const actions = [
      "battery_health",
      "cpu_summary",
      "memory_summary",
      "volume_summary",
      "power_settings",
      "developer_tools",
      "runtime_versions",
      "display_summary",
      "system_pressure",
      "service_health",
    ] as const;
    const results = await Promise.all(
      actions.map((action) => runSystemInfo({ action }, workspace, undefined, execute, "darwin")),
    );

    expect(results.every((result) => result.length > 10)).toBe(true);
    expect(results[0]).toContain("Cycle count: 42");
    expect(results[0]).not.toContain("PRIVATE-SERIAL");
    expect(results[1]).toContain("Physical cores: 8");
    expect(results[2]).toContain("Installed:");
    expect(results[4]).not.toContain("hibernatefile");
    expect(results[5]).toContain("Xcode 26.0");
    expect(results[6]).toContain("Bun:");
    expect(results[7]).toContain("Studio Display (main)");
    expect(results[7]).not.toContain("PRIVATE-DISPLAY-SERIAL");
    expect(results[8]).toContain("System pressure verdict: normal");
    expect(results[8]).toContain("Disk: Workspace volume");
    expect(results[9]).toContain("Readiness: ready");
    expect(results[9]).toContain("Restart count: 3");
  });

  test("reports container-scoped Linux facts without claiming Docker host access", async () => {
    const workspace = temporaryWorkspace();
    const calls: BrokeredCommandSpec[] = [];
    const execute: BrokeredCommandExecutor = async (spec) => {
      calls.push(spec);
      return successful(
        spec.executable === "/bin/df"
          ? "Filesystem Size Used Avail Use% Mounted on\n/dev/test 10G 1G 9G 10% /workspace\n"
          : "tool 1.0\n",
      );
    };

    const os = await runSystemInfo(
      { action: "os_version" },
      workspace,
      undefined,
      execute,
      "linux",
    );
    const memory = await runSystemInfo(
      { action: "memory_summary" },
      workspace,
      undefined,
      execute,
      "linux",
    );
    const volume = await runSystemInfo(
      { action: "volume_summary" },
      workspace,
      undefined,
      execute,
      "linux",
    );
    const pressure = await runSystemInfo(
      { action: "system_pressure" },
      workspace,
      undefined,
      execute,
      "linux",
    );

    expect(os).toContain("container runtime, not the Docker host");
    expect(memory).toContain("Linux runtime");
    expect(volume).toContain("/workspace");
    expect(pressure).toContain("Container pressure verdict:");
    expect(calls.every(({ executable }) => executable === "/bin/df")).toBe(true);
    await expect(
      runSystemInfo({ action: "battery" }, workspace, undefined, execute, "linux"),
    ).rejects.toThrow("unavailable in a Linux container runtime");
  });
});
