import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { AgentBackend, AgentRequest } from "./agent.ts";
import { workspacePolicy } from "./workspace-policy.ts";

const TOOLS = ["read", "grep", "find", "ls", "edit", "write"];

interface SessionEntry {
  session: Promise<AgentSession>;
  idleTimer?: ReturnType<typeof setTimeout>;
}

export function createResponseCollector() {
  const output: string[] = [];
  let currentMessage: string[] | undefined;

  return {
    handle(event: AgentSessionEvent): void {
      if (event.type === "message_start" && event.message.role === "assistant") {
        currentMessage = [];
      } else if (
        event.type === "message_update" &&
        event.assistantMessageEvent.type === "text_delta"
      ) {
        currentMessage?.push(event.assistantMessageEvent.delta);
      } else if (event.type === "message_end" && event.message.role === "assistant") {
        if (event.message.stopReason !== "error" && currentMessage?.length) {
          output.push(currentMessage.join(""));
        }
        currentMessage = undefined;
      }
    },
    text(): string {
      return output.join("\n\n").trim();
    },
  };
}

export class PiBackend implements AgentBackend {
  private readonly sessions = new Map<string, SessionEntry>();

  constructor(
    private readonly workspace: string,
    private readonly sessionIdleMs: number,
  ) {}

  async run({ conversationId, prompt, signal }: AgentRequest): Promise<string> {
    const session = await this.sessionFor(conversationId);
    if (signal?.aborted) throw signal.reason;

    const collector = createResponseCollector();
    const unsubscribe = session.subscribe(collector.handle);
    let abortPromise: Promise<void> | undefined;
    const abort = () => {
      abortPromise ??= session.abort();
    };
    signal?.addEventListener("abort", abort, { once: true });

    try {
      await session.prompt(prompt);
      if (signal?.aborted) throw signal.reason;
      return collector.text();
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
      if (abortPromise) await abortPromise;
      unsubscribe();
      this.scheduleSessionDisposal(conversationId);
    }
  }

  dispose(): void {
    for (const entry of this.sessions.values()) {
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
      void entry.session.then((session) => session.dispose());
    }
    this.sessions.clear();
  }

  private sessionFor(conversationId: string): Promise<AgentSession> {
    const existing = this.sessions.get(conversationId);
    if (existing) {
      if (existing.idleTimer) {
        clearTimeout(existing.idleTimer);
        existing.idleTimer = undefined;
      }
      return existing.session;
    }

    const entry: SessionEntry = { session: this.createSession() };
    this.sessions.set(conversationId, entry);
    entry.session.catch(() => {
      if (this.sessions.get(conversationId) === entry) this.sessions.delete(conversationId);
    });
    return entry.session;
  }

  private scheduleSessionDisposal(conversationId: string): void {
    const entry = this.sessions.get(conversationId);
    if (!entry) return;
    entry.idleTimer = setTimeout(() => {
      if (this.sessions.get(conversationId) !== entry) return;
      this.sessions.delete(conversationId);
      void entry.session.then((session) => session.dispose());
    }, this.sessionIdleMs);
  }

  private async createSession(): Promise<AgentSession> {
    const resourceLoader = new DefaultResourceLoader({
      cwd: this.workspace,
      agentDir: getAgentDir(),
      extensionFactories: [workspacePolicy(this.workspace)],
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd: this.workspace,
      resourceLoader,
      sessionManager: SessionManager.inMemory(this.workspace),
      tools: TOOLS,
    });
    return session;
  }
}
