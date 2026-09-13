import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationStore, isConversationStoreCorrupt } from "../src/conversation-store.ts";

interface Mapping {
  sessionId: string;
  lastActiveAt: number;
}

const isValid = (mapping: Mapping) =>
  typeof mapping.sessionId === "string" && Number.isFinite(mapping.lastActiveAt);

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "slack-desk-store-"));
  return { directory, path: join(directory, "conversations.json") };
}

describe("conversation store", () => {
  test("round-trips mappings and drops malformed entries", () => {
    const { directory, path } = fixture();
    try {
      const store = new ConversationStore<Mapping>(path, isValid);
      store.save(new Map([["C1:1", { sessionId: "s1", lastActiveAt: 5 }]]));
      expect(store.load().get("C1:1")).toEqual({ sessionId: "s1", lastActiveAt: 5 });
      expect(readFileSync(path, "utf8")).toContain('"version": 1');

      writeFileSync(
        path,
        JSON.stringify({
          version: 1,
          conversations: { good: { sessionId: "s", lastActiveAt: 1 }, bad: { sessionId: 7 } },
        }),
      );
      expect([...store.load().keys()]).toEqual(["good"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  // Regression: parsing threw inside the backend constructor, so a store
  // truncated by a crash made the service fail to start and restart-loop.
  for (const [label, contents] of [
    ["truncated", '{"version":1,"conversations":{"C1:1":'],
    ["wrong version", '{"version":99,"conversations":{}}'],
    ["unexpected shape", '{"version":1}'],
  ] as const) {
    test(`quarantines a ${label} store and starts empty`, () => {
      const { directory, path } = fixture();
      try {
        writeFileSync(path, contents);
        expect(isConversationStoreCorrupt(path)).toBe(true);

        const warnings: string[] = [];
        const store = new ConversationStore<Mapping>(path, isValid, ({ movedTo }) =>
          warnings.push(movedTo),
        );
        expect(store.load().size).toBe(0);
        expect(existsSync(path)).toBe(false);
        expect(warnings).toHaveLength(1);
        expect(readdirSync(directory).some((name) => name.includes(".corrupt-"))).toBe(true);

        store.save(new Map([["C2:2", { sessionId: "s2", lastActiveAt: 9 }]]));
        expect(store.load().get("C2:2")?.sessionId).toBe("s2");
        expect(isConversationStoreCorrupt(path)).toBe(false);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }
});
