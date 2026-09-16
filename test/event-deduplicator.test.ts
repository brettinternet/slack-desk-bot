import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    const events = new EventDeduplicator({ ttlMs: 1_000 });

    expect(events.accept(["event:one"], 1_000)).toBe(true);
    expect(events.accept(["event:one"], 1_999)).toBe(false);
    expect(events.accept(["event:one"], 2_000)).toBe(true);
  });

  test("restores unexpired IDs from persistent state", () => {
    const directory = mkdtempSync(join(tmpdir(), "slack-desk-deduplicator-"));
    const statePath = join(directory, "state.json");
    const now = Date.now();
    try {
      const first = new EventDeduplicator({ statePath });
      expect(first.accept(["event:one"], now)).toBe(true);

      const restarted = new EventDeduplicator({ statePath });
      expect(restarted.accept(["event:one"], now + 1)).toBe(false);
      expect(JSON.parse(readFileSync(statePath, "utf8"))).toEqual({
        version: 1,
        expirations: [{ id: "event:one", expiresAt: now + 10 * 60_000 }],
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("does not restore expired IDs from persistent state", () => {
    const directory = mkdtempSync(join(tmpdir(), "slack-desk-deduplicator-"));
    const statePath = join(directory, "state.json");
    const now = Date.now();
    try {
      const first = new EventDeduplicator({ ttlMs: 1, statePath });
      expect(first.accept(["event:one"], now)).toBe(true);

      const restarted = new EventDeduplicator({ ttlMs: 1, statePath });
      expect(restarted.accept(["event:one"], now + 1)).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
