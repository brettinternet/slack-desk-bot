import { describe, expect, test } from "bun:test";
import {
  ConversationEventFormatter,
  formatHistory,
  formatSessions,
  parseArguments,
  parseScheduleArguments,
} from "../src/local-cli.ts";
import { isLocalServerMessage, LOCAL_PROTOCOL_VERSION } from "../src/local-protocol.ts";

describe("slack-desk argument parsing", () => {
  test("accepts both --socket forms and rejects unusable invocations", () => {
    expect(parseArguments(["sessions"])).toEqual({
      command: "sessions",
      sessionId: undefined,
      socketPath: undefined,
    });
    expect(parseArguments(["attach", "f82ab719"])).toMatchObject({
      command: "attach",
      sessionId: "f82ab719",
    });
    expect(parseArguments(["--socket", "/tmp/a.sock", "sessions"]).socketPath).toBe("/tmp/a.sock");
    expect(parseArguments(["--socket=/tmp/b.sock", "attach", "abc"])).toMatchObject({
      sessionId: "abc",
      socketPath: "/tmp/b.sock",
    });

    expect(() => parseArguments([])).toThrow("Usage");
    expect(() => parseArguments(["bogus"])).toThrow("Usage");
    expect(() => parseArguments(["attach"])).toThrow("Usage");
    expect(parseArguments(["attach", "abc", "--history", "50"]).historyLimit).toBe(50);
    expect(parseArguments(["attach", "abc", "--no-history"]).historyLimit).toBe(0);
    expect(() => parseArguments(["sessions", "--history", "20"])).toThrow("Usage");
    expect(() => parseArguments(["attach", "abc", "--history", "101"])).toThrow("0-100");
    expect(() => parseArguments(["--socket"])).toThrow("--socket requires a path");
    expect(parseArguments(["--socket", "/tmp/a.sock", "dm", "U0BOB", "Deploy", "--now"])).toEqual({
      command: "dm",
      userId: "U0BOB",
      text: "Deploy --now",
      socketPath: "/tmp/a.sock",
    });
    expect(() => parseArguments(["dm", "U0BOB"])).toThrow("Usage");
    expect(() => parseArguments(["dm"])).toThrow("Usage");
  });
});

describe("schedule CLI parsing", () => {
  test("accepts one-off, daily, weekly, update and cancellation", () => {
    expect(
      parseScheduleArguments([
        "schedule",
        "add",
        "U0BOB",
        "--at",
        "2026-12-01T09:00:00Z",
        "hello",
        "--flag",
      ]),
    ).toMatchObject({
      type: "schedule-create",
      input: { userId: "U0BOB", text: "hello --flag", at: "2026-12-01T09:00:00Z" },
    });
    expect(
      parseScheduleArguments([
        "--socket",
        "/tmp/bot.sock",
        "schedule",
        "update",
        "abc",
        "U0BOB",
        "--weekly",
        "1,3",
        "--time",
        "09:00",
        "--tz",
        "America/New_York",
        "standup",
      ]),
    ).toMatchObject({
      socketPath: "/tmp/bot.sock",
      type: "schedule-update",
      id: "abc",
      input: { recurrence: { time: "09:00", timezone: "America/New_York", weekdays: [1, 3] } },
    });
    expect(parseScheduleArguments(["schedule", "list"]).type).toBe("schedule-list");
    expect(parseScheduleArguments(["schedule", "cancel", "abc"]).type).toBe("schedule-cancel");
    expect(() =>
      parseScheduleArguments(["schedule", "add", "U0BOB", "--daily", "09:00", "text"]),
    ).toThrow("Usage");
  });
});

describe("slack-desk output formatting", () => {
  test("prints full conversation IDs and attributed lifecycle prompts", () => {
    const conversationId = "C0123456789:1726000000.000100-extra-long-conversation-id";
    expect(
      formatSessions(
        [
          {
            sessionId: "f82ab719-full-session-id",
            conversationId,
            state: "idle",
            lastActiveAt: 1_700_000_000_000,
          },
        ],
        1_700_000_120_000,
      )[1],
    ).toContain(conversationId);

    const formatter = new ConversationEventFormatter();
    const queued = {
      type: "queued" as const,
      conversationId: "C1:1",
      requesterKind: "slack" as const,
      promptExcerpt: "Inspect the failing build",
    };
    expect(formatter.format(queued)).toEqual(["user> Inspect the failing build"]);
    expect(formatter.format({ ...queued, type: "started" })).toEqual(["agent> Working…"]);
    expect(
      formatter.format({
        type: "response",
        conversationId: "C1:1",
        response: "safe\u001b[31m red",
      }),
    ).toEqual(["agent> safe red"]);

    expect(
      formatHistory({
        sessionId: "f82ab719-full-session-id",
        conversationId,
        state: "idle",
        lastActiveAt: 1_700_000_000_000,
        details: {
          label: "#engineering / deploys",
          permalink: "https://example.slack.com/thread",
          participants: [{ id: "U1", name: "Jane Doe", handle: "jane" }],
          history: [
            {
              timestamp: 1_700_000_000_000,
              authorName: "Jane Doe",
              kind: "user",
              text: "Ship it",
              attachments: ["plan.txt"],
            },
          ],
        },
      }),
    ).toEqual([
      "#engineering / deploys",
      "Participants: Jane Doe (@jane, U1)",
      "Slack: https://example.slack.com/thread",
      "── recent history ──",
      "[2023-11-14 22:13:20] Jane Doe> Ship it",
      "  attachment: plan.txt",
      "── live events ──",
    ]);

    expect(
      formatHistory({
        sessionId: "unsafe",
        conversationId: "C1:1",
        state: "idle",
        lastActiveAt: 0,
        details: {
          label: "thread\u001b[2J",
          participants: [{ id: "U1", name: "Jane\u001b[31m" }],
          history: [
            {
              timestamp: Number.NaN,
              authorName: "Jane\u001b[31m",
              kind: "user",
              text: "hello\u001b[2J",
            },
          ],
        },
      }),
    ).toContain("[unknown time] Jane> hello");

    const attachedAfterQueue = new ConversationEventFormatter();
    expect(
      attachedAfterQueue.format({
        ...queued,
        type: "started",
        requesterKind: "operator",
        promptExcerpt: "Retry the check",
      }),
    ).toEqual(["operator> Retry the check", "agent> Working…"]);
  });
});

describe("local protocol frame validation", () => {
  test("accepts well-formed server messages and rejects everything else", () => {
    expect(
      isLocalServerMessage({
        v: LOCAL_PROTOCOL_VERSION,
        type: "response",
        requestId: "r1",
        ok: true,
      }),
    ).toBe(true);
    expect(
      isLocalServerMessage({
        v: LOCAL_PROTOCOL_VERSION,
        type: "event",
        event: { type: "response", conversationId: "C1:1" },
      }),
    ).toBe(true);

    for (const invalid of [
      null,
      42,
      "response",
      {},
      { v: 99, type: "response", requestId: "r", ok: true },
      { v: LOCAL_PROTOCOL_VERSION, type: "response", ok: true },
      { v: LOCAL_PROTOCOL_VERSION, type: "event" },
      { v: LOCAL_PROTOCOL_VERSION, type: "unknown" },
    ]) {
      expect(isLocalServerMessage(invalid)).toBe(false);
    }
  });
});
