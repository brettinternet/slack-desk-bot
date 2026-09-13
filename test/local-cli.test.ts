import { describe, expect, test } from "bun:test";
import { ConversationEventFormatter, formatSessions, parseArguments } from "../src/local-cli.ts";
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
    expect(() => parseArguments(["--socket"])).toThrow("--socket requires a path");
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
