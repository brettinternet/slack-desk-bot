import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { prepareTextPrompt } from "./agent-prompt.ts";
import { runSandboxedJsonl } from "./cli-process.ts";
import { ConversationStore } from "./conversation-store.ts";
import { writeStructuredLog } from "./log.ts";
import { seatbeltProfile } from "./seatbelt.ts";
import type {
  AgentAttachment,
  AgentBackend,
  AgentRequest,
  AgentRunObserver,
  ConversationSummary,
  SessionCommand,
} from "./agent.ts";

const SANDBOX_PROFILE = "sandbox.sb";
const STORE_FILE = "conversations.json";

interface StoredConversation {
  threadId: string;
  lastActiveAt: number;
}

interface ActiveRun {
  process: ChildProcessWithoutNullStreams;
}

export interface CodexBackendOptions {
  executable?: string;
  home?: string;
  instructions?: string;
  now?: () => number;
  spawnProcess?: typeof spawn;
  platform?: NodeJS.Platform;
  systemPromptSupported?: boolean;
}

export class CodexCapabilityError extends Error {}
export class CodexOutputError extends Error {}
export class CodexProviderError extends Error {
  constructor() {
    super("The Codex provider request failed");
  }
}

/** Seatbelt boundary around Codex and every command it starts. */
export function codexSandboxProfile(
  workspace: string,
  codexHome: string,
  executable: string,
): string {
  return seatbeltProfile({ workspace, home: codexHome, executable });
}

export function prepareCodexPrompt(
  prompt: string,
  attachments: readonly AgentAttachment[] = [],
  instructions?: string,
): string {
  if (attachments.some((attachment) => attachment.kind === "image")) {
    throw new CodexCapabilityError(
      "The Codex backend does not support image attachments without writing them to disk.",
    );
  }
  return prepareTextPrompt([instructions, prompt], attachments, "Respond to the Slack message.");
}

export function defaultCodexHome(workspace: string): string {
  const key = createHash("sha256").update(workspace).digest("hex").slice(0, 16);
  return join(homedir(), "Library", "Application Support", "SlackDeskBot", "codex", key);
}

export function codexProcessEnvironment(home: string): NodeJS.ProcessEnv {
  return {
    CODEX_HOME: home,
    HOME: home,
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
    NO_PROXY: process.env.NO_PROXY,
    PATH: process.env.PATH,
    SSL_CERT_DIR: process.env.SSL_CERT_DIR,
    SSL_CERT_FILE: process.env.SSL_CERT_FILE,
    TMPDIR: join(home, "tmp"),
    http_proxy: process.env.http_proxy,
    https_proxy: process.env.https_proxy,
    no_proxy: process.env.no_proxy,
    HTTP_PROXY: process.env.HTTP_PROXY,
    HTTPS_PROXY: process.env.HTTPS_PROXY,
  };
}

function findCodexExecutable(configured?: string): string {
  const executable =
    configured ?? execFileSync("/usr/bin/which", ["codex"], { encoding: "utf8" }).trim();
  if (!executable) throw new Error("Codex CLI is not installed or is not on PATH");
  return realpathSync(executable);
}

export function codexSupportsSystemPrompt(help: string): boolean {
  return help.includes("--config") || help.includes("-c, ");
}

function detectCodexSystemPromptSupport(executable: string, home: string): boolean {
  try {
    const help = execFileSync(executable, ["exec", "--help"], {
      encoding: "utf8",
      env: codexProcessEnvironment(home),
    });
    return codexSupportsSystemPrompt(help);
  } catch {
    return false;
  }
}

export class CodexBackend implements AgentBackend {
  private readonly executable: string;
  private readonly home: string;
  private readonly store: ConversationStore<StoredConversation>;
  private readonly sandboxPath: string;
  private readonly mappings = new Map<string, StoredConversation>();
  private readonly active = new Map<string, ActiveRun>();
  private readonly now: () => number;
  private readonly spawnProcess: typeof spawn;
  private readonly systemPromptSupported: boolean;
  private disposed = false;

  constructor(
    private readonly workspace: string,
    private readonly options: CodexBackendOptions = {},
  ) {
    if ((options.platform ?? process.platform) !== "darwin") {
      throw new Error("The Codex backend currently requires macOS Seatbelt sandboxing");
    }
    this.executable = findCodexExecutable(options.executable);
    this.home = resolve(options.home ?? defaultCodexHome(workspace));
    this.store = new ConversationStore<StoredConversation>(
      join(this.home, STORE_FILE),
      (mapping) => typeof mapping.threadId === "string" && Number.isFinite(mapping.lastActiveAt),
      ({ movedTo }) =>
        writeStructuredLog({
          event: "operator_error",
          component: "codex",
          message: "Conversation store was unreadable; moved aside and started empty",
          error_type: "CorruptConversationStore",
          moved_to: movedTo,
        }),
    );
    this.sandboxPath = join(this.home, SANDBOX_PROFILE);
    this.now = options.now ?? Date.now;
    this.spawnProcess = options.spawnProcess ?? spawn;
    mkdirSync(this.home, { recursive: true, mode: 0o700 });
    chmodSync(this.home, 0o700);
    this.systemPromptSupported =
      options.systemPromptSupported ??
      (!options.instructions || detectCodexSystemPromptSupport(this.executable, this.home));
    writeFileSync(this.sandboxPath, codexSandboxProfile(workspace, this.home, this.executable), {
      mode: 0o600,
    });
    this.loadMappings();
  }

  hasConversation(conversationId: string): Promise<boolean> {
    return Promise.resolve(this.mappings.has(conversationId));
  }

  listConversations(): Promise<ConversationSummary[]> {
    return Promise.resolve(
      [...this.mappings.entries()]
        .map(([conversationId, mapping]) => ({
          conversationId,
          sessionId: mapping.threadId,
          state: this.active.has(conversationId) ? ("running" as const) : ("inactive" as const),
          lastActiveAt: mapping.lastActiveAt,
        }))
        .sort((left, right) => right.lastActiveAt - left.lastActiveAt),
    );
  }

  async run(request: AgentRequest, observer?: AgentRunObserver): Promise<string> {
    if (this.disposed) throw new Error("Codex backend is disposed");
    if (this.active.has(request.conversationId)) {
      throw new Error("A Codex request is already active for this conversation");
    }
    request.signal?.throwIfAborted();

    const existing = this.mappings.get(request.conversationId);
    const prompt = prepareCodexPrompt(
      request.prompt,
      request.attachments,
      this.systemPromptSupported ? undefined : this.options.instructions,
    );
    const common = [
      "--json",
      ...(this.options.instructions && this.systemPromptSupported
        ? ["-c", `developer_instructions=${JSON.stringify(this.options.instructions)}`]
        : []),
      "-c",
      'shell_environment_policy.inherit="none"',
      "--skip-git-repo-check",
      "--ignore-user-config",
      "--ignore-rules",
    ];
    const codexArguments = existing
      ? ["exec", "resume", ...common, "-c", 'sandbox_mode="read-only"', existing.threadId, "-"]
      : ["exec", ...common, "--sandbox", "read-only", "-"];
    mkdirSync(join(this.home, "tmp"), { recursive: true, mode: 0o700 });
    let threadId = existing?.threadId;
    let finalResponse = "";
    let providerError: string | undefined;
    try {
      const exit = await runSandboxedJsonl({
        profile: this.sandboxPath,
        executable: this.executable,
        arguments: codexArguments,
        cwd: this.workspace,
        env: codexProcessEnvironment(this.home),
        prompt,
        signal: request.signal,
        spawnProcess: this.spawnProcess,
        onSpawn: (process) => this.active.set(request.conversationId, { process }),
        malformedOutputError: () => new CodexOutputError("Codex emitted malformed JSONL output"),
        onEvent: (event) => {
          if (event.type === "thread.started" && typeof event.thread_id === "string") {
            threadId = event.thread_id;
            this.mappings.set(request.conversationId, {
              threadId,
              lastActiveAt: this.now(),
            });
            this.saveMappings();
          } else if (event.type === "item.started") {
            const item = event.item as Record<string, unknown> | undefined;
            if (item?.type === "command_execution") observer?.onToolUse();
          } else if (event.type === "item.completed") {
            const item = event.item as Record<string, unknown> | undefined;
            if (item?.type === "agent_message" && typeof item.text === "string") {
              finalResponse = item.text.trim();
            } else if (item?.type === "error" && typeof item.message === "string") {
              providerError = item.message;
            }
          } else if (event.type === "turn.failed" || event.type === "error") {
            const error = event.error as Record<string, unknown> | undefined;
            providerError =
              (typeof error?.message === "string" && error.message) ||
              (typeof event.message === "string" && event.message) ||
              "Codex provider request failed";
          }
        },
      });
      if (exit.stdinFailure) {
        throw new CodexOutputError(`Codex did not accept the prompt: ${exit.stdinFailure.message}`);
      }
      if (exit.code !== 0) {
        throw new CodexOutputError(
          `Codex exited unsuccessfully${exit.code == null ? "" : ` (code ${exit.code})`}` +
            (exit.stderrTail ? `: ${exit.stderrTail}` : ""),
        );
      }
      if (providerError) throw new CodexProviderError();
      if (!threadId) throw new CodexOutputError("Codex did not report a thread ID");
      if (!finalResponse) throw new CodexOutputError("Codex did not return a final response");
      this.mappings.set(request.conversationId, { threadId, lastActiveAt: this.now() });
      this.saveMappings();
      return finalResponse;
    } finally {
      this.active.delete(request.conversationId);
    }
  }

  sessionCommand(conversationId: string, command: SessionCommand): Promise<string> {
    if (command === "reset") {
      if (this.active.has(conversationId)) {
        return Promise.resolve("Cannot reset while a request is running. Cancel it first.");
      }
      const previous = this.mappings.get(conversationId);
      if (!previous) return Promise.resolve("No session exists for this conversation.");
      this.mappings.delete(conversationId);
      this.saveMappings();
      return Promise.resolve(
        `Session reset. Previous Codex history was retained; previous thread: ${previous.threadId.slice(0, 8)}.`,
      );
    }
    const mapping = this.mappings.get(conversationId);
    if (!mapping) return Promise.resolve("No session exists for this conversation.");
    return Promise.resolve(
      [
        `Session: ${mapping.threadId.slice(0, 8)}`,
        `State: ${this.active.has(conversationId) ? "running" : "inactive"}`,
        "Backend: Codex CLI",
        "Mode: read-only",
        `Last active: ${new Date(mapping.lastActiveAt).toISOString()}`,
        "Persisted: yes",
      ].join("\n"),
    );
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const { process } of this.active.values()) {
      process.kill("SIGTERM");
      const forceKill = setTimeout(() => process.kill("SIGKILL"), 5_000);
      forceKill.unref();
    }
  }

  private loadMappings(): void {
    for (const [conversationId, mapping] of this.store.load()) {
      this.mappings.set(conversationId, mapping);
    }
  }

  private saveMappings(): void {
    this.store.save(this.mappings);
  }
}
