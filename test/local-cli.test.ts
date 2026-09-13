import { describe, expect, test } from "bun:test";
import { parseArguments } from "../src/local-cli.ts";
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
