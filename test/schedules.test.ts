import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nextOccurrence, ScheduleService } from "../src/schedules.ts";

const path = () => join(mkdtempSync(join(tmpdir(), "slack-desk-schedules-")), "schedules.json");
const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

describe("scheduled DMs", () => {
  test("persists creator ownership and lets operator manage all schedules", () => {
    const filename = path();
    const service = new ScheduleService(filename, async () => {});
    const at = new Date(Date.now() + 86_400_000).toISOString();
    const created = service.create({ userId: "U0BOB", text: "hello", at }, "U0ALICE");
    expect(statSync(filename).mode & 0o777).toBe(0o600);
    const restored = new ScheduleService(filename, async () => {});
    expect(restored.list("U0BOB")).toEqual([]);
    expect(() => restored.cancel(created.id, "U0BOB")).toThrow("not found");
    expect(restored.list("local-operator", true)).toHaveLength(1);
    const updated = restored.update(
      created.id,
      { userId: "U0BOB", text: "new", at },
      "local-operator",
      true,
    );
    expect(updated.creatorId).toBe("U0ALICE");
    expect(updated.authorId).toBe("local-operator");
    restored.cancel(created.id, "U0ALICE");
    expect(new ScheduleService(filename, async () => {}).list("local-operator", true)).toEqual([]);
  });

  test("attributes administrator edits to the editor without changing ownership", async () => {
    const filename = path();
    let now = Date.parse("2026-01-01T08:00:00Z");
    const senders: Array<string | undefined> = [];
    const service = new ScheduleService(
      filename,
      async (_message, authorId) => {
        senders.push(authorId);
      },
      () => now,
    );
    const created = service.create(
      { userId: "U0BOB", text: "original", at: "2026-01-01T09:00:00Z" },
      "U0ALICE",
    );
    const edited = service.update(
      created.id,
      { userId: "", text: "operator edit", at: "2026-01-01T09:00:00Z" },
      "local-operator",
      true,
    );
    expect(edited).toMatchObject({
      creatorId: "U0ALICE",
      authorId: "local-operator",
      userId: "U0BOB",
    });
    now = Date.parse("2026-01-01T09:01:00Z");
    service.start();
    await tick();
    await service.stop();
    expect(senders).toEqual([undefined]);
  });

  test("uses local wall clock through DST and weekly weekdays", () => {
    expect(
      nextOccurrence(
        { time: "09:00", timezone: "America/New_York", weekdays: [1] },
        Date.parse("2026-03-06T15:00:00Z"),
      ),
    ).toBe("2026-03-09T13:00:00.000Z");
    expect(
      nextOccurrence(
        { time: "02:30", timezone: "America/New_York" },
        Date.parse("2026-03-08T05:00:00Z"),
      ),
    ).toBe("2026-03-09T06:30:00.000Z");
    expect(
      nextOccurrence(
        { time: "01:30", timezone: "America/New_York" },
        Date.parse("2026-11-01T05:30:00Z"),
      ),
    ).toBe("2026-11-01T06:30:00.000Z");
    expect(
      nextOccurrence(
        { time: "01:30", timezone: "America/New_York" },
        Date.parse("2026-11-01T05:30:00Z"),
        Date.parse("2026-11-01T05:30:00Z"),
      ),
    ).toBe("2026-11-02T06:30:00.000Z");
  });

  test("claims due slots before send, handles failures and restart without replay", async () => {
    const filename = path();
    let now = Date.parse("2026-01-01T08:00:00Z");
    const sent: unknown[] = [];
    const service = new ScheduleService(
      filename,
      async (message, creator) => {
        sent.push({ message, creator, disk: JSON.parse(readFileSync(filename, "utf8")) });
        if (message.text === "fail") throw new Error("offline");
      },
      () => now,
    );
    service.create({ userId: "U0BOB", text: "hello", at: "2026-01-01T09:00:00Z" }, "U0ALICE");
    service.create({ userId: "U0BOB", text: "fail", at: "2026-01-01T09:00:00Z" }, "local-operator");
    service.create(
      { userId: "U0BOB", text: "daily", recurrence: { time: "09:00", timezone: "UTC" } },
      "U0ALICE",
    );
    now = Date.parse("2026-01-01T09:01:00Z");
    service.start();
    await tick();
    await service.stop();
    expect(sent).toHaveLength(3);
    expect((sent[0] as any).disk.schedules.find((item: any) => item.text === "hello").status).toBe(
      "completed",
    );
    expect(
      service
        .list("local-operator", true)
        .map((item) => item.status)
        .sort(),
    ).toEqual(["active", "completed", "failed"]);
    const restarted = new ScheduleService(
      filename,
      async () => {
        throw new Error("duplicate");
      },
      () => now,
    );
    restarted.start();
    await tick();
    await restarted.stop();
    expect(restarted.list("U0ALICE").find((item) => item.text === "daily")?.nextAt).toBe(
      "2026-01-02T09:00:00.000Z",
    );
  });

  test("sends overdue one-offs after restart and coalesces missed recurring slots", async () => {
    const filename = path();
    let now = Date.parse("2026-01-01T08:00:00Z");
    const initial = new ScheduleService(
      filename,
      async () => {},
      () => now,
    );
    initial.create({ userId: "U0BOB", text: "once", at: "2026-01-01T09:00:00Z" }, "U0ALICE");
    initial.create(
      { userId: "U0BOB", text: "daily", recurrence: { time: "09:00", timezone: "UTC" } },
      "U0ALICE",
    );
    now = Date.parse("2026-01-05T12:00:00Z");
    const sent: string[] = [];
    const restarted = new ScheduleService(
      filename,
      async (message) => {
        sent.push(message.text);
      },
      () => now,
    );
    restarted.start();
    await tick();
    await restarted.stop();
    expect(sent).toEqual(["once", "daily"]);
    expect(restarted.list("U0ALICE").find((item) => item.text === "daily")?.nextAt).toBe(
      "2026-01-06T09:00:00.000Z",
    );
  });

  test("does not claim a due slot when persistence fails", async () => {
    const filename = path();
    let now = Date.parse("2026-01-01T08:00:00Z");
    const sent: string[] = [];
    const service = new ScheduleService(
      filename,
      async (message) => {
        sent.push(message.text);
      },
      () => now,
    );
    service.create({ userId: "U0BOB", text: "once", at: "2026-01-01T09:00:00Z" }, "U0ALICE");
    (service as any).save = () => {
      throw new Error("disk full");
    };
    now = Date.parse("2026-01-01T09:01:00Z");
    service.start();
    await tick();
    expect(sent).toEqual([]);
    expect(service.list("U0ALICE")[0]!.status).toBe("active");
    await service.stop();
    const restarted = new ScheduleService(
      filename,
      async (message) => {
        sent.push(message.text);
      },
      () => now,
    );
    restarted.start();
    await tick();
    await restarted.stop();
    expect(sent).toEqual(["once"]);
  });

  test("keeps today's recurring slot after a late delivery before its scheduled time", async () => {
    const filename = path();
    let now = Date.parse("2026-01-01T08:00:00Z");
    new ScheduleService(
      filename,
      async () => {},
      () => now,
    ).create(
      { userId: "U0BOB", text: "daily", recurrence: { time: "09:00", timezone: "UTC" } },
      "U0ALICE",
    );
    now = Date.parse("2026-01-02T08:00:00Z");
    const sent: string[] = [];
    const restarted = new ScheduleService(
      filename,
      async (message) => {
        sent.push(message.text);
      },
      () => now,
    );
    restarted.start();
    await tick();
    await restarted.stop();
    expect(sent).toEqual(["daily"]);
    expect(restarted.list("U0ALICE")[0]!.nextAt).toBe("2026-01-02T09:00:00.000Z");
  });

  test("rejects ambiguous, invalid, or past schedules", () => {
    const service = new ScheduleService(path(), async () => {});
    expect(() =>
      service.create({ userId: "C123", text: "hi", at: "2027-01-01T00:00:00Z" }, "U0A"),
    ).toThrow("Recipient");
    expect(() =>
      service.create({ userId: "U0BOB", text: "hi", at: "2020-01-01T00:00:00Z" }, "U0A"),
    ).toThrow("future");
    expect(() =>
      service.create(
        { userId: "U0BOB", text: "hi", recurrence: { time: "9am", timezone: "UTC" } },
        "U0A",
      ),
    ).toThrow("HH:mm");
  });
});
