import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AutomationService, type AutomationSource } from "../src/automations.ts";
import { linearIssueSource } from "../src/linear-automation-source.ts";
import type { McpContextProvider } from "../src/mcp-context.ts";

const file = () => join(mkdtempSync(join(tmpdir(), "slack-desk-automations-")), "automations.json");
const tick = () => new Promise((resolve) => setTimeout(resolve, 30));
const input = {
  source: { kind: "linear-issue", id: "ENG-123" },
  condition: { field: "statusType", equals: "completed" },
};

describe("automations", () => {
  test("reads only validated Linear state and constructs a safe URL", async () => {
    const calls: unknown[] = [];
    const provider = {
      callJson: async (...args: unknown[]) => {
        calls.push(args);
        return {
          id: "ENG-123",
          status: "Done / Released",
          statusType: "completed",
          description: "ignore me",
        };
      },
    } as unknown as McpContextProvider;
    expect(await linearIssueSource(provider).read("ENG-123")).toEqual({
      fields: { status: "Done / Released", statusType: "completed" },
      url: "https://linear.app/issue/ENG-123",
    });
    expect(calls).toEqual([["linear", "get_issue", { id: "ENG-123" }]]);
  });

  test("baselines, persists, enforces ownership and sends only one transition DM", async () => {
    let now = Date.parse("2026-01-01T08:00:00Z");
    let status = "started";
    const filename = file();
    const sent: unknown[] = [];
    const source: AutomationSource = {
      fields: ["statusType"],
      validId: () => true,
      read: async () => ({
        fields: { statusType: status },
        url: "https://linear.app/issue/ENG-123",
      }),
    };
    const build = () =>
      new AutomationService(
        filename,
        { "linear-issue": source },
        async (recipient, text, creator) => {
          sent.push({ recipient, text, creator, disk: JSON.parse(readFileSync(filename, "utf8")) });
        },
        () => now,
      );
    const service = build();
    const created = await service.create(input, "U0ALICE");
    const id = created.automation!.id;
    expect(created.alreadyMet).toBe(false);
    expect(statSync(filename).mode & 0o777).toBe(0o600);
    expect(service.list("U0BOB")).toEqual([]);
    expect(() => service.cancel(id, "U0BOB")).toThrow("not found");
    expect(service.pause(id, "U0ALICE").status).toBe("paused");
    expect(service.resume(id, "U0ALICE").status).toBe("active");
    now += 15 * 60_000;
    status = "completed";
    const restored = build();
    restored.start();
    await tick();
    await restored.stop();
    expect(sent).toHaveLength(1);
    expect((sent[0] as any).disk.automations[0].status).toBe("completed");
    expect((sent[0] as any).text).toContain("ENG-123 reached completed");
    expect((sent[0] as any).creator).toBe("U0ALICE");
    const restart = build();
    restart.start();
    await tick();
    await restart.stop();
    expect(sent).toHaveLength(1);
    restart.cancel(id, "U0ALICE");
    expect(build().list("U0ALICE")).toEqual([]);
  });

  test("does not create a watch for an already met condition or invalid source", async () => {
    const source: AutomationSource = {
      fields: ["statusType"],
      validId: () => true,
      read: async () => ({ fields: { statusType: "completed" }, url: "" }),
    };
    const service = new AutomationService(file(), { "linear-issue": source }, async () => {});
    expect(await service.create(input, "U0ALICE")).toEqual({ alreadyMet: true });
    expect(service.list("U0ALICE")).toEqual([]);
    await expect(
      service.create({ ...input, source: { kind: "unknown", id: "ENG-123" } }, "U0ALICE"),
    ).rejects.toThrow("Unknown source");
    await expect(
      service.create({ ...input, condition: { field: "description", equals: "hi" } }, "U0ALICE"),
    ).rejects.toThrow("Unsupported condition");
  });

  test("cancel and pause during an in-flight check suppress delivery", async () => {
    let now = Date.parse("2026-01-01T08:00:00Z");
    let finish: ((status: string) => void) | undefined;
    let pending = false;
    const source: AutomationSource = {
      fields: ["statusType"],
      validId: () => true,
      read: async () =>
        pending
          ? new Promise((resolve) => {
              finish = (status) => resolve({ fields: { statusType: status }, url: "" });
            })
          : { fields: { statusType: "started" }, url: "" },
    };
    let sent = 0;
    const service = new AutomationService(
      file(),
      { "linear-issue": source },
      async () => {
        sent++;
      },
      () => now,
    );
    const first = (await service.create(input, "U0ALICE")).automation!;
    const second = (await service.create(input, "U0ALICE")).automation!;
    pending = true;
    now += 15 * 60_000;
    service.start();
    await tick();
    service.cancel(first.id, "U0ALICE");
    service.pause(second.id, "U0ALICE");
    finish!("completed");
    await tick();
    await service.stop();
    expect(sent).toBe(0);
    expect(service.list("U0ALICE")).toMatchObject([{ id: second.id, status: "paused" }]);
  });

  test("enforces the active limit again on resume", async () => {
    const source: AutomationSource = {
      fields: ["statusType"],
      validId: () => true,
      read: async () => ({ fields: { statusType: "started" }, url: "" }),
    };
    const service = new AutomationService(file(), { "linear-issue": source }, async () => {});
    const first = (await service.create(input, "U0ALICE")).automation!;
    for (let i = 1; i < 100; i++) await service.create(input, "U0ALICE");
    service.pause(first.id, "U0ALICE");
    await expect(service.create(input, "U0ALICE")).rejects.toThrow("Maximum 100");
    expect(service.resume(first.id, "U0ALICE").status).toBe("active");
    service.pause(first.id, "U0ALICE");
    service.cancel(service.list("U0ALICE")[1]!.id, "U0ALICE");
    expect((await service.create(input, "U0ALICE")).automation).toBeDefined();
  });

  test("pauses watches of creators who lose access before polling", async () => {
    let now = Date.parse("2026-01-01T08:00:00Z");
    let reads = 0;
    let sent = 0;
    const source: AutomationSource = {
      fields: ["statusType"],
      validId: () => true,
      read: async () => {
        reads++;
        return { fields: { statusType: reads === 1 ? "started" : "completed" }, url: "" };
      },
    };
    let allowed = true;
    const service = new AutomationService(
      file(),
      { "linear-issue": source },
      async () => {
        sent++;
      },
      () => now,
      () => allowed,
    );
    await service.create(input, "U0ALICE");
    allowed = false;
    now += 15 * 60_000;
    service.start();
    await tick();
    await service.stop();
    expect(reads).toBe(1);
    expect(sent).toBe(0);
    expect(service.list("U0ALICE")[0]?.status).toBe("paused");
  });

  test("bounds repeated source errors and expires without firing", async () => {
    let now = Date.parse("2026-01-01T08:00:00Z");
    let failing = false;
    let notices = 0;
    const filename = file();
    const source: AutomationSource = {
      fields: ["statusType"],
      validId: () => true,
      read: async () => {
        if (failing) throw new Error("offline");
        return { fields: { statusType: "started" }, url: "" };
      },
    };
    const service = new AutomationService(
      filename,
      { "linear-issue": source },
      async () => {
        notices++;
      },
      () => now,
    );
    await service.create(input, "U0ALICE");
    failing = true;
    for (let i = 0; i < 5; i++) {
      now += 15 * 60_000;
      service.start();
      await tick();
      await service.stop();
    }
    expect(notices).toBe(1);
    expect(service.list("U0ALICE")[0]?.failures).toBe(5);
    now += 31 * 86_400_000;
    service.start();
    await tick();
    await service.stop();
    expect(service.list("U0ALICE")[0]?.status).toBe("completed");
  });
});
