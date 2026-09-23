import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { writeStructuredLog } from "./log.ts";

export interface Observation {
  fields: Record<string, string>;
  url: string;
}
export interface AutomationSource {
  read(id: string): Promise<Observation>;
  fields: readonly string[];
  validId(id: string): boolean;
}
export interface Automation {
  id: string;
  creatorId: string;
  source: { kind: string; id: string };
  condition: { field: string; equals: string };
  recipientId: string;
  lastValue: string;
  nextAt: string;
  expiresAt: string;
  status: "active" | "paused" | "completed";
  failures: number;
  errorNotified: boolean;
}
export interface AutomationInput {
  source: { kind: string; id: string };
  condition: { field: string; equals: string };
}

const INTERVAL_MS = 15 * 60_000;
const LIFETIME_MS = 30 * 86_400_000;

function validAutomation(value: unknown): value is Automation {
  if (!value || typeof value !== "object") return false;
  const a = value as Partial<Automation>;
  return (
    typeof a.id === "string" &&
    typeof a.creatorId === "string" &&
    typeof a.source?.kind === "string" &&
    typeof a.source.id === "string" &&
    typeof a.condition?.field === "string" &&
    typeof a.condition.equals === "string" &&
    typeof a.recipientId === "string" &&
    typeof a.lastValue === "string" &&
    typeof a.nextAt === "string" &&
    Number.isFinite(Date.parse(a.nextAt)) &&
    typeof a.expiresAt === "string" &&
    Number.isFinite(Date.parse(a.expiresAt)) &&
    (a.status === "active" || a.status === "paused" || a.status === "completed") &&
    typeof a.failures === "number" &&
    Number.isInteger(a.failures) &&
    a.failures >= 0 &&
    typeof a.errorNotified === "boolean"
  );
}

/** A bounded, deterministic poller. Sources and actions are supplied by trusted service code. */
export class AutomationService {
  private readonly items = new Map<string, Automation>();
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private stopped = true;
  private retryNotBefore = 0;

  constructor(
    private readonly path: string,
    private readonly sources: Record<string, AutomationSource>,
    private readonly send: (
      recipientId: string,
      text: string,
      creatorId: string,
    ) => Promise<unknown>,
    private readonly now: () => number = Date.now,
    private readonly canRun: (creatorId: string) => boolean = () => true,
  ) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (!existsSync(path)) return;
    try {
      const file: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (
        !file ||
        typeof file !== "object" ||
        (file as { version?: unknown }).version !== 1 ||
        !Array.isArray((file as { automations?: unknown }).automations) ||
        !(file as { automations: unknown[] }).automations.every(validAutomation)
      )
        throw new Error("Invalid automation store");
      for (const item of (file as { automations: Automation[] }).automations)
        this.items.set(item.id, item);
    } catch {
      const movedTo = `${path}.corrupt-${Date.now()}`;
      renameSync(path, movedTo);
      writeStructuredLog({
        event: "operator_error",
        component: "automations",
        message: "Automation store unreadable; moved aside",
        error_type: "CorruptAutomationStore",
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
  list(actor: string, admin = false): Automation[] {
    return [...this.items.values()]
      .filter((a) => admin || a.creatorId === actor)
      .map((a) => structuredClone(a));
  }
  async create(
    input: AutomationInput,
    actor: string,
  ): Promise<{ automation?: Automation; alreadyMet: boolean }> {
    if (this.list(actor).filter((a) => a.status !== "completed").length >= 100)
      throw new Error("Maximum 100 active automations per creator");
    const source = this.sources[input.source.kind];
    if (!source || input.source.id.length > 100 || !source.validId(input.source.id))
      throw new Error("Unknown source or invalid source identifier");
    if (
      !source.fields.includes(input.condition.field) ||
      !input.condition.equals.trim() ||
      input.condition.equals.length > 100
    )
      throw new Error("Unsupported condition");
    const observation = await source.read(input.source.id);
    const current = observation.fields[input.condition.field];
    if (typeof current !== "string") throw new Error("Condition field unavailable");
    if (current === input.condition.equals) return { alreadyMet: true };
    const now = this.now();
    const item: Automation = {
      id: randomUUID(),
      creatorId: actor,
      source: input.source,
      condition: input.condition,
      recipientId: actor,
      lastValue: current,
      nextAt: new Date(now + INTERVAL_MS).toISOString(),
      expiresAt: new Date(now + LIFETIME_MS).toISOString(),
      status: "active",
      failures: 0,
      errorNotified: false,
    };
    this.items.set(item.id, item);
    try {
      this.save();
    } catch (error) {
      this.items.delete(item.id);
      throw error;
    }
    this.arm();
    return { automation: structuredClone(item), alreadyMet: false };
  }
  pause(id: string, actor: string, admin = false): Automation {
    return this.setStatus(id, actor, "paused", admin);
  }
  resume(id: string, actor: string, admin = false): Automation {
    return this.setStatus(id, actor, "active", admin);
  }
  cancel(id: string, actor: string, admin = false): void {
    const item = this.require(id, actor, admin);
    this.items.delete(id);
    try {
      this.save();
    } catch (error) {
      this.items.set(id, item);
      throw error;
    }
    this.arm();
  }
  private setStatus(
    id: string,
    actor: string,
    status: "active" | "paused",
    admin: boolean,
  ): Automation {
    const item = this.require(id, actor, admin);
    if (item.status === "completed") throw new Error("Automation already completed");
    if (
      status === "active" &&
      item.status !== "active" &&
      this.list(item.creatorId).filter((a) => a.status === "active").length >= 100
    )
      throw new Error("Maximum 100 active automations per creator");
    const previous = structuredClone(item);
    item.status = status;
    if (status === "active") item.nextAt = new Date(this.now()).toISOString();
    try {
      this.save();
    } catch (error) {
      this.items.set(id, previous);
      throw error;
    }
    this.arm();
    return structuredClone(item);
  }
  private require(id: string, actor: string, admin: boolean): Automation {
    const item = this.items.get(id);
    if (!item || (!admin && item.creatorId !== actor)) throw new Error("Automation not found");
    return item;
  }
  private save(): void {
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(
      temporary,
      `${JSON.stringify({ version: 1, automations: [...this.items.values()] }, null, 2)}\n`,
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
        .filter((a) => a.status === "active")
        .map((a) => Date.parse(a.nextAt)),
    );
    if (Number.isFinite(due))
      this.timer = setTimeout(
        () => {
          this.running = this.dispatch()
            .catch((error) => {
              this.retryNotBefore = this.now() + 60_000;
              writeStructuredLog({
                event: "operator_error",
                component: "automations",
                message: "Automation dispatcher failed",
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
  private async dispatch(): Promise<void> {
    for (const item of this.items.values()) {
      if (this.stopped || item.status !== "active" || Date.parse(item.nextAt) > this.now())
        continue;
      if (!this.canRun(item.creatorId)) {
        item.status = "paused";
        this.save();
        continue;
      }
      // Claim before any external operation; on restart, at most one check per interval.
      item.nextAt = new Date(this.now() + INTERVAL_MS).toISOString();
      const claimedNextAt = item.nextAt;
      this.save();
      if (this.now() >= Date.parse(item.expiresAt)) {
        item.status = "completed";
        this.save();
        continue;
      }
      try {
        const observation = await this.sources[item.source.kind]!.read(item.source.id);
        if (
          this.items.get(item.id) !== item ||
          item.status !== "active" ||
          item.nextAt !== claimedNextAt
        )
          continue;
        const value = observation.fields[item.condition.field];
        if (typeof value !== "string") throw new Error("Condition field unavailable");
        item.lastValue = value;
        item.failures = 0;
        item.errorNotified = false;
        if (value === item.condition.equals) {
          item.status = "completed";
          this.save(); // Claim the notification before sending, like scheduled DMs.
          await this.send(
            item.recipientId,
            `${item.source.id} reached ${item.condition.equals}. ${observation.url}`,
            item.creatorId,
          );
        } else this.save();
      } catch (error) {
        if (this.items.get(item.id) !== item || this.items.get(item.id)?.status === "paused")
          continue;
        if (item.status === "completed") {
          writeStructuredLog({
            event: "operator_error",
            component: "automations",
            message: "Automation delivery failed",
            error_type: error instanceof Error ? error.name : "UnknownError",
          });
          continue;
        }
        item.failures++;
        if (item.failures >= 3 && !item.errorNotified) {
          item.errorNotified = true;
          this.save();
          try {
            await this.send(
              item.recipientId,
              `Automation for ${item.source.id} could not check its source after repeated attempts. Check the service configuration.`,
              item.creatorId,
            );
          } catch {
            /* Do not retry a possibly delivered DM. */
          }
        }
        this.save();
      }
    }
  }
}
