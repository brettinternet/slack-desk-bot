import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

const STORE_VERSION = 1;
const MAX_PROCESSED_MESSAGES = 500;

interface StoredCatchUpState {
  version: 1;
  lastReconciledAt: number;
  processedMessages: Array<{ key: string; processedAt: number }>;
}

export class SlackCatchUpStore {
  private state: StoredCatchUpState;

  constructor(
    private readonly path: string,
    now: number,
  ) {
    this.state = this.load(now);
  }

  get lastReconciledAt(): number {
    return this.state.lastReconciledAt;
  }

  hasProcessed(key: string): boolean {
    return this.state.processedMessages.some((message) => message.key === key);
  }

  markProcessed(key: string, processedAt: number): void {
    this.state.processedMessages = [
      ...this.state.processedMessages.filter((message) => message.key !== key),
      { key, processedAt },
    ].slice(-MAX_PROCESSED_MESSAGES);
    this.save();
  }

  markReconciled(reconciledAt: number, oldestRetainedAt: number): void {
    this.state = {
      version: STORE_VERSION,
      lastReconciledAt: reconciledAt,
      processedMessages: this.state.processedMessages.filter(
        (message) => message.processedAt >= oldestRetainedAt,
      ),
    };
    this.save();
  }

  private load(now: number): StoredCatchUpState {
    if (!existsSync(this.path)) {
      const initial: StoredCatchUpState = {
        version: STORE_VERSION,
        lastReconciledAt: now,
        processedMessages: [],
      };
      this.state = initial;
      this.save();
      return initial;
    }
    try {
      const stored = JSON.parse(readFileSync(this.path, "utf8")) as StoredCatchUpState;
      if (
        stored.version !== STORE_VERSION ||
        !Number.isFinite(stored.lastReconciledAt) ||
        !Array.isArray(stored.processedMessages)
      ) {
        throw new Error("invalid catch-up state");
      }
      return {
        version: STORE_VERSION,
        lastReconciledAt: stored.lastReconciledAt,
        processedMessages: stored.processedMessages.filter(
          (message) => typeof message?.key === "string" && Number.isFinite(message.processedAt),
        ),
      };
    } catch {
      const movedTo = `${this.path}.corrupt-${Date.now()}`;
      try {
        renameSync(this.path, movedTo);
      } catch {}
      const initial: StoredCatchUpState = {
        version: STORE_VERSION,
        lastReconciledAt: now,
        processedMessages: [],
      };
      this.state = initial;
      this.save();
      return initial;
    }
  }

  private save(): void {
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.path);
  }
}
