import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

const REPLY_WINDOW_MS = 24 * 60 * 60 * 1_000;
const MAX_PENDING_THREADS = 500;

interface PendingReply {
  userId: string;
  expiresAt: number;
}

/** Persists the one respondent expected in each bot-owned thread. Expired turns are never accepted. */
export class ThreadReplyStore {
  private readonly pending = new Map<string, PendingReply>();
  private readonly owners = new Map<string, PendingReply>();

  constructor(
    private readonly path?: string,
    private readonly now: () => number = Date.now,
  ) {
    if (!path || !existsSync(path)) return;
    try {
      const stored: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (
        !stored ||
        typeof stored !== "object" ||
        !Array.isArray((stored as { pending?: unknown }).pending)
      ) {
        throw new Error("Invalid pending thread replies");
      }
      const state = stored as { pending: unknown[]; owners?: unknown[] };
      this.loadEntries(state.pending, this.pending);
      this.loadEntries(state.owners ?? [], this.owners);
    } catch {
      try {
        renameSync(path, `${path}.corrupt-${Date.now()}`);
      } catch {}
      this.pending.clear();
      this.owners.clear();
    }
  }

  private loadEntries(entries: unknown[], target: Map<string, PendingReply>): void {
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string") continue;
      const reply: unknown = entry[1];
      if (
        reply &&
        typeof reply === "object" &&
        "userId" in reply &&
        typeof reply.userId === "string" &&
        "expiresAt" in reply &&
        typeof reply.expiresAt === "number" &&
        Number.isFinite(reply.expiresAt) &&
        reply.expiresAt > this.now()
      )
        target.set(entry[0], { userId: reply.userId, expiresAt: reply.expiresAt });
    }
  }

  isOwner(thread: string, userId: string): boolean {
    const owner = this.owners.get(thread);
    return owner?.userId === userId && owner.expiresAt > this.now();
  }

  setOwner(thread: string, userId: string): void {
    this.owners.delete(thread);
    this.owners.set(thread, { userId, expiresAt: this.now() + REPLY_WINDOW_MS });
    for (const [key, owner] of this.owners) {
      if (owner.expiresAt <= this.now()) this.owners.delete(key);
    }
    while (this.owners.size > MAX_PENDING_THREADS)
      this.owners.delete(this.owners.keys().next().value!);
    this.save();
  }

  expects(thread: string, userId: string): boolean {
    const reply = this.pending.get(thread);
    if (reply && reply.expiresAt <= this.now()) {
      this.clear(thread);
      return false;
    }
    return reply?.userId === userId;
  }

  set(thread: string, userId: string): void {
    this.pending.delete(thread);
    this.pending.set(thread, { userId, expiresAt: this.now() + REPLY_WINDOW_MS });
    for (const [key, reply] of this.pending) {
      if (reply.expiresAt <= this.now()) this.pending.delete(key);
    }
    while (this.pending.size > MAX_PENDING_THREADS)
      this.pending.delete(this.pending.keys().next().value!);
    this.save();
  }

  clear(thread: string): void {
    if (this.pending.delete(thread)) this.save();
  }

  private save(): void {
    if (!this.path) return;
    const temporary = `${this.path}.${process.pid}.tmp`;
    try {
      writeFileSync(
        temporary,
        `${JSON.stringify({ pending: [...this.pending], owners: [...this.owners] }, null, 2)}\n`,
        {
          mode: 0o600,
        },
      );
      renameSync(temporary, this.path);
    } catch {
      // Keep routing in memory if the state directory temporarily becomes unavailable.
    }
  }
}
