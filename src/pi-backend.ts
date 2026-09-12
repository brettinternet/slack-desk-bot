import { createHash } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  type SessionInfo,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type {
  AgentAttachment,
  AgentBackend,
  AgentRequest,
  AgentRunObserver,
  SessionCommand,
} from "./agent.ts";
import type { AgentMode } from "./config.ts";
import { workspacePolicy } from "./workspace-policy.ts";

const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];

export function toolsForMode(mode: AgentMode): string[] {
  return mode === "read-write" ? [...READ_ONLY_TOOLS, "edit", "write"] : READ_ONLY_TOOLS;
}
const SESSION_NAME_PREFIX = "slack-agent:";
const DEFAULT_MAX_ACTIVE_SESSIONS = 32;
const DEFAULT_SESSION_IDLE_MS = 60 * 60 * 1_000;
const CLEANUP_INTERVAL_MS = 60_000;

interface CachedSession {
  ready: Promise<AgentSession>;
  session?: AgentSession;
  lastUsedAt: number;
  activeRuns: number;
}

export interface PiBackendOptions {
  mode?: AgentMode;
  instructions?: string;
  sessionDir?: string;
  maxActiveSessions?: number;
  sessionIdleMs?: number;
  now?: () => number;
  sessionFactory?: (sessionManager: SessionManager) => Promise<AgentSession>;
  sessionLister?: () => Promise<SessionInfo[]>;
  freshSessionManagerFactory?: () => SessionManager;
}

export function preparePiPrompt(prompt: string, attachments: readonly AgentAttachment[] = []) {
  const textFiles = attachments
    .filter((attachment) => attachment.kind === "text")
    .map((attachment) =>
      [
        `<slack-file name=${JSON.stringify(attachment.name)} media-type=${JSON.stringify(attachment.mediaType)}>`,
        attachment.text,
        "</slack-file>",
      ].join("\n"),
    );
  const images = attachments
    .filter((attachment) => attachment.kind === "image")
    .map((attachment) => ({
      type: "image" as const,
      data: attachment.data,
      mimeType: attachment.mediaType,
    }));
  const text = [prompt.trim(), ...textFiles].filter(Boolean).join("\n\n");
  return {
    text: text || "Review the attached Slack file(s).",
    images,
  };
}

export class AgentResponseError extends Error {
  constructor() {
    super("The agent's final response ended with a provider error");
    this.name = "AgentResponseError";
  }
}

export function createResponseCollector(observer?: AgentRunObserver) {
  const output: string[] = [];
  let currentMessage: string[] | undefined;
  let failed = false;

  return {
    handle(event: AgentSessionEvent): void {
      if (event.type === "tool_execution_start") {
        observer?.onToolUse();
      } else if (event.type === "message_start" && event.message.role === "assistant") {
        currentMessage = [];
      } else if (
        event.type === "message_update" &&
        event.assistantMessageEvent.type === "text_delta"
      ) {
        currentMessage?.push(event.assistantMessageEvent.delta);
      } else if (event.type === "message_end" && event.message.role === "assistant") {
        failed = event.message.stopReason === "error";
        if (!failed && currentMessage?.length) output.push(currentMessage.join(""));
        currentMessage = undefined;
      }
    },
    /** Returns the collected text, or throws when the final assistant turn failed. */
    text(): string {
      if (failed) throw new AgentResponseError();
      return output.join("\n\n").trim();
    },
  };
}

export function defaultSessionDirectory(workspace: string): string {
  const workspaceKey = createHash("sha256").update(workspace).digest("hex").slice(0, 16);
  return join(getAgentDir(), "slack-agent", "sessions", workspaceKey);
}

/**
 * Loads Pi resources for the workspace with the project marked untrusted, so `.pi/` settings,
 * extensions, skills, prompts, and `SYSTEM.md` inside `SLACK_AGENT_CWD` never run as service code.
 * User-level (`~/.pi/agent`) resources still load. The returned settings manager must be passed to
 * `createAgentSession` so the session honors the same trust state.
 */
export function createPiResources(workspace: string, instructions?: string) {
  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(workspace, agentDir, { projectTrusted: false });
  const resourceLoader = new DefaultResourceLoader({
    cwd: workspace,
    agentDir,
    settingsManager,
    appendSystemPrompt: instructions ? [instructions] : [],
    extensionFactories: [workspacePolicy(workspace)],
  });
  return { settingsManager, resourceLoader };
}

export class PiBackend implements AgentBackend {
  private readonly sessions = new Map<string, CachedSession>();
  private readonly sessionDir: string;
  private readonly maxActiveSessions: number;
  private readonly sessionIdleMs: number;
  private readonly now: () => number;
  private readonly cleanupTimer: ReturnType<typeof setInterval>;
  private disposed = false;

  constructor(
    private readonly workspace: string,
    private readonly options: PiBackendOptions = {},
  ) {
    this.sessionDir = options.sessionDir ?? defaultSessionDirectory(workspace);
    this.maxActiveSessions = options.maxActiveSessions ?? DEFAULT_MAX_ACTIVE_SESSIONS;
    this.sessionIdleMs = options.sessionIdleMs ?? DEFAULT_SESSION_IDLE_MS;
    this.now = options.now ?? Date.now;
    this.cleanupTimer = setInterval(() => this.sweep(), CLEANUP_INTERVAL_MS);
    this.cleanupTimer.unref();
  }

  async hasConversation(conversationId: string): Promise<boolean> {
    return this.sessions.has(conversationId) || Boolean(await this.findSession(conversationId));
  }

  async run(
    { conversationId, prompt, attachments, signal }: AgentRequest,
    observer?: AgentRunObserver,
  ): Promise<string> {
    const entry = this.cachedSessionFor(conversationId);
    entry.activeRuns++;
    entry.lastUsedAt = this.now();

    try {
      const session = await entry.ready;
      if (signal?.aborted) throw signal.reason;

      const collector = createResponseCollector(observer);
      const unsubscribe = session.subscribe(collector.handle);
      let abortPromise: Promise<void> | undefined;
      const abort = () => {
        abortPromise ??= session.abort();
      };
      signal?.addEventListener("abort", abort, { once: true });

      try {
        const input = preparePiPrompt(prompt, attachments);
        await session.prompt(input.text, { images: input.images });
        if (signal?.aborted) throw signal.reason;
        return collector.text();
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        throw error;
      } finally {
        signal?.removeEventListener("abort", abort);
        if (abortPromise) await abortPromise;
        unsubscribe();
      }
    } finally {
      entry.activeRuns--;
      entry.lastUsedAt = this.now();
      this.sweep();
    }
  }

  sessionCommand(conversationId: string, command: SessionCommand): Promise<string> {
    return command === "status" ? this.status(conversationId) : this.reset(conversationId);
  }

  dispose(): void {
    this.disposed = true;
    clearInterval(this.cleanupTimer);
    for (const entry of this.sessions.values()) {
      void entry.ready.then((session) => session.dispose()).catch(() => {});
    }
    this.sessions.clear();
  }

  private cachedSessionFor(conversationId: string): CachedSession {
    if (this.disposed) throw new Error("Pi backend is disposed");
    const existing = this.sessions.get(conversationId);
    if (existing) return existing;

    const entry: CachedSession = {
      ready: Promise.resolve(undefined as never),
      lastUsedAt: this.now(),
      activeRuns: 0,
    };
    entry.ready = this.restoreOrCreateSession(conversationId).then((session) => {
      entry.session = session;
      return session;
    });
    this.sessions.set(conversationId, entry);
    entry.ready.catch(() => {
      if (this.sessions.get(conversationId) === entry) this.sessions.delete(conversationId);
    });
    return entry;
  }

  private async restoreOrCreateSession(conversationId: string): Promise<AgentSession> {
    const persisted = await this.findSession(conversationId);
    const manager = persisted
      ? SessionManager.open(persisted.path, this.sessionDir, this.workspace)
      : this.createPersistentManager();
    const session = await this.createSession(manager);
    if (!persisted) session.setSessionName(this.sessionName(conversationId));
    return session;
  }

  private async createFreshSession(conversationId: string): Promise<AgentSession> {
    const session = await this.createSession(this.createPersistentManager());
    session.setSessionName(this.sessionName(conversationId));
    return session;
  }

  private async createSession(sessionManager: SessionManager): Promise<AgentSession> {
    if (this.options.sessionFactory) return this.options.sessionFactory(sessionManager);

    const { settingsManager, resourceLoader } = createPiResources(
      this.workspace,
      this.options.instructions,
    );
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd: this.workspace,
      resourceLoader,
      settingsManager,
      sessionManager,
      tools: toolsForMode(this.options.mode ?? "read-only"),
    });
    return session;
  }

  private async listSessions(): Promise<SessionInfo[]> {
    return this.options.sessionLister
      ? this.options.sessionLister()
      : SessionManager.list(this.workspace, this.sessionDir);
  }

  private async findSession(conversationId: string): Promise<SessionInfo | undefined> {
    const name = this.sessionName(conversationId);
    return (await this.listSessions())
      .filter((session) => session.name === name)
      .sort((left, right) => right.modified.getTime() - left.modified.getTime())[0];
  }

  private async status(conversationId: string): Promise<string> {
    const cached = this.sessions.get(conversationId);
    if (cached) {
      const session = await cached.ready;
      const stats = session.getSessionStats();
      return [
        `Session: ${stats.sessionId.slice(0, 8)}`,
        `State: ${cached.activeRuns > 0 ? "running" : "idle"}`,
        `Messages: ${stats.totalMessages}`,
        `Last active: ${new Date(cached.lastUsedAt).toISOString()}`,
        `Persisted: ${stats.sessionFile && existsSync(stats.sessionFile) ? "yes" : "no"}`,
      ].join("\n");
    }

    const persisted = await this.findSession(conversationId);
    if (!persisted) return "No session exists for this conversation.";
    return [
      `Session: ${persisted.id.slice(0, 8)}`,
      "State: inactive",
      `Messages: ${persisted.messageCount}`,
      `Last active: ${persisted.modified.toISOString()}`,
      "Persisted: yes",
    ].join("\n");
  }

  private async reset(conversationId: string): Promise<string> {
    const cached = this.sessions.get(conversationId);
    if (cached?.activeRuns) return "Cannot reset while a request is running. Cancel it first.";

    const previousInfo = cached ? undefined : await this.findSession(conversationId);
    const previous = cached ? await cached.ready : undefined;
    const fresh = await this.createFreshSession(conversationId);
    const archiveName = `${this.sessionName(conversationId)}:reset:${this.now()}`;

    if (previous) {
      previous.setSessionName(archiveName);
      previous.dispose();
    } else if (previousInfo) {
      SessionManager.open(previousInfo.path, this.sessionDir, this.workspace).appendSessionInfo(
        archiveName,
      );
    }

    const entry: CachedSession = {
      ready: Promise.resolve(fresh),
      session: fresh,
      lastUsedAt: this.now(),
      activeRuns: 0,
    };
    this.sessions.set(conversationId, entry);
    this.sweep();
    return `Session reset. Previous history was retained; new session: ${fresh.sessionId.slice(0, 8)}.`;
  }

  private sweep(): void {
    const now = this.now();
    for (const [conversationId, entry] of this.sessions) {
      if (entry.activeRuns === 0 && now - entry.lastUsedAt >= this.sessionIdleMs) {
        this.evict(conversationId, entry);
      }
    }

    if (this.sessions.size <= this.maxActiveSessions) return;
    const candidates = [...this.sessions.entries()]
      .filter(([, entry]) => entry.activeRuns === 0)
      .sort(([, left], [, right]) => left.lastUsedAt - right.lastUsedAt);
    for (const [conversationId, entry] of candidates) {
      if (this.sessions.size <= this.maxActiveSessions) break;
      this.evict(conversationId, entry);
    }
  }

  private evict(conversationId: string, entry: CachedSession): void {
    if (this.sessions.get(conversationId) !== entry) return;
    this.sessions.delete(conversationId);
    void entry.ready.then((session) => session.dispose()).catch(() => {});
  }

  private createPersistentManager(): SessionManager {
    if (this.options.freshSessionManagerFactory) {
      return this.options.freshSessionManagerFactory();
    }
    const pending = SessionManager.create(this.workspace, this.sessionDir);
    const sessionFile = pending.getSessionFile();
    if (!sessionFile) throw new Error("Persistent session has no file path");
    writeFileSync(sessionFile, "", { flag: "wx" });
    return SessionManager.open(sessionFile, this.sessionDir, this.workspace);
  }

  private sessionName(conversationId: string): string {
    return `${SESSION_NAME_PREFIX}${conversationId}`;
  }
}
