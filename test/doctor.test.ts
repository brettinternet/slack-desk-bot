import { describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../src/config.ts";
import { checkClaudeReadiness, checkCodexReadiness, runDoctor } from "../src/doctor.ts";

const workspace = join(process.cwd(), "test");
const valid = {
  SLACK_BOT_TOKEN: "xoxb-test-secret",
  SLACK_APP_TOKEN: "xapp-test-secret",
  SLACK_AGENT_CWD: workspace,
  SLACK_AGENT_SESSION_DIR: join(tmpdir(), "slack-desk-doctor-sessions"),
  SLACK_ALLOWED_USER_IDS: "U0123",
};

function dependencies() {
  return {
    slackAuth: mock(async () => ({ user_id: "U_BOT" })),
    slackCatchUpAccess: mock(async () => {}),
    portAvailable: mock(async () => true),
    socketAvailable: mock(async () => true),
    piReady: mock(async () => "Pi model test/model is available"),
    codexReady: mock(async () => "Codex CLI is ready"),
    claudeReady: mock(async () => "Claude Code is ready"),
  };
}

describe("runDoctor", () => {
  test("checks configuration, paths, port, Slack, and Pi readiness", async () => {
    const checks = dependencies();
    const result = await runDoctor(valid, checks);

    expect(result.ok).toBe(true);
    expect(result.diagnostics.map(({ status, check }) => [status, check])).toEqual(
      expect.arrayContaining([
        ["pass", "Configuration"],
        ["pass", "SLACK_AGENT_CWD access"],
        ["pass", "Session storage"],
        ["pass", "Health port"],
        ["pass", "Local control socket"],
        ["pass", "Slack authentication"],
        ["pass", "Slack catch-up access"],
        ["pass", "Pi resources"],
        ["pass", "Pi readiness"],
      ]),
    );
    expect(checks.slackAuth).toHaveBeenCalledWith("xoxb-test-secret");
    expect(checks.slackCatchUpAccess).toHaveBeenCalledWith("xoxb-test-secret");
    expect(checks.portAvailable).toHaveBeenCalledWith(3210);
    expect(checks.socketAvailable).toHaveBeenCalledTimes(1);
    expect(checks.piReady).toHaveBeenCalledWith(workspace);
    expect(result.diagnostics).toContainEqual({
      status: "pass",
      check: "Pi resources",
      message: `Agent directory: ${getAgentDir()}. User extensions, skills, and prompt templates are disabled; only mode-approved tools are allowed; brokered commands are off`,
    });
  });

  test("fails when the installed Slack app lacks catch-up permissions", async () => {
    const checks = dependencies();
    checks.slackCatchUpAccess.mockImplementationOnce(async () => {
      throw new Error("missing_scope");
    });

    const result = await runDoctor(valid, checks);

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual({
      status: "fail",
      check: "Slack catch-up access",
      message:
        "Slack conversation discovery failed; update the app from slack-app-manifest.yaml, reinstall it, and refresh SLACK_BOT_TOKEN",
    });
  });

  test("fails when the workspace exposes a credential or service-state path", async () => {
    const root = mkdtempSync(join(tmpdir(), "slack-desk-doctor-overlap-"));
    const workspace = join(root, "workspace");
    const agentDirectory = join(root, "pi", "agent");
    mkdirSync(workspace);
    mkdirSync(agentDirectory, { recursive: true });
    const cases: Array<[string, NodeJS.ProcessEnv]> = [
      ["the user home directory", { SLACK_AGENT_CWD: homedir() }],
      ["the Pi agent directory", { SLACK_AGENT_CWD: dirname(agentDirectory) }],
      [
        "SLACK_AGENT_SESSION_DIR",
        { SLACK_AGENT_CWD: workspace, SLACK_AGENT_SESSION_DIR: join(workspace, "sessions") },
      ],
      [
        "SLACK_CODEX_HOME",
        { SLACK_AGENT_CWD: workspace, SLACK_CODEX_HOME: join(workspace, "codex") },
      ],
      [
        "SLACK_CLAUDE_HOME",
        { SLACK_AGENT_CWD: workspace, SLACK_CLAUDE_HOME: join(workspace, "claude") },
      ],
      [
        "the local control socket directory",
        {
          SLACK_AGENT_CWD: workspace,
          SLACK_AGENT_SOCKET_PATH: join(workspace, "run", "control.sock"),
        },
      ],
      ["the service environment file", { SLACK_AGENT_CWD: join(homedir(), ".config") }],
    ];

    try {
      for (const [label, environment] of cases) {
        const result = await runDoctor(
          { ...valid, ...environment },
          { ...dependencies(), agentDirectory },
        );
        expect(result.ok, label).toBe(false);
        expect(result.diagnostics, label).toContainEqual({
          status: "fail",
          check: "Workspace credential isolation",
          message: expect.stringContaining(label),
        });
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails when a credential directory itself is the workspace", async () => {
    const root = mkdtempSync(join(tmpdir(), "slack-desk-doctor-credential-root-"));
    const fakeHome = join(root, "home");
    const credentialDirectories = [
      ["the Codex credential directory", join(fakeHome, ".codex")],
      ["the Claude credential directory", join(fakeHome, ".claude")],
      ["the default Pi agent directory", join(fakeHome, ".pi", "agent")],
      ["the macOS keychain directory", join(fakeHome, "Library", "Keychains")],
    ] as const;
    for (const [, path] of credentialDirectories) mkdirSync(path, { recursive: true });

    try {
      for (const [label, workspace] of credentialDirectories) {
        const result = await runDoctor(
          { ...valid, SLACK_AGENT_CWD: workspace },
          { ...dependencies(), homeDirectory: fakeHome, agentDirectory: join(root, "agent") },
        );
        expect(result.ok, label).toBe(false);
        expect(result.diagnostics, label).toContainEqual({
          status: "fail",
          check: "Workspace credential isolation",
          message: expect.stringContaining(label),
        });
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("passes only minimal runtime environments to CLI readiness children", async () => {
    const calls: Array<{ env?: NodeJS.ProcessEnv }> = [];
    const executeFile = mock(
      async (_file: string, _args: readonly string[], options?: { env?: NodeJS.ProcessEnv }) => {
        calls.push(options ?? {});
        return { stdout: "", stderr: "" };
      },
    );

    for (const backend of ["codex", "claude"] as const) {
      calls.length = 0;
      const home = join(tmpdir(), `slack-desk-doctor-env-${backend}`);
      const config = loadConfig({
        ...valid,
        SLACK_AGENT_BACKEND: backend,
        SLACK_CODEX_HOME: home,
        SLACK_CLAUDE_HOME: home,
        SLACK_CODEX_EXECUTABLE: "/usr/bin/true",
        SLACK_CLAUDE_EXECUTABLE: "/usr/bin/true",
      });
      if (backend === "codex") {
        await checkCodexReadiness(config, {
          executeFile: executeFile as never,
          platform: "darwin",
        });
      } else {
        await checkClaudeReadiness(config, {
          executeFile: executeFile as never,
          platform: "darwin",
        });
      }
      expect(calls).toHaveLength(3);
      for (const call of calls) {
        expect(call.env).toBeDefined();
        expect(Object.keys(call.env ?? {}).some((name) => name.startsWith("SLACK_"))).toBe(false);
      }
    }
  });

  test("reports prompt-prefix fallback when a CLI lacks system prompt support", async () => {
    const executeFile = mock(async () => ({ stdout: "", stderr: "" }));
    for (const backend of ["codex", "claude"] as const) {
      const home = join(tmpdir(), `slack-desk-doctor-instructions-${backend}`);
      const config = loadConfig({
        ...valid,
        SLACK_AGENT_BACKEND: backend,
        SLACK_AGENT_INSTRUCTIONS: "Be concise.",
        SLACK_CODEX_HOME: home,
        SLACK_CLAUDE_HOME: home,
        SLACK_CODEX_EXECUTABLE: "/usr/bin/true",
        SLACK_CLAUDE_EXECUTABLE: "/usr/bin/true",
      });
      const message =
        backend === "codex"
          ? await checkCodexReadiness(config, {
              executeFile: executeFile as never,
              platform: "darwin",
            })
          : await checkClaudeReadiness(config, {
              executeFile: executeFile as never,
              platform: "darwin",
            });
      expect(message).toContain("instructions will be prefixed to prompts");
    }
  });

  test("runs only Codex readiness for the Codex backend", async () => {
    const checks = dependencies();
    const result = await runDoctor(
      {
        ...valid,
        SLACK_AGENT_BACKEND: "codex",
        SLACK_CODEX_HOME: join(tmpdir(), "slack-desk-doctor-codex"),
        SLACK_CODEX_EXECUTABLE: "/usr/bin/true",
      },
      checks,
    );

    expect(result.ok).toBe(true);
    expect(result.diagnostics).toContainEqual({
      status: "pass",
      check: "Codex readiness",
      message: "Codex CLI is ready",
    });
    expect(checks.codexReady).toHaveBeenCalledTimes(1);
    expect(checks.piReady).not.toHaveBeenCalled();
  });

  test("runs only Claude readiness for the Claude backend", async () => {
    const checks = dependencies();
    const result = await runDoctor(
      {
        ...valid,
        SLACK_AGENT_BACKEND: "claude",
        SLACK_CLAUDE_HOME: join(tmpdir(), "slack-desk-doctor-claude"),
        SLACK_CLAUDE_EXECUTABLE: "/usr/bin/true",
      },
      checks,
    );

    expect(result.ok).toBe(true);
    expect(result.diagnostics).toContainEqual({
      status: "pass",
      check: "Claude readiness",
      message: "Claude Code is ready",
    });
    expect(checks.claudeReady).toHaveBeenCalledTimes(1);
    expect(checks.codexReady).not.toHaveBeenCalled();
    expect(checks.piReady).not.toHaveBeenCalled();
  });

  test("names the backend's own storage setting when session storage fails", async () => {
    // A regular file blocks directory creation, so every backend's storage
    // check fails and must name its own setting.
    const blocked = join(mkdtempSync(join(tmpdir(), "slack-desk-doctor-blocked-")), "file");
    writeFileSync(blocked, "");
    const unwritable = join(blocked, "sessions");
    for (const [environment, setting] of [
      [{ SLACK_AGENT_SESSION_DIR: unwritable }, "SLACK_AGENT_SESSION_DIR"],
      [
        {
          SLACK_AGENT_BACKEND: "codex",
          SLACK_CODEX_HOME: unwritable,
          SLACK_CODEX_EXECUTABLE: "/usr/bin/true",
        },
        "SLACK_CODEX_HOME",
      ],
      [
        {
          SLACK_AGENT_BACKEND: "claude",
          SLACK_CLAUDE_HOME: unwritable,
          SLACK_CLAUDE_EXECUTABLE: "/usr/bin/true",
        },
        "SLACK_CLAUDE_HOME",
      ],
    ] as Array<[Record<string, string>, string]>) {
      const result = await runDoctor({ ...valid, ...environment }, dependencies());
      const storage = result.diagnostics.find(({ check }) => check === "Session storage");
      expect(storage?.message).toContain(setting);
    }
  });

  test("fails when a CLI backend conversation store is unreadable", async () => {
    const home = mkdtempSync(join(tmpdir(), "slack-desk-doctor-store-"));
    try {
      writeFileSync(join(home, "conversations.json"), '{"version":1,"conversations":{"C1"');
      const result = await runDoctor(
        {
          ...valid,
          SLACK_AGENT_BACKEND: "codex",
          SLACK_CODEX_HOME: home,
          SLACK_CODEX_EXECUTABLE: "/usr/bin/true",
        },
        dependencies(),
      );
      expect(result.ok).toBe(false);
      expect(
        result.diagnostics.some(
          ({ check, message }) =>
            check === "Session storage" && message.includes("conversation store"),
        ),
      ).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("uses the same trimmed Slack token as production", async () => {
    const checks = dependencies();
    const result = await runDoctor({ ...valid, SLACK_BOT_TOKEN: "  xoxb-test-secret  " }, checks);

    expect(result.ok).toBe(true);
    expect(checks.slackAuth).toHaveBeenCalledWith("xoxb-test-secret");
  });

  test("reports every missing required setting without running external checks", async () => {
    const checks = dependencies();
    const result = await runDoctor({}, checks);

    expect(result.ok).toBe(false);
    expect(result.diagnostics.filter(({ status }) => status === "fail")).toHaveLength(4);
    expect(checks.slackAuth).not.toHaveBeenCalled();
    expect(checks.portAvailable).not.toHaveBeenCalled();
    expect(checks.socketAvailable).not.toHaveBeenCalled();
    expect(checks.piReady).not.toHaveBeenCalled();
  });

  test("reports invalid token prefixes and configuration paths without exposing tokens", async () => {
    const checks = dependencies();
    const result = await runDoctor(
      {
        ...valid,
        SLACK_BOT_TOKEN: "bot-super-secret",
        SLACK_APP_TOKEN: "app-super-secret",
        SLACK_AGENT_CWD: ".",
      },
      checks,
    );

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "fail", check: "SLACK_BOT_TOKEN format" }),
        expect.objectContaining({ status: "fail", check: "SLACK_APP_TOKEN format" }),
        expect.objectContaining({ status: "fail", check: "Configuration" }),
      ]),
    );
    expect(JSON.stringify(result)).not.toContain("super-secret");
    expect(checks.slackAuth).not.toHaveBeenCalled();
  });

  test("turns Slack authentication failures into actionable sanitized diagnostics", async () => {
    const checks = dependencies();
    checks.slackAuth.mockImplementation(async () => {
      throw new Error("Slack rejected xoxb-test-secret");
    });
    const result = await runDoctor(valid, checks);
    const slack = result.diagnostics.find(({ check }) => check === "Slack authentication");

    expect(result.ok).toBe(false);
    expect(slack).toEqual({
      status: "fail",
      check: "Slack authentication",
      message: "Slack auth.test failed; verify SLACK_BOT_TOKEN and reinstall the app if needed",
    });
    expect(JSON.stringify(result)).not.toContain("xoxb-test-secret");
  });

  test("reports occupied health ports and unavailable Pi authentication", async () => {
    const checks = dependencies();
    checks.portAvailable.mockImplementation(async () => false);
    checks.piReady.mockImplementation(async () => {
      throw new Error("No authenticated Pi model is available; run `pi` and /login");
    });
    const result = await runDoctor(valid, checks);

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "fail", check: "Health port" }),
        expect.objectContaining({
          status: "fail",
          check: "Pi readiness",
          message: expect.stringContaining("/login"),
        }),
      ]),
    );
  });
});
