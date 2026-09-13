import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
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
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type {
  AgentAttachment,
  AgentBackend,
  AgentRequest,
  AgentRunObserver,
  ConversationSummary,
  SessionCommand,
} from "./agent.ts";

const STORE_VERSION = 1;
const SANDBOX_PROFILE = "sandbox.sb";
const STORE_FILE = "conversations.json";

interface StoredConversation {
  threadId: string;
  lastActiveAt: number;
}

interface StoredMappings {
  version: 1;
  conversations: Record<string, StoredConversation>;
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
}

export class CodexCapabilityError extends Error {}
export class CodexOutputError extends Error {}
export class CodexProviderError extends Error {
  constructor() {
    super("The Codex provider request failed");
  }
}

function escapedSandboxLiteral(value: string): string {
  return JSON.stringify(value);
}

function escapedRegex(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");
}

/** Seatbelt boundary around Codex and every command it starts. */
export function codexSandboxProfile(
  workspace: string,
  codexHome: string,
  executable: string,
): string {
  const canonicalWorkspace = realpathSync(workspace);
  const canonicalExecutable = realpathSync(executable);
  const executableRoot = dirname(dirname(canonicalExecutable));
  const canonicalHome = realpathSync(codexHome);
  const workspacePattern = escapedRegex(canonicalWorkspace);
  const sensitive = `${workspacePattern}/(.*/)?(\\.git|\\.ssh)(/|$)|${workspacePattern}/(.*/)?(\\.env(\\..*)?|\\.netrc|\\.npmrc|\\.pypirc|id_(rsa|dsa|ecdsa|ed25519)|[^/]+\\.(key|pem|p12|pfx))$|${workspacePattern}/(.*/)?(\\.aws/credentials|gcloud/application_default_credentials\\.json|\\.docker/config\\.json)$`;
  const parent = dirname(canonicalWorkspace);
  const restrictedRoots = [
    parent,
    dirname(homedir()),
    "/private/tmp",
    "/private/var/folders",
    "/Volumes",
  ];
  const outsideReadDenials = [...new Set(restrictedRoots)].map(
    (root) =>
      `(deny file-read* (require-all (subpath ${escapedSandboxLiteral(root)}) (require-not (subpath ${escapedSandboxLiteral(canonicalWorkspace)})) (require-not (subpath ${escapedSandboxLiteral(canonicalHome)})) (require-not (subpath ${escapedSandboxLiteral(executableRoot)}))))`,
  );
  return [
    "(version 1)",
    "(deny default)",
    "(allow process*)",
    "(allow network*)",
    "(allow sysctl-read)",
    "(allow mach-lookup)",
    "(allow file-read*)",
    `(allow file-read* (subpath ${escapedSandboxLiteral(executableRoot)}))`,
    `(allow file-write* (subpath ${escapedSandboxLiteral(canonicalHome)}))`,
    `(deny file-read* file-write* (literal ${escapedSandboxLiteral(join(canonicalHome, "auth.json"))}))`,
    ...outsideReadDenials,
    '(allow file-read* file-write* (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random"))',
    `(deny file-read* file-write* (regex #"${sensitive}"))`,
    "",
  ].join("\n");
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

export function defaultCodexHome(workspace: string): string {
  const key = createHash("sha256").update(workspace).digest("hex").slice(0, 16);
  return join(homedir(), ".local", "state", "slack-desk-bot", "codex", key);
}

function findCodexExecutable(configured?: string): string {
  const executable =
    configured ?? execFileSync("/usr/bin/which", ["codex"], { encoding: "utf8" }).trim();
  if (!executable) throw new Error("Codex CLI is not installed or is not on PATH");
  return realpathSync(executable);
}

export class CodexBackend implements AgentBackend {
  private readonly executable: string;
  private readonly home: string;
  private readonly storePath: string;
  private readonly sandboxPath: string;
  private readonly mappings = new Map<string, StoredConversation>();
  private readonly active = new Map<string, ActiveRun>();
  private readonly now: () => number;
  private readonly spawnProcess: typeof spawn;
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
    this.storePath = join(this.home, STORE_FILE);
    this.sandboxPath = join(this.home, SANDBOX_PROFILE);
    this.now = options.now ?? Date.now;
    this.spawnProcess = options.spawnProcess ?? spawn;
    mkdirSync(this.home, { recursive: true, mode: 0o700 });
    chmodSync(this.home, 0o700);
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
      this.options.instructions,
    );
    const common = [
      "--json",
      "-c",
      'cli_auth_credentials_store="keyring"',
      "-c",
      'shell_environment_policy.inherit="none"',
      "--skip-git-repo-check",
      "--ignore-user-config",
      "--ignore-rules",
    ];
    const codexArguments = existing
      ? ["exec", "resume", ...common, "-c", 'sandbox_mode="read-only"', existing.threadId, "-"]
      : ["exec", ...common, "--sandbox", "read-only", "-"];
    const processArguments = ["-f", this.sandboxPath, this.executable, ...codexArguments];
    mkdirSync(join(this.home, "tmp"), { recursive: true, mode: 0o700 });
    const child = this.spawnProcess("/usr/bin/sandbox-exec", processArguments, {
      cwd: this.workspace,
      env: {
        CODEX_HOME: this.home,
        HOME: process.env.HOME,
        LANG: process.env.LANG,
        LC_ALL: process.env.LC_ALL,
        NO_PROXY: process.env.NO_PROXY,
        PATH: process.env.PATH,
        SSL_CERT_DIR: process.env.SSL_CERT_DIR,
        SSL_CERT_FILE: process.env.SSL_CERT_FILE,
        TMPDIR: join(this.home, "tmp"),
        http_proxy: process.env.http_proxy,
        https_proxy: process.env.https_proxy,
        no_proxy: process.env.no_proxy,
        HTTP_PROXY: process.env.HTTP_PROXY,
        HTTPS_PROXY: process.env.HTTPS_PROXY,
      },
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    this.active.set(request.conversationId, { process: child });

    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => {
      child.kill("SIGTERM");
      forceKillTimer ??= setTimeout(() => child.kill("SIGKILL"), 5_000);
      forceKillTimer.unref();
    };
    request.signal?.addEventListener("abort", abort, { once: true });
    child.stdin.end(prompt);

    let threadId = existing?.threadId;
    let finalResponse = "";
    let providerError: string | undefined;
    let parseError: Error | undefined;
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      if (!line.trim() || parseError) return;
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
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
      } catch {
        parseError = new CodexOutputError("Codex emitted malformed JSONL output");
        child.kill("SIGTERM");
      }
    });
    child.stderr.resume();

    try {
      const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolveExit, reject) => {
          child.once("error", reject);
          child.once("close", (code, signal) => resolveExit({ code, signal }));
        },
      );
      if (request.signal?.aborted) throw request.signal.reason;
      if (parseError) throw parseError;
      if (exit.code !== 0) {
        throw new CodexOutputError(
          `Codex exited unsuccessfully${exit.code == null ? "" : ` (code ${exit.code})`}`,
        );
      }
      if (providerError) throw new CodexProviderError();
      if (!threadId) throw new CodexOutputError("Codex did not report a thread ID");
      if (!finalResponse) throw new CodexOutputError("Codex did not return a final response");
      this.mappings.set(request.conversationId, { threadId, lastActiveAt: this.now() });
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
    if (!existsSync(this.storePath)) return;
    const stored = JSON.parse(readFileSync(this.storePath, "utf8")) as StoredMappings;
    if (stored.version !== STORE_VERSION || !stored.conversations) {
      throw new Error("Unsupported Codex conversation mapping format");
    }
    for (const [conversationId, mapping] of Object.entries(stored.conversations)) {
      if (typeof mapping.threadId === "string" && Number.isFinite(mapping.lastActiveAt)) {
        this.mappings.set(conversationId, mapping);
      }
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
