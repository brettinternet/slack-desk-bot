import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { DirectMessage } from "./agent.ts";
import { MAX_DIRECT_MESSAGE_CHARACTERS } from "./direct-message-tool.ts";
import { writeStructuredLog } from "./log.ts";

export type Recurrence = { time: string; timezone: string; weekdays?: number[] };
export interface Schedule {
  id: string;
  creatorId: string;
  authorId: string;
  userId: string;
  text: string;
  nextAt: string;
  recurrence?: Recurrence;
  status: "active" | "completed" | "failed";
  lastError?: string;
}
export interface ScheduleInput {
  userId: string;
  text: string;
  at?: string;
  recurrence?: Recurrence;
}

function validZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

function validateRecurrence(value: Recurrence): void {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value.time))
    throw new Error("time must be HH:mm (24-hour)");
  if (!validZone(value.timezone)) throw new Error("timezone must be a valid IANA timezone");
  if (
    value.weekdays !== undefined &&
    (value.weekdays.length === 0 ||
      value.weekdays.some((day) => !Number.isInteger(day) || day < 0 || day > 6))
  ) {
    throw new Error("weekdays must be days 0-6 (Sunday-Saturday)");
  }
}

/** The first local wall-clock minute strictly after `after`. Nonexistent DST times are skipped. */
export function nextOccurrence(recurrence: Recurrence, after: number, skipDateAt?: number): string {
  validateRecurrence(recurrence);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: recurrence.timezone,
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const localDate = (parts: Record<string, string>) => `${parts.year}-${parts.month}-${parts.day}`;
  const skipDate =
    skipDateAt === undefined
      ? undefined
      : localDate(
          Object.fromEntries(
            formatter.formatToParts(skipDateAt).map(({ type, value }) => [type, value]),
          ),
        );
  const weekdays: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  let minute = Math.floor(after / 60_000) * 60_000 + 60_000;
  // Eight days includes at least one occurrence for every weekly weekday, even across DST.
  for (const end = minute + 8 * 86_400_000; minute < end; minute += 60_000) {
    const parts = Object.fromEntries(
      formatter.formatToParts(minute).map(({ type, value }) => [type, value]),
    );
    if (
      (!skipDate || localDate(parts) !== skipDate) &&
      `${parts.hour}:${parts.minute}` === recurrence.time &&
      (recurrence.weekdays === undefined || recurrence.weekdays.includes(weekdays[parts.weekday!]!))
    ) {
      return new Date(minute).toISOString();
    }
  }
  throw new Error("No occurrence found in the next eight days");
}

function validSchedule(value: unknown): value is Schedule {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<Schedule>;
  if (item.recurrence !== undefined) {
    if (
      !item.recurrence ||
      typeof item.recurrence !== "object" ||
      typeof item.recurrence.time !== "string" ||
      typeof item.recurrence.timezone !== "string" ||
      (item.recurrence.weekdays !== undefined && !Array.isArray(item.recurrence.weekdays))
    )
      return false;
    try {
      validateRecurrence(item.recurrence);
    } catch {
      return false;
    }
  }
  return (
    typeof item.id === "string" &&
    item.id.length > 0 &&
    typeof item.creatorId === "string" &&
    item.creatorId.length > 0 &&
    typeof item.authorId === "string" &&
    item.authorId.length > 0 &&
    typeof item.userId === "string" &&
    /^[UW][A-Z0-9]{2,}$/.test(item.userId) &&
    typeof item.text === "string" &&
    item.text.length > 0 &&
    item.text.length <= MAX_DIRECT_MESSAGE_CHARACTERS &&
    typeof item.nextAt === "string" &&
    Number.isFinite(Date.parse(item.nextAt)) &&
    (item.status === "active" || item.status === "completed" || item.status === "failed")
  );
}

export class ScheduleService {
  private readonly items = new Map<string, Schedule>();
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private retryNotBefore = 0;
  private stopped = true;
  constructor(
    private readonly path: string,
    private readonly send: (message: DirectMessage, creatorId?: string) => Promise<unknown>,
    private readonly now: () => number = Date.now,
  ) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (!existsSync(path)) return;
    try {
      const file: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (
        !file ||
        typeof file !== "object" ||
        (file as { version?: unknown }).version !== 1 ||
        !Array.isArray((file as { schedules?: unknown }).schedules) ||
        !(file as { schedules: unknown[] }).schedules.every(validSchedule)
      )
        throw new Error("Invalid schedule store");
      for (const item of (file as { schedules: Schedule[] }).schedules)
        this.items.set(item.id, item);
    } catch {
      // Preserve unreadable state for operator recovery rather than silently overwriting it.
      const movedTo = `${path}.corrupt-${Date.now()}`;
      renameSync(path, movedTo);
      writeStructuredLog({
        event: "operator_error",
        component: "schedules",
        message: "Schedule store unreadable; moved aside",
        error_type: "CorruptScheduleStore",
        moved_to: movedTo,
      });
    }
  }

  start(): void {
    this.stopped = false;
    this.arm();
  }
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.running;
  }

  list(actor: string, admin = false): Schedule[] {
    return [...this.items.values()]
      .filter((item) => admin || item.creatorId === actor)
      .sort((a, b) => a.nextAt.localeCompare(b.nextAt))
      .map((item) => structuredClone(item));
  }

  create(input: ScheduleInput, actor: string): Schedule {
    if (this.list(actor).filter((item) => item.status === "active").length >= 100)
      throw new Error("Maximum 100 active schedules per creator");
    const item = this.build(input, actor);
    this.items.set(item.id, item);
    try {
      this.save();
    } catch (error) {
      this.items.delete(item.id);
      throw error;
    }
    this.arm();
    return structuredClone(item);
  }

  update(id: string, input: ScheduleInput, actor: string, admin = false): Schedule {
    const previous = this.require(id, actor, admin);
    const item = this.build(
      { ...input, userId: input.userId || previous.userId },
      previous.creatorId,
      id,
      actor,
    );
    this.items.set(id, item);
    try {
      this.save();
    } catch (error) {
      this.items.set(id, previous);
      throw error;
    }
    this.arm();
    return structuredClone(item);
  }

  cancel(id: string, actor: string, admin = false): void {
    const previous = this.require(id, actor, admin);
    this.items.delete(id);
    try {
      this.save();
    } catch (error) {
      this.items.set(id, previous);
      throw error;
    }
    this.arm();
  }

  private require(id: string, actor: string, admin: boolean): Schedule {
    const item = this.items.get(id);
    if (!item || (!admin && item.creatorId !== actor)) throw new Error("Schedule not found");
    return item;
  }

  private build(
    input: ScheduleInput,
    creatorId: string,
    id: string = randomUUID(),
    authorId = creatorId,
  ): Schedule {
    const userId = input.userId.trim().replace(/^<@([A-Z0-9]+)>$/, "$1");
    if (!/^[UW][A-Z0-9]{2,}$/.test(userId)) throw new Error("Recipient must be a Slack member ID");
    const text = input.text.trim();
    if (!text || text.length > MAX_DIRECT_MESSAGE_CHARACTERS)
      throw new Error(`Text must be 1-${MAX_DIRECT_MESSAGE_CHARACTERS} characters`);
    if (Boolean(input.at) === Boolean(input.recurrence))
      throw new Error("Specify exactly one of at or recurrence");
    let nextAt: string;
    if (input.at) {
      const match =
        /^(\d{4}-\d\d-\d\dT\d\d:\d\d)(?::(\d\d)(?:\.\d{1,3})?)?(Z|([+-])(\d\d):(\d\d))$/.exec(
          input.at,
        );
      if (!match) throw new Error("at must be an ISO timestamp with timezone");
      const timestamp = Date.parse(input.at);
      const offsetMinutes =
        match[3] === "Z"
          ? 0
          : (match[4] === "+" ? 1 : -1) * (Number(match[5]) * 60 + Number(match[6]));
      if (
        Math.abs(offsetMinutes) > 23 * 60 + 59 ||
        !Number.isFinite(timestamp) ||
        new Date(timestamp + offsetMinutes * 60_000).toISOString().slice(0, 19) !==
          `${match[1]}:${match[2] ?? "00"}`
      )
        throw new Error("at must be a valid ISO timestamp with timezone");
      if (timestamp <= this.now()) throw new Error("at must be a future timestamp");
      nextAt = new Date(timestamp).toISOString();
    } else {
      nextAt = nextOccurrence(input.recurrence!, this.now());
    }
    return {
      id,
      creatorId,
      authorId,
      userId,
      text,
      nextAt,
      ...(input.recurrence ? { recurrence: input.recurrence } : {}),
      status: "active",
    };
  }

  private save(): void {
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(
      temporary,
      `${JSON.stringify({ version: 1, schedules: [...this.items.values()] }, null, 2)}\n`,
      { mode: 0o600 },
    );
    renameSync(temporary, this.path);
    this.retryNotBefore = 0;
  }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.stopped || this.running) return;
    const due = Math.min(
      ...[...this.items.values()]
        .filter((item) => item.status === "active")
        .map((item) => Date.parse(item.nextAt)),
    );
    if (Number.isFinite(due)) {
      this.timer = setTimeout(
        () => {
          this.running = this.dispatch()
            .catch((error) => {
              // Never spin on a due slot that could not be committed to disk.
              this.retryNotBefore = this.now() + 60_000;
              writeStructuredLog({
                event: "operator_error",
                component: "schedules",
                message: "Schedule dispatcher retrying after error",
                error_type: error instanceof Error ? error.name : "UnknownError",
              });
            })
            .finally(() => {
              this.running = undefined;
              this.arm();
            });
        },
        Math.min(Math.max(0, due - this.now(), this.retryNotBefore - this.now()), 2_147_483_647),
      );
    }
  }

  private async dispatch(): Promise<void> {
    for (const item of this.items.values()) {
      if (this.stopped || item.status !== "active" || Date.parse(item.nextAt) > this.now())
        continue;
      // Commit the claimed slot before calling Slack: restart cannot send the same slot twice.
      const claimedAt = Date.parse(item.nextAt);
      const previousStatus = item.status;
      const previousNextAt = item.nextAt;
      if (item.recurrence) item.nextAt = nextOccurrence(item.recurrence, this.now(), claimedAt);
      else item.status = "completed";
      try {
        this.save();
      } catch (error) {
        item.status = previousStatus;
        item.nextAt = previousNextAt;
        throw error;
      }
      try {
        await this.send(
          { userId: item.userId, text: item.text },
          item.authorId === "local-operator" ? undefined : item.authorId,
        );
        delete item.lastError;
      } catch (error) {
        item.lastError = error instanceof Error ? error.message : "Delivery failed";
        if (!item.recurrence) item.status = "failed";
      }
      this.save();
    }
  }
}
