import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { seatbeltProfile } from "./seatbelt.ts";
import type {
  AgentAttachment,
  AgentBackend,
  AgentRequest,
  AgentRunObserver,
  ConversationSummary,
  SessionCommand,
} from "./agent.ts";
import type { AgentMode } from "./config.ts";

const STORE_VERSION = 1;
const STORE_FILE = "conversations.json";
const SETTINGS_FILE = "settings.json";
const SANDBOX_PROFILE = "sandbox.sb";

interface StoredConversation {
  sessionId: string;
  lastActiveAt: number;
}
interface StoredMappings {
  version: 1;
  conversations: Record<string, StoredConversation>;
}
interface ActiveRun {
  process: ChildProcessWithoutNullStreams;
}

export interface ClaudeBackendOptions {
  executable?: string;
  home?: string;
  instructions?: string;
  mode?: AgentMode;
  now?: () => number;
  spawnProcess?: typeof spawn;
  platform?: NodeJS.Platform;
}

export class ClaudeCapabilityError extends Error {}
export class ClaudeOutputError extends Error {}
export class ClaudeProviderError extends Error {
  constructor() {
    super("The Claude provider request failed");
  }
}

/**
 * Claude Code keeps interrupt sockets and lock state under fixed `/tmp` paths,
 * so those two directories are writable in addition to the backend home.
 */
function claudeRuntimePaths(): string[] {
  const uid = process.getuid?.() ?? 0;
  return [`/private/tmp/claude-${uid}`, "/private/tmp/cc-socks"];
}

/** Independent Seatbelt boundary for Claude and every tool process it starts. */
export function claudeSandboxProfile(
  workspace: string,
  claudeHome: string,
  executable: string,
  mode: AgentMode = "read-only",
): string {
  return seatbeltProfile({
    workspace,
    home: claudeHome,
    executable,
    allowWorkspaceWrite: mode === "read-write",
    extraWritePaths: claudeRuntimePaths(),
  });
}

export function prepareClaudePrompt(
  prompt: string,
  attachments: readonly AgentAttachment[] = [],
  instructions?: string,
): string {
  if (attachments.some((attachment) => attachment.kind === "image")) {
    throw new ClaudeCapabilityError(
      "The Claude backend does not support image attachments without writing them to disk.",
    );
  }
  const files = attachments
    .filter((attachment) => attachment.kind === "text")
    .map((attachment) =>
      [
        `<slack-file name=${JSON.stringify(attachment.name)} media-type=${JSON.stringify(attachment.mediaType)}>`,
        attachment.text,
        "</slack-file>",
      ].join("\n"),
    );
  return (
    [instructions?.trim(), prompt.trim(), ...files].filter(Boolean).join("\n\n") ||
    "Respond to the Slack message."
  );
}

export function defaultClaudeHome(workspace: string): string {
  const key = createHash("sha256").update(workspace).digest("hex").slice(0, 16);
  return join(homedir(), "Library", "Application Support", "SlackDeskBot", "claude", key);
}

function findClaudeExecutable(configured?: string): string {
  const executable =
    configured ?? execFileSync("/usr/bin/which", ["claude"], { encoding: "utf8" }).trim();
  if (!executable) throw new Error("Claude Code CLI is not installed or is not on PATH");
  return realpathSync(executable);
}

function claudeTools(mode: AgentMode): string[] {
  return mode === "read-write"
    ? ["Read", "Glob", "Grep", "Edit", "Write"]
    : ["Read", "Glob", "Grep"];
}

function claudeSettings(mode: AgentMode): string {
  const tools = claudeTools(mode);
  return `${JSON.stringify(
    {
      permissions: {
        deny: [
          "Bash",
          "WebFetch",
          "WebSearch",
          "NotebookEdit",
          "Read(.env)",
          "Read(.env.*)",
          "Read(.git/**)",
          "Read(~/.ssh/**)",
          "Read(~/.aws/**)",
          "Read(**/*.pem)",
          "Read(**/*.key)",
        ],
        allow: tools,
      },
    },
    null,
    2,
  )}\n`;
}

export class ClaudeBackend implements AgentBackend {
  private readonly executable: string;
  private readonly home: string;
  private readonly mode: AgentMode;
  private readonly storePath: string;
  private readonly sandboxPath: string;
  private readonly settingsPath: string;
  private readonly mappings = new Map<string, StoredConversation>();
  private readonly active = new Map<string, ActiveRun>();
  private readonly now: () => number;
  private readonly spawnProcess: typeof spawn;
  private disposed = false;

  constructor(
    private readonly workspace: string,
    private readonly options: ClaudeBackendOptions = {},
  ) {
    if ((options.platform ?? process.platform) !== "darwin") {
      throw new Error("The Claude Code backend currently requires macOS Seatbelt sandboxing");
    }
    this.executable = findClaudeExecutable(options.executable);
    this.home = resolve(options.home ?? defaultClaudeHome(workspace));
    this.mode = options.mode ?? "read-only";
    this.storePath = join(this.home, STORE_FILE);
    this.sandboxPath = join(this.home, SANDBOX_PROFILE);
    this.settingsPath = join(this.home, SETTINGS_FILE);
    this.now = options.now ?? Date.now;
    this.spawnProcess = options.spawnProcess ?? spawn;
    mkdirSync(this.home, { recursive: true, mode: 0o700 });
    chmodSync(this.home, 0o700);
    writeFileSync(this.settingsPath, claudeSettings(this.mode), { mode: 0o600 });
    writeFileSync(
      this.sandboxPath,
      claudeSandboxProfile(workspace, this.home, this.executable, this.mode),
      { mode: 0o600 },
    );
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
          sessionId: mapping.sessionId,
          state: this.active.has(conversationId) ? ("running" as const) : ("inactive" as const),
          lastActiveAt: mapping.lastActiveAt,
        }))
        .sort((a, b) => b.lastActiveAt - a.lastActiveAt),
    );
  }

  async run(request: AgentRequest, observer?: AgentRunObserver): Promise<string> {
    if (this.disposed) throw new Error("Claude backend is disposed");
    if (this.active.has(request.conversationId))
      throw new Error("A Claude request is already active for this conversation");
    request.signal?.throwIfAborted();
    const existing = this.mappings.get(request.conversationId);
    const prompt = prepareClaudePrompt(
      request.prompt,
      request.attachments,
      this.options.instructions,
    );
    const generatedSessionId = existing?.sessionId ?? randomUUID();
    const claudeArguments = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "dontAsk",
      "--restricted",
      "--strict-mcp-config",
      "--disable-slash-commands",
      "--settings",
      this.settingsPath,
      "--tools",
      claudeTools(this.mode).join(","),
      ...(existing ? ["--resume", existing.sessionId] : ["--session-id", generatedSessionId]),
    ];
    mkdirSync(join(this.home, "tmp"), { recursive: true, mode: 0o700 });
    const child = this.spawnProcess(
      "/usr/bin/sandbox-exec",
      ["-f", this.sandboxPath, this.executable, ...claudeArguments],
      {
        cwd: this.workspace,
        env: {
          CLAUDE_CONFIG_DIR: this.home,
          HOME: this.home,
          LANG: process.env.LANG,
          LC_ALL: process.env.LC_ALL,
          PATH: process.env.PATH,
          TMPDIR: join(this.home, "tmp"),
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    ) as ChildProcessWithoutNullStreams;
    this.active.set(request.conversationId, { process: child });
    child.stdin.end(prompt);
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => {
      child.kill("SIGTERM");
      forceKillTimer ??= setTimeout(() => child.kill("SIGKILL"), 5_000);
      forceKillTimer.unref();
    };
    request.signal?.addEventListener("abort", abort, { once: true });
    let sessionId: string | undefined = existing?.sessionId;
    let finalResponse = "";
    let providerError = false;
    let parseError: Error | undefined;
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      if (!line.trim() || parseError) return;
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        if (typeof event.session_id === "string") sessionId = event.session_id;
        if (event.type === "assistant") {
          const message = event.message as Record<string, unknown> | undefined;
          const content = Array.isArray(message?.content) ? message.content : [];
          for (const block of content) {
            if (
              block &&
              typeof block === "object" &&
              (block as Record<string, unknown>).type === "tool_use"
            )
              observer?.onToolUse();
            if (
              block &&
              typeof block === "object" &&
              (block as Record<string, unknown>).type === "text" &&
              typeof (block as Record<string, unknown>).text === "string"
            )
              finalResponse = String((block as Record<string, unknown>).text).trim();
          }
        } else if (event.type === "result") {
          if (
            event.is_error === true ||
            (typeof event.subtype === "string" && event.subtype !== "success")
          )
            providerError = true;
          if (typeof event.result === "string" && !providerError)
            finalResponse = event.result.trim();
        }
      } catch {
        parseError = new ClaudeOutputError("Claude Code emitted malformed JSONL output");
        child.kill("SIGTERM");
      }
    });
    let stderrTail = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderrTail = `${stderrTail}${chunk}`.slice(-500);
    });
    try {
      const exit = await new Promise<{ code: number | null }>((resolveExit, reject) => {
        child.once("error", reject);
        child.once("close", (code) => resolveExit({ code }));
      });
      if (request.signal?.aborted) throw request.signal.reason;
      if (parseError) throw parseError;
      if (exit.code !== 0)
        throw new ClaudeOutputError(
          `Claude Code exited unsuccessfully${exit.code == null ? "" : ` (code ${exit.code})`}` +
            (stderrTail.trim() ? `: ${stderrTail.trim()}` : ""),
        );
      if (providerError) throw new ClaudeProviderError();
      if (!sessionId) throw new ClaudeOutputError("Claude Code did not report a session ID");
      if (!finalResponse)
        throw new ClaudeOutputError("Claude Code did not return a final response");
      this.mappings.set(request.conversationId, { sessionId, lastActiveAt: this.now() });
      this.saveMappings();
      return finalResponse;
    } finally {
      request.signal?.removeEventListener("abort", abort);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      lines.close();
      this.active.delete(request.conversationId);
    }
  }

  sessionCommand(conversationId: string, command: SessionCommand): Promise<string> {
    if (command === "reset") {
      if (this.active.has(conversationId))
        return Promise.resolve("Cannot reset while a request is running. Cancel it first.");
      const previous = this.mappings.get(conversationId);
      if (!previous) return Promise.resolve("No session exists for this conversation.");
      this.mappings.delete(conversationId);
      this.saveMappings();
      return Promise.resolve(
        `Session reset. Previous Claude history was retained; previous session: ${previous.sessionId.slice(0, 8)}.`,
      );
    }
    const mapping = this.mappings.get(conversationId);
    if (!mapping) return Promise.resolve("No session exists for this conversation.");
    return Promise.resolve(
      [
        `Session: ${mapping.sessionId.slice(0, 8)}`,
        `State: ${this.active.has(conversationId) ? "running" : "inactive"}`,
        "Backend: Claude Code CLI",
        `Mode: ${this.mode}`,
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
    if (!existsSync(this.storePath)) return;
    const stored = JSON.parse(readFileSync(this.storePath, "utf8")) as StoredMappings;
    if (stored.version !== STORE_VERSION || !stored.conversations)
      throw new Error("Unsupported Claude conversation mapping format");
    for (const [conversationId, mapping] of Object.entries(stored.conversations)) {
      if (typeof mapping.sessionId === "string" && Number.isFinite(mapping.lastActiveAt))
        this.mappings.set(conversationId, mapping);
    }
  }
  private saveMappings(): void {
    const contents: StoredMappings = {
      version: STORE_VERSION,
      conversations: Object.fromEntries(this.mappings),
    };
    const temporary = `${this.storePath}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(contents, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.storePath);
  }
}
