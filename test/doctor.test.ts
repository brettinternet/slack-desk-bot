import { describe, expect, mock, test } from "bun:test";
import { runDoctor } from "../src/doctor.ts";

const valid = {
  SLACK_BOT_TOKEN: "xoxb-test-secret",
  SLACK_APP_TOKEN: "xapp-test-secret",
  SLACK_AGENT_CWD: process.cwd(),
  SLACK_AGENT_SESSION_DIR: process.cwd(),
  SLACK_ALLOWED_USER_IDS: "U0123",
};

function dependencies() {
  return {
    slackAuth: mock(async () => ({ user_id: "U_BOT" })),
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
        ["pass", "Pi readiness"],
      ]),
    );
    expect(checks.slackAuth).toHaveBeenCalledWith("xoxb-test-secret");
    expect(checks.portAvailable).toHaveBeenCalledWith(3210);
    expect(checks.socketAvailable).toHaveBeenCalledTimes(1);
    expect(checks.piReady).toHaveBeenCalledWith(process.cwd());
  });

  test("runs only Codex readiness for the Codex backend", async () => {
    const checks = dependencies();
    const result = await runDoctor(
      {
        ...valid,
        SLACK_AGENT_BACKEND: "codex",
        SLACK_CODEX_HOME: process.cwd(),
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
        SLACK_CLAUDE_HOME: process.cwd(),
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
