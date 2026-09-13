import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

const STORE_VERSION = 1;

interface StoredFile<T> {
  version: 1;
  conversations: Record<string, T>;
}

/**
 * Persists canonical-conversation-to-session mappings for the external CLI
 * backends. A corrupt or unreadable store is moved aside rather than thrown,
 * because throwing here happens in the backend constructor and would make the
 * service restart-loop under launchd.
 */
export class ConversationStore<T> {
  constructor(
    private readonly path: string,
    private readonly isValid: (value: T) => boolean,
    private readonly onCorrupt?: (details: {
      path: string;
      movedTo: string;
      reason: string;
    }) => void,
  ) {}

  load(): Map<string, T> {
    const mappings = new Map<string, T>();
    if (!existsSync(this.path)) return mappings;
    try {
      const stored = JSON.parse(readFileSync(this.path, "utf8")) as StoredFile<T>;
      if (stored.version !== STORE_VERSION || !stored.conversations) {
        throw new Error(`unsupported store version ${String(stored.version)}`);
      }
      for (const [conversationId, mapping] of Object.entries(stored.conversations)) {
        if (this.isValid(mapping)) mappings.set(conversationId, mapping);
      }
    } catch (error) {
      this.quarantine(error instanceof Error ? error.message : "unreadable store");
      return new Map<string, T>();
    }
    return mappings;
  }

  save(mappings: ReadonlyMap<string, T>): void {
    const contents: StoredFile<T> = {
      version: STORE_VERSION,
      conversations: Object.fromEntries(mappings),
    };
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(contents, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.path);
  }

  private quarantine(reason: string): void {
    const movedTo = `${this.path}.corrupt-${Date.now()}`;
    try {
      renameSync(this.path, movedTo);
    } catch {
      return;
    }
    this.onCorrupt?.({ path: this.path, movedTo, reason });
  }
}

/** True when a store file exists but cannot be parsed, for doctor reporting. */
export function isConversationStoreCorrupt(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    const stored = JSON.parse(readFileSync(path, "utf8")) as StoredFile<unknown>;
    return stored.version !== STORE_VERSION || !stored.conversations;
  } catch {
    return true;
  }
}
