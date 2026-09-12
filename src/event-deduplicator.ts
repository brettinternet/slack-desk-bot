const DEFAULT_TTL_MS = 10 * 60_000;

export class EventDeduplicator {
  private readonly expirations = new Map<string, number>();

  constructor(private readonly ttlMs = DEFAULT_TTL_MS) {}

  accept(ids: readonly string[], now = Date.now()): boolean {
    for (const [id, expiresAt] of this.expirations) {
      if (expiresAt <= now) this.expirations.delete(id);
    }

    if (ids.some((id) => this.expirations.has(id))) return false;

    const expiresAt = now + this.ttlMs;
    for (const id of ids) this.expirations.set(id, expiresAt);
    return true;
  }
}
