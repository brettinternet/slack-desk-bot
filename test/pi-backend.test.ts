import { describe, expect, test } from "bun:test";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { createResponseCollector, toolsForMode } from "../src/pi-backend.ts";

function event(value: object): AgentSessionEvent {
  return value as AgentSessionEvent;
}

describe("Pi tool access", () => {
  test("defaults can exclude write tools unless explicitly enabled", () => {
    expect(toolsForMode("read-only")).toEqual(["read", "grep", "find", "ls"]);
    expect(toolsForMode("read-write")).toEqual(["read", "grep", "find", "ls", "edit", "write"]);
  });
});

describe("Pi response collection", () => {
  test("keeps completed assistant messages and separates turns", () => {
    const collector = createResponseCollector();
    collector.handle(event({ type: "message_start", message: { role: "assistant" } }));
    collector.handle(
      event({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "Inspecting" },
      }),
    );
    collector.handle(
      event({
        type: "message_end",
        message: { role: "assistant", stopReason: "toolUse" },
      }),
    );
    collector.handle(event({ type: "message_start", message: { role: "assistant" } }));
    collector.handle(
      event({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "Done" },
      }),
    );
    collector.handle(
      event({
        type: "message_end",
        message: { role: "assistant", stopReason: "stop" },
      }),
    );

    expect(collector.text()).toBe("Inspecting\n\nDone");
  });

  test("discards partial text from failed attempts", () => {
    const collector = createResponseCollector();
    collector.handle(event({ type: "message_start", message: { role: "assistant" } }));
    collector.handle(
      event({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "partial" },
      }),
    );
    collector.handle(
      event({
        type: "message_end",
        message: { role: "assistant", stopReason: "error" },
      }),
    );
    collector.handle(event({ type: "message_start", message: { role: "assistant" } }));
    collector.handle(
      event({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "complete" },
      }),
    );
    collector.handle(
      event({
        type: "message_end",
        message: { role: "assistant", stopReason: "stop" },
      }),
    );

    expect(collector.text()).toBe("complete");
  });
});
