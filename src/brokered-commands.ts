import { spawn } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import {
  formatSize,
  generateUnifiedPatch,
  truncateHead,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { isPathInWorkspace, isSensitiveWorkspacePath } from "./workspace-policy.ts";

const COMMAND_TIMEOUT_MS = 10_000;
const MAX_CAPTURE_BYTES = 1024 * 1024;
const FORCE_KILL_DELAY_MS = 1_000;
const GIT = "/usr/bin/git";

const GIT_ACTIONS = [
  "overview",
  "status",
  "branches",
  "tags",
  "log",
  "diff",
  "show_file",
  "blame",
  "file_history",
  "contributors",
  "hotspots",
  "stats",
] as const;

const SYSTEM_ACTIONS = [
  "battery",
  "uptime",
  "os_version",
  "disk_space",
  "memory_pressure",
  "thermal_pressure",
  "computer_name",
  "clock",
  "kernel",
] as const;

type GitAction = (typeof GIT_ACTIONS)[number];
type SystemAction = (typeof SYSTEM_ACTIONS)[number];

export interface GitInspectInput {
  action: GitAction;
  repository?: string;
  path?: string;
  revision?: string;
  startLine?: number;
  endLine?: number;
  limit?: number;
  days?: number;
  staged?: boolean;
}

export interface SystemInfoInput {
  action: SystemAction;
}

export interface BrokeredCommandSpec {
  executable: string;
  arguments: string[];
  cwd: string;
  timeoutMs?: number;
}

export interface BrokeredCommandResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
}

export type BrokeredCommandExecutor = (
  spec: BrokeredCommandSpec,
  signal?: AbortSignal,
) => Promise<BrokeredCommandResult>;

function commandEnvironment(): NodeJS.ProcessEnv {
  return {
    HOME: "/var/empty",
    LANG: "C",
    LC_ALL: "C",
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    TMPDIR: "/tmp",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
  };
}

/** Execute one fixed executable with argv; shell parsing and inherited credentials are never used. */
export function executeBrokeredCommand(
  spec: BrokeredCommandSpec,
  signal?: AbortSignal,
): Promise<BrokeredCommandResult> {
  return new Promise((resolveCommand, rejectCommand) => {
    signal?.throwIfAborted();
    const child = spawn(spec.executable, spec.arguments, {
      cwd: spec.cwd,
      env: commandEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let outputExceeded = false;
    let timedOut = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;

    const append = (
      current: Buffer<ArrayBufferLike>,
      chunk: Buffer<ArrayBufferLike>,
    ): Buffer<ArrayBufferLike> => {
      const remaining = MAX_CAPTURE_BYTES - current.length;
      if (remaining <= 0) {
        outputExceeded = true;
        child.kill("SIGKILL");
        return current;
      }
      if (chunk.length > remaining) {
        outputExceeded = true;
        child.kill("SIGKILL");
      }
      return Buffer.concat([current, chunk.subarray(0, remaining)]);
    };
    child.stdout.on("data", (chunk: Buffer<ArrayBufferLike>) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer<ArrayBufferLike>) => {
      stderr = append(stderr, chunk);
    });

    const stop = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      forceKillTimer ??= setTimeout(() => child.kill("SIGKILL"), FORCE_KILL_DELAY_MS);
      forceKillTimer.unref();
    };
    const abort = () => stop();
    signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      stop();
    }, spec.timeoutMs ?? COMMAND_TIMEOUT_MS);
    timeout.unref();

    child.once("error", rejectCommand);
    child.once("close", (code, exitSignal) => {
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) {
        rejectCommand(new Error("Brokered command was cancelled"));
        return;
      }
      if (timedOut) {
        rejectCommand(new Error("Brokered command timed out"));
        return;
      }
      if (outputExceeded) {
        rejectCommand(
          new Error(`Brokered command exceeded the ${formatSize(MAX_CAPTURE_BYTES)} capture limit`),
        );
        return;
      }
      resolveCommand({
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        code,
        signal: exitSignal,
      });
    });
  });
}

const BASE_GIT_ARGUMENTS = [
  "-c",
  "color.ui=false",
  "-c",
  "core.pager=cat",
  "-c",
  "pager.branch=false",
  "-c",
  "pager.log=false",
  "-c",
  "pager.diff=false",
  "-c",
  "diff.external=",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "credential.helper=",
  "-c",
  "mailmap.file=/dev/null",
  "-c",
  "mailmap.blob=",
] as const;

async function rawGit(
  workspace: string,
  arguments_: readonly string[],
  signal: AbortSignal | undefined,
  execute: BrokeredCommandExecutor,
): Promise<BrokeredCommandResult> {
  return execute(
    {
      executable: GIT,
      arguments: [...BASE_GIT_ARGUMENTS, "-C", realpathSync(workspace), ...arguments_],
      cwd: workspace,
    },
    signal,
  );
}

async function git(
  workspace: string,
  arguments_: readonly string[],
  signal: AbortSignal | undefined,
  execute: BrokeredCommandExecutor,
): Promise<string> {
  const result = await rawGit(workspace, arguments_, signal, execute);
  if (result.code !== 0) {
    const detail =
      result.stderr.trim() || result.stdout.trim() || `git exited with code ${result.code}`;
    throw new Error(detail);
  }
  return result.stdout;
}

async function requireRepositoryRoot(
  repositoryPath: string | undefined,
  workspace: string,
  signal: AbortSignal | undefined,
  execute: BrokeredCommandExecutor,
): Promise<string> {
  const selected = repositoryPath?.trim() || ".";
  if (isAbsolute(selected)) {
    throw new Error("repository must be relative to the configured workspace");
  }
  const candidate = resolve(realpathSync(workspace), selected);
  if (!isPathInWorkspace(candidate, workspace)) {
    throw new Error("repository must identify a directory inside the configured workspace");
  }
  if (isSensitiveWorkspacePath(candidate, workspace)) {
    throw new Error("access to sensitive workspace paths is blocked");
  }
  if (!statSync(candidate, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error("repository must identify an existing directory");
  }

  const repository = realpathSync(candidate);
  const root = (await git(repository, ["rev-parse", "--show-toplevel"], signal, execute)).trim();
  if (!root || realpathSync(root) !== repository) {
    throw new Error(
      "repository must identify a Git repository root; refusing to inspect an enclosing repository",
    );
  }
  return repository;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < minimum || selected > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return selected;
}

function repositoryPath(path: string | undefined, repository: string, workspace: string): string {
  if (!path?.trim()) throw new Error("path is required for this git action");
  let normalized = path.trim().replace(/^@/, "");
  if (isAbsolute(normalized)) throw new Error("path must be relative to the selected repository");
  normalized = relative(repository, resolve(repository, normalized));
  if (!normalized || normalized.startsWith("..") || isAbsolute(normalized)) {
    throw new Error("path must identify a file inside the selected repository");
  }
  const absolute = resolve(repository, normalized);
  if (!isPathInWorkspace(absolute, repository)) {
    throw new Error("path resolves outside the selected repository");
  }
  if (isSensitiveWorkspacePath(absolute, workspace)) {
    throw new Error("access to sensitive workspace paths is blocked");
  }
  return normalized.replaceAll("\\", "/");
}

function literalPathspec(path: string): string {
  return `:(top,literal)${path}`;
}

function revision(value: string | undefined): string {
  const selected = value?.trim() || "HEAD";
  if (!/^[A-Za-z0-9][A-Za-z0-9._/@{}^~/-]{0,127}$/.test(selected) || selected.includes("..")) {
    throw new Error("revision must be a simple commit ID or ref name");
  }
  return selected;
}

function present(output: string): string {
  const normalized = output.trimEnd();
  const truncation = truncateHead(normalized || "(no output)");
  if (!truncation.truncated) return truncation.content;
  return `${truncation.content}\n\n[Output truncated to ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).]`;
}

function isSensitiveGitPath(path: string, repository: string, workspace: string): boolean {
  return isSensitiveWorkspacePath(resolve(repository, path), workspace);
}

function formatStatus(output: string, repository: string, workspace: string): string {
  const records = output.split("\0").filter(Boolean);
  const visible: string[] = [];
  for (let index = 0; index < records.length; index++) {
    const record = records[index]!;
    if (record.startsWith("## ")) {
      visible.push(record);
      continue;
    }
    const status = record.slice(0, 2);
    const path = record.slice(3);
    const renamed = status.includes("R") || status.includes("C") ? records[++index] : undefined;
    if (
      isSensitiveGitPath(path, repository, workspace) ||
      (renamed && isSensitiveGitPath(renamed, repository, workspace))
    ) {
      continue;
    }
    visible.push(`${status} ${renamed ? `${renamed} -> ${path}` : path}`);
  }
  return visible.join("\n") || "Working tree clean (sensitive paths, if any, are omitted).";
}

function formatStats(output: string, repository: string, workspace: string): string {
  const files = output
    .split("\0")
    .filter((path) => path && !isSensitiveGitPath(path, repository, workspace));
  const extensions = new Map<string, number>();
  for (const path of files) {
    const name = path.split("/").at(-1) ?? path;
    const match = /(?:^|\.)([^.]+)$/.exec(name);
    const extension =
      name.includes(".") && match ? `.${match[1]!.toLowerCase()}` : "(no extension)";
    extensions.set(extension, (extensions.get(extension) ?? 0) + 1);
  }
  const top = [...extensions.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 12)
    .map(([extension, count]) => `- ${extension}: ${count}`);
  return [`Tracked files: ${files.length}`, "Top file types:", ...top].join("\n");
}

async function gitObjectContents(
  object: string,
  workspace: string,
  signal: AbortSignal | undefined,
  execute: BrokeredCommandExecutor,
): Promise<string> {
  const exists = await rawGit(workspace, ["cat-file", "-e", object], signal, execute);
  if (exists.code !== 0) return "";
  return git(workspace, ["show", "--no-ext-diff", "--no-textconv", object], signal, execute);
}

function workingTreeContents(path: string, repository: string): string {
  const absolute = resolve(repository, path);
  const stat = statSync(absolute, { throwIfNoEntry: false });
  if (!stat) return "";
  if (!stat.isFile()) throw new Error("diff path must identify a regular file");
  if (stat.size > MAX_CAPTURE_BYTES) {
    throw new Error(`diff input exceeds the ${formatSize(MAX_CAPTURE_BYTES)} limit`);
  }
  const contents = readFileSync(absolute);
  if (contents.includes(0)) throw new Error("binary file diffs are not supported");
  return contents.toString("utf8");
}

function formatHotspots(
  output: string,
  repository: string,
  workspace: string,
  limit: number,
  days: number,
): string {
  const counts = new Map<string, number>();
  for (const path of output.split("\n")) {
    if (!path || isSensitiveGitPath(path, repository, workspace)) continue;
    counts.set(path, (counts.get(path) ?? 0) + 1);
  }
  const rows = [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(
      ([path, count], index) => `${index + 1}. ${path} — ${count} commit${count === 1 ? "" : "s"}`,
    );
  return rows.length
    ? `Most frequently changed files in the last ${days} days:\n${rows.join("\n")}`
    : `No file changes found in the last ${days} days.`;
}

export async function runGitInspection(
  input: GitInspectInput,
  workspace: string,
  signal?: AbortSignal,
  execute: BrokeredCommandExecutor = executeBrokeredCommand,
): Promise<string> {
  const repository = await requireRepositoryRoot(input.repository, workspace, signal, execute);
  const limit = boundedInteger(input.limit, 20, 1, 100, "limit");
  switch (input.action) {
    case "overview": {
      const [branch, commitCount, latest, status] = await Promise.all([
        git(repository, ["branch", "--show-current"], signal, execute),
        git(repository, ["rev-list", "--count", "HEAD"], signal, execute),
        git(repository, ["log", "-1", "--date=short", "--format=%h %ad %an — %s"], signal, execute),
        git(
          repository,
          ["status", "--porcelain=v1", "--branch", "--ignore-submodules=all", "-z"],
          signal,
          execute,
        ),
      ]);
      return present(
        [
          `Branch: ${branch.trim() || "(detached)"}`,
          `Commits: ${commitCount.trim()}`,
          `Latest: ${latest.trim()}`,
          "Status:",
          formatStatus(status, repository, workspace),
        ].join("\n"),
      );
    }
    case "status":
      return present(
        formatStatus(
          await git(
            repository,
            ["status", "--porcelain=v1", "--branch", "--ignore-submodules=all", "-z"],
            signal,
            execute,
          ),
          repository,
          workspace,
        ),
      );
    case "branches":
      return present(
        await git(
          repository,
          [
            "branch",
            "--sort=-committerdate",
            `--format=%(if)%(HEAD)%(then)* %(else)  %(end)%(refname:short)  %(objectname:short)  %(subject)`,
          ],
          signal,
          execute,
        ),
      );
    case "tags":
      return present(
        await git(
          repository,
          [
            "tag",
            "--sort=-creatordate",
            "--format=%(refname:short)  %(creatordate:short)  %(subject)",
          ],
          signal,
          execute,
        ),
      );
    case "log":
      return present(
        await git(
          repository,
          ["log", `-${limit}`, "--date=short", "--format=%h %ad %an — %s"],
          signal,
          execute,
        ),
      );
    case "diff": {
      const path = repositoryPath(input.path, repository, workspace);
      const current = input.staged
        ? await gitObjectContents(`:${path}`, repository, signal, execute)
        : workingTreeContents(path, repository);
      const base = await gitObjectContents(
        input.staged ? `HEAD:${path}` : `:${path}`,
        repository,
        signal,
        execute,
      );
      if (base === current) return "(no differences)";
      return present(generateUnifiedPatch(path, base, current));
    }
    case "show_file": {
      const path = repositoryPath(input.path, repository, workspace);
      return present(
        await git(
          repository,
          ["show", "--no-ext-diff", "--no-textconv", `${revision(input.revision)}:${path}`],
          signal,
          execute,
        ),
      );
    }
    case "blame": {
      const path = repositoryPath(input.path, repository, workspace);
      const start = input.startLine;
      const end = input.endLine;
      if ((start === undefined) !== (end === undefined)) {
        throw new Error("startLine and endLine must be provided together");
      }
      const range =
        start === undefined
          ? []
          : [
              "-L",
              `${boundedInteger(start, 1, 1, 1_000_000, "startLine")},${boundedInteger(end, start, start, 1_000_000, "endLine")}`,
            ];
      return present(
        await git(
          repository,
          ["blame", "--no-textconv", ...range, revision(input.revision), "--", path],
          signal,
          execute,
        ),
      );
    }
    case "file_history": {
      const path = repositoryPath(input.path, repository, workspace);
      return present(
        await git(
          repository,
          [
            "log",
            `-${limit}`,
            "--follow",
            "--date=short",
            "--format=%h %ad %an — %s",
            "--",
            literalPathspec(path),
          ],
          signal,
          execute,
        ),
      );
    }
    case "contributors":
      return present(await git(repository, ["shortlog", "-sn", "--all"], signal, execute));
    case "hotspots": {
      const days = boundedInteger(input.days, 30, 1, 365, "days");
      const output = await git(
        repository,
        ["log", `--since=${days}.days`, "--format=", "--name-only", "--no-renames"],
        signal,
        execute,
      );
      return present(formatHotspots(output, repository, workspace, limit, days));
    }
    case "stats":
      return present(
        formatStats(
          await git(repository, ["ls-files", "-z"], signal, execute),
          repository,
          workspace,
        ),
      );
  }
}

const SYSTEM_COMMANDS: Record<SystemAction, { executable: string; arguments: string[] }> = {
  battery: { executable: "/usr/bin/pmset", arguments: ["-g", "batt"] },
  uptime: { executable: "/usr/bin/uptime", arguments: [] },
  os_version: { executable: "/usr/bin/sw_vers", arguments: [] },
  disk_space: { executable: "/bin/df", arguments: ["-h"] },
  memory_pressure: { executable: "/usr/bin/memory_pressure", arguments: [] },
  thermal_pressure: { executable: "/usr/bin/pmset", arguments: ["-g", "therm"] },
  computer_name: { executable: "/usr/sbin/scutil", arguments: ["--get", "ComputerName"] },
  clock: { executable: "/bin/date", arguments: ["+%A, %B %d, %Y at %H:%M:%S %Z"] },
  kernel: { executable: "/usr/bin/uname", arguments: ["-mrs"] },
};

export async function runSystemInfo(
  input: SystemInfoInput,
  workspace: string,
  signal?: AbortSignal,
  execute: BrokeredCommandExecutor = executeBrokeredCommand,
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  if (platform !== "darwin") throw new Error("system_info is supported only on macOS");
  const selected = SYSTEM_COMMANDS[input.action];
  const arguments_ = [
    ...selected.arguments,
    ...(input.action === "disk_space" ? [realpathSync(workspace)] : []),
  ];
  const result = await execute(
    {
      executable: selected.executable,
      arguments: arguments_,
      cwd: workspace,
    },
    signal,
  );
  if (result.code !== 0) {
    const detail =
      result.stderr.trim() ||
      result.stdout.trim() ||
      `${input.action} exited with code ${result.code}`;
    throw new Error(detail);
  }
  return present(result.stdout);
}

export interface BrokeredToolsOptions {
  execute?: BrokeredCommandExecutor;
  platform?: NodeJS.Platform;
}

/** Service-owned, non-shell tools whose actions map to fixed executables and validated argv. */
export function brokeredTools(
  workspace: string,
  options: BrokeredToolsOptions = {},
): InlineExtension {
  const execute = options.execute ?? executeBrokeredCommand;
  return {
    name: "slack-brokered-tools",
    factory: (pi) => {
      pi.registerTool({
        name: "git_inspect",
        label: "Git Inspect",
        description:
          "Safely inspect repository history and state without a shell. Actions: overview, status, branches, tags, log, diff, show_file, blame, file_history, contributors, hotspots, and stats. repository selects a Git root within the workspace and defaults to the workspace itself. diff/show_file/blame/file_history require a repository-relative path. Output is bounded to 50KB/2000 lines and sensitive paths are blocked.",
        promptSnippet:
          "Inspect Git status, history, blame, diffs, contributors, hotspots, and repository stats",
        promptGuidelines: [
          "Use git_inspect instead of guessing about repository history, authorship, or current Git state.",
          "When the workspace contains multiple projects, set repository to the workspace-relative Git root named by the user or file path.",
          "Use git_inspect only for inspection; it cannot mutate the repository, contact remotes, or run hooks.",
        ],
        parameters: Type.Object({
          action: StringEnum(GIT_ACTIONS, { description: "Safe Git inspection operation" }),
          repository: Type.Optional(
            Type.String({
              description:
                "Workspace-relative Git repository root; defaults to the configured workspace",
            }),
          ),
          path: Type.Optional(
            Type.String({
              description: "Repository-relative literal file path for path-based actions",
            }),
          ),
          revision: Type.Optional(
            Type.String({ description: "Simple commit ID or ref; defaults to HEAD" }),
          ),
          startLine: Type.Optional(
            Type.Integer({ minimum: 1, maximum: 1_000_000, description: "First blame line" }),
          ),
          endLine: Type.Optional(
            Type.Integer({ minimum: 1, maximum: 1_000_000, description: "Last blame line" }),
          ),
          limit: Type.Optional(
            Type.Integer({
              minimum: 1,
              maximum: 100,
              description: "Maximum log or ranking entries",
            }),
          ),
          days: Type.Optional(
            Type.Integer({ minimum: 1, maximum: 365, description: "Hotspot lookback window" }),
          ),
          staged: Type.Optional(Type.Boolean({ description: "Inspect the staged diff" })),
        }),
        async execute(_toolCallId, params, signal) {
          return {
            content: [
              { type: "text", text: await runGitInspection(params, workspace, signal, execute) },
            ],
            details: { action: params.action },
          };
        },
      });

      pi.registerTool({
        name: "system_info",
        label: "System Info",
        description:
          "Read benign macOS host facts through fixed commands without a shell. Actions report battery, uptime/load, OS version, workspace disk space, memory pressure, thermal pressure, computer name, local clock, or kernel version. No arbitrary command or arguments are accepted.",
        promptSnippet:
          "Check macOS battery, uptime, memory, thermal state, disk space, clock, and version details",
        promptGuidelines: [
          "Use system_info when the user asks about the desktop host's health, battery, clock, or OS details.",
        ],
        parameters: Type.Object({
          action: StringEnum(SYSTEM_ACTIONS, {
            description: "Benign host information to retrieve",
          }),
        }),
        async execute(_toolCallId, params, signal) {
          return {
            content: [
              {
                type: "text",
                text: await runSystemInfo(params, workspace, signal, execute, options.platform),
              },
            ],
            details: { action: params.action },
          };
        },
      });
    },
  };
}
