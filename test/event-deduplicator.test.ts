import { describe, expect, test } from "bun:test";
import { EventDeduplicator } from "../src/event-deduplicator.ts";

describe("EventDeduplicator", () => {
  test("accepts new IDs and rejects a duplicate ID", () => {
    const events = new EventDeduplicator();

    expect(events.accept(["event:one", "message:one"])).toBe(true);
    expect(events.accept(["event:one", "message:two"])).toBe(false);
    expect(events.accept(["event:two", "message:one"])).toBe(false);
  });

  test("reserves IDs before another request can accept them", async () => {
    const events = new EventDeduplicator();

    expect(
      await Promise.all([
        Promise.resolve().then(() => events.accept(["event:one"])),
        Promise.resolve().then(() => events.accept(["event:one"])),
      ]),
    ).toEqual([true, false]);
  });

  test("accepts IDs again after they expire", () => {
    const events = new EventDeduplicator(1_000);

    expect(events.accept(["event:one"], 1_000)).toBe(true);
    expect(events.accept(["event:one"], 1_999)).toBe(false);
    expect(events.accept(["event:one"], 2_000)).toBe(true);
  });
});
