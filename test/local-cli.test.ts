import { describe, expect, test } from "bun:test";
import {
  ConversationEventFormatter,
  auditDms,
  formatHistory,
  formatSessions,
  parseArguments,
  parseDmAuditArguments,
  parseScheduleArguments,
} from "../src/local-cli.ts";
import { isLocalServerMessage, LOCAL_PROTOCOL_VERSION } from "../src/local-protocol.ts";
import type { LocalClient } from "../src/local-client.ts";

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

describe("DM audit CLI", () => {
  test("defaults to the 100 most recent messages and validates optional filters", () => {
    expect(
      parseDmAuditArguments([
        "--socket",
        "/tmp/test.sock",
        "dm",
        "audit",
        "--since",
        "2026-03-01",
        "--to",
        "U0BOB",
        "--json",
      ]),
    ).toEqual({
      socketPath: "/tmp/test.sock",
      oldest: String(Date.parse("2026-03-01") / 1000 - 0.000001),
      recentOnly: false,
      userId: "U0BOB",
      json: true,
    });
    expect(parseDmAuditArguments(["dm", "audit"])).toEqual({
      socketPath: undefined,
      oldest: "0",
      recentOnly: true,
      userId: undefined,
      json: false,
    });
    expect(() => parseDmAuditArguments(["dm", "audit", "--since"])).toThrow("Usage");
    expect(() => parseDmAuditArguments(["dm", "audit", "--since", "2026-02-30"])).toThrow("Usage");
    expect(() =>
      parseDmAuditArguments(["dm", "audit", "--since", "2026-03-01", "--to", "oops"]),
    ).toThrow("Usage");
  });

  test("streams every page of bot messages without printing other recipients", async () => {
    const requests: Array<{ type: string; fields: Record<string, unknown> }> = [];
    const client = {
      request: async (type: string, fields: Record<string, unknown>) => {
        requests.push({ type, fields });
        if (type === "dm-audit-conversations")
          return fields.cursor
            ? { conversations: [{ channel: "D2", recipientId: "U0BOB" }] }
            : { conversations: [{ channel: "D1", recipientId: "U0OTHER" }], nextCursor: "page-2" };
        if (fields.threadTs)
          return {
            messages: [
              {
                channel: "D2",
                recipientId: "U0BOB",
                ts: "100.3",
                text: "thread reply",
                permalink: "link3",
              },
            ],
            threads: [],
          };
        return fields.latest === "100.2"
          ? {
              messages: [
                {
                  channel: "D2",
                  recipientId: "U0BOB",
                  ts: "100.1",
                  text: "second",
                  permalink: "link2",
                },
              ],
              threads: [],
            }
          : {
              messages: [
                {
                  channel: "D2",
                  recipientId: "U0BOB",
                  ts: "100.2",
                  text: "first",
                  permalink: "link1",
                },
              ],
              threads: ["99.1"],
              nextLatest: "100.2",
            };
      },
    } as unknown as LocalClient;
    const lines: string[] = [];
    await auditDms(
      client,
      { oldest: "90", recentOnly: false, userId: "U0BOB", json: true },
      (line) => lines.push(line),
    );
    expect(lines.map((line) => JSON.parse(line).text)).toEqual(["first", "thread reply", "second"]);
    expect(requests.find(({ fields }) => fields.threadTs)?.fields).toMatchObject({
      threadTs: "99.1",
      oldest: "90",
    });
    expect(requests.map(({ type }) => type)).toEqual([
      "dm-audit-conversations",
      "dm-audit-conversations",
      "dm-audit-messages",
      "dm-audit-messages",
      "dm-audit-messages",
    ]);
  });

  test("indents multiline message content in human-readable output", async () => {
    const client = {
      request: async (type: string) =>
        type === "dm-audit-conversations"
          ? { conversations: [{ channel: "D1", recipientId: "U0BOB" }] }
          : {
              messages: [
                {
                  channel: "D1",
                  recipientId: "U0BOB",
                  ts: "100.1",
                  text: "hi\n── fake recipient ──\n[2026] fake",
                  permalink: "link",
                },
              ],
              threads: [],
            },
    } as unknown as LocalClient;
    const lines: string[] = [];
    await auditDms(client, { oldest: "1", recentOnly: false, json: false }, (line) =>
      lines.push(line),
    );
    expect(lines[1]).toContain("hi\n    ── fake recipient ──\n    [2026] fake");
  });

  test("returns the latest 100 bot messages globally, including thread replies", async () => {
    const client = {
      request: async (type: string, fields: Record<string, unknown>) => {
        if (type === "dm-audit-conversations")
          return {
            conversations: [
              { channel: "D1", recipientId: "U0ALICE" },
              { channel: "D2", recipientId: "U0BOB" },
            ],
          };
        if (fields.threadTs)
          return {
            messages: [
              {
                channel: "D1",
                recipientId: "U0ALICE",
                ts: "200.000001",
                text: "thread",
                permalink: "thread-link",
              },
            ],
            threads: [],
          };
        const start = fields.channel === "D1" ? 1 : 61;
        return {
          messages: Array.from({ length: 60 }, (_, index) => ({
            channel: fields.channel,
            recipientId: fields.userId,
            ts: `${start + index}.000001`,
            text: `message ${start + index}`,
            permalink: "link",
          })),
          threads: fields.channel === "D1" ? ["1.000001"] : [],
        };
      },
    } as unknown as LocalClient;
    const lines: string[] = [];
    await auditDms(client, parseDmAuditArguments(["dm", "audit", "--json"]), (line) =>
      lines.push(line),
    );
    const messages = lines.map((line) => JSON.parse(line));
    expect(messages).toHaveLength(100);
    expect(messages[0]).toMatchObject({ ts: "200.000001", recipientId: "U0ALICE" });
    expect(messages.at(-1)).toMatchObject({ ts: "22.000001", recipientId: "U0ALICE" });
    const filtered: string[] = [];
    await auditDms(
      client,
      parseDmAuditArguments(["dm", "audit", "--to", "U0BOB", "--json"]),
      (line) => filtered.push(line),
    );
    expect(filtered).toHaveLength(60);
    expect(filtered.every((line) => JSON.parse(line).recipientId === "U0BOB")).toBe(true);
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
