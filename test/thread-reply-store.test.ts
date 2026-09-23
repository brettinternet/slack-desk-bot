import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThreadReplyStore } from "../src/thread-reply-store.ts";

describe("ThreadReplyStore", () => {
  test("persists addressed turns across restarts and expires them after a day", () => {
    const directory = mkdtempSync(join(tmpdir(), "slack-thread-replies-"));
    try {
      const path = join(directory, "pending.json");
      let now = 100_000;
      const store = new ThreadReplyStore(path, () => now);
      store.setOwner("C1:1", "U_BRETT");
      store.set("C1:1", "U_BRETT");
      expect(store.isOwner("C1:1", "U_CFB")).toBe(false);
      expect(store.expects("C1:1", "U_CFB")).toBe(false);
      const restarted = new ThreadReplyStore(path, () => now);
      expect(restarted.isOwner("C1:1", "U_BRETT")).toBe(true);
      expect(restarted.expects("C1:1", "U_BRETT")).toBe(true);
      now += 24 * 60 * 60 * 1_000;
      expect(new ThreadReplyStore(path, () => now).isOwner("C1:1", "U_BRETT")).toBe(false);
      expect(new ThreadReplyStore(path, () => now).expects("C1:1", "U_BRETT")).toBe(false);
      store.clear("C1:1");
      expect(new ThreadReplyStore(path, () => now).expects("C1:1", "U_BRETT")).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("keeps routing in memory when the state file cannot be written", () => {
    const directory = mkdtempSync(join(tmpdir(), "slack-thread-replies-"));
    try {
      const store = new ThreadReplyStore(join(directory, "missing", "pending.json"));
      store.set("C1:1", "U_BRETT");
      expect(store.expects("C1:1", "U_BRETT")).toBe(true);
      store.clear("C1:1");
      expect(store.expects("C1:1", "U_BRETT")).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("ignores corrupt persisted state instead of treating it as an open question", () => {
    const directory = mkdtempSync(join(tmpdir(), "slack-thread-replies-"));
    try {
      const path = join(directory, "pending.json");
      writeFileSync(path, "invalid json");
      const store = new ThreadReplyStore(path);
      expect(store.expects("C1:1", "U_BRETT")).toBe(false);
      store.set("C1:1", "U_BRETT");
      expect(new ThreadReplyStore(path).expects("C1:1", "U_BRETT")).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
