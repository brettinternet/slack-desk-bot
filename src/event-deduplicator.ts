import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

const DEFAULT_TTL_MS = 10 * 60_000;
const STORE_VERSION = 1;
const MAX_PERSISTED_IDS = 500;

interface EventDeduplicatorOptions {
  ttlMs?: number;
  statePath?: string;
}

interface StoredEventDeduplicatorState {
  version: 1;
  expirations: Array<{ id: string; expiresAt: number }>;
}

export class EventDeduplicator {
  private readonly expirations = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly statePath: string | undefined;

  constructor(options: EventDeduplicatorOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.statePath = options.statePath;
    this.load(Date.now());
  }

  accept(ids: readonly string[], now = Date.now()): boolean {
    for (const [id, expiresAt] of this.expirations) {
      if (expiresAt <= now) this.expirations.delete(id);
    }

    if (ids.some((id) => this.expirations.has(id))) return false;

    const expiresAt = now + this.ttlMs;
    for (const id of ids) this.expirations.set(id, expiresAt);
    while (this.statePath && this.expirations.size > MAX_PERSISTED_IDS) {
      const oldest = this.expirations.keys().next().value;
      if (oldest === undefined) break;
      this.expirations.delete(oldest);
    }
    this.save();
    return true;
  }

  private load(now: number): void {
    if (!this.statePath || !existsSync(this.statePath)) return;
    try {
      const stored = JSON.parse(
        readFileSync(this.statePath, "utf8"),
      ) as StoredEventDeduplicatorState;
      if (stored.version !== STORE_VERSION || !Array.isArray(stored.expirations)) {
        throw new Error("invalid event deduplicator state");
      }
      for (const expiration of stored.expirations.slice(-MAX_PERSISTED_IDS)) {
        if (
          typeof expiration?.id === "string" &&
          Number.isFinite(expiration.expiresAt) &&
          expiration.expiresAt > now
        ) {
          this.expirations.set(expiration.id, expiration.expiresAt);
        }
      }
    } catch {
      try {
        renameSync(this.statePath, `${this.statePath}.corrupt-${Date.now()}`);
      } catch {}
    }
  }

  private save(): void {
    if (!this.statePath) return;
    const state: StoredEventDeduplicatorState = {
      version: STORE_VERSION,
      expirations: [...this.expirations].map(([id, expiresAt]) => ({ id, expiresAt })),
    };
    const temporary = `${this.statePath}.${process.pid}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      renameSync(temporary, this.statePath);
    } catch {}
  }
}
