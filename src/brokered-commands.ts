import { spawn } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
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
const MAX_ANALYSIS_FILES = 20_000;
const MAX_COUPLING_COMMITS = 500;
const MAX_COUPLING_FILES_PER_COMMIT = 50;
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
  "commit_details",
  "search_commits",
  "branch_divergence",
  "release_notes",
  "activity_calendar",
  "code_age",
  "file_ownership",
  "bus_factor",
  "stale_branches",
  "largest_files",
  "oldest_files",
  "change_coupling",
  "commit_streaks",
  "repo_health",
  "contributor_trivia",
] as const;

const REPO_FUN_ACTIONS = [
  "personality",
  "birthday",
  "ancient_artifacts",
  "hot_zone",
  "team_constellation",
  "commit_weather",
  "fortune",
  "activity_sparkline",
  "milestones",
  "trivia",
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
  "battery_health",
  "cpu_summary",
  "memory_summary",
  "volume_summary",
  "power_settings",
  "developer_tools",
  "runtime_versions",
  "display_summary",
  "system_pressure",
  "service_health",
] as const;

type GitAction = (typeof GIT_ACTIONS)[number];
type RepoFunAction = (typeof REPO_FUN_ACTIONS)[number];
type SystemAction = (typeof SYSTEM_ACTIONS)[number];

export interface GitInspectInput {
  action: GitAction;
  repository?: string;
  path?: string;
  revision?: string;
  baseRevision?: string;
  headRevision?: string;
  query?: string;
  startLine?: number;
  endLine?: number;
  limit?: number;
  days?: number;
  staged?: boolean;
}

export interface RepoFunInput {
  action: RepoFunAction;
  repository?: string;
  days?: number;
  limit?: number;
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
  repository: string,
  arguments_: readonly string[],
  signal: AbortSignal | undefined,
  execute: BrokeredCommandExecutor,
): Promise<BrokeredCommandResult> {
  return execute(
    {
      executable: GIT,
      arguments: [...BASE_GIT_ARGUMENTS, "-C", realpathSync(repository), ...arguments_],
      cwd: repository,
    },
    signal,
  );
}

async function git(
  repository: string,
  arguments_: readonly string[],
  signal: AbortSignal | undefined,
  execute: BrokeredCommandExecutor,
): Promise<string> {
  const result = await rawGit(repository, arguments_, signal, execute);
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

function formatChangedFiles(output: string, repository: string, workspace: string): string {
  const records = output.split("\0").filter(Boolean);
  const visible: string[] = [];
  for (let index = 0; index < records.length;) {
    const status = records[index++] ?? "?";
    const first = records[index++];
    const second = status.startsWith("R") || status.startsWith("C") ? records[index++] : undefined;
    if (
      !first ||
      isSensitiveGitPath(first, repository, workspace) ||
      (second && isSensitiveGitPath(second, repository, workspace))
    ) {
      continue;
    }
    visible.push(`${status}\t${second ? `${first} -> ${second}` : first}`);
  }
  return visible.join("\n") || "(none visible)";
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
  repository: string,
  signal: AbortSignal | undefined,
  execute: BrokeredCommandExecutor,
): Promise<string> {
  const exists = await rawGit(repository, ["cat-file", "-e", object], signal, execute);
  if (exists.code !== 0) return "";
  return git(repository, ["show", "--no-ext-diff", "--no-textconv", object], signal, execute);
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

interface HistoryCommit {
  hash: string;
  timestamp: number;
  author: string;
  paths: string[];
}

function fixedText(value: string | undefined, name: string, maximum = 200): string {
  const selected = value?.trim();
  if (!selected) throw new Error(`${name} is required for this action`);
  if (selected.length > maximum || /[\0\r\n]/.test(selected)) {
    throw new Error(`${name} must be a single line of at most ${maximum} characters`);
  }
  return selected;
}

async function trackedFiles(
  repository: string,
  workspace: string,
  signal: AbortSignal | undefined,
  execute: BrokeredCommandExecutor,
): Promise<string[]> {
  const output = await git(repository, ["ls-files", "-z"], signal, execute);
  const files = output
    .split("\0")
    .filter(
      (path) =>
        path &&
        !isSensitiveGitPath(path, repository, workspace) &&
        isPathInWorkspace(resolve(repository, path), repository),
    );
  if (files.length > MAX_ANALYSIS_FILES) {
    throw new Error(`Repository exceeds the ${MAX_ANALYSIS_FILES}-file insight analysis limit`);
  }
  return files;
}

async function historyCommits(
  repository: string,
  workspace: string,
  days: number | undefined,
  signal: AbortSignal | undefined,
  execute: BrokeredCommandExecutor,
): Promise<HistoryCommit[]> {
  const output = await git(
    repository,
    [
      "log",
      ...(days === undefined ? [] : [`--since=${days}.days`]),
      "--format=@@@%H%x09%ct%x09%an",
      "--name-only",
      "--no-renames",
    ],
    signal,
    execute,
  );
  const commits: HistoryCommit[] = [];
  let current: HistoryCommit | undefined;
  for (const line of output.split("\n")) {
    if (line.startsWith("@@@")) {
      const [hash = "", timestamp = "0", author = "Unknown"] = line.slice(3).split("\t");
      current = { hash, timestamp: Number(timestamp), author, paths: [] };
      commits.push(current);
    } else if (line && current && !isSensitiveGitPath(line, repository, workspace)) {
      current.paths.push(line);
    }
  }
  return commits;
}

function dateKey(timestamp: number): string {
  return new Date(timestamp * 1000).toISOString().slice(0, 10);
}

function histogram<T>(values: readonly T[]): Map<T, number> {
  const counts = new Map<T, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function ranked<T>(counts: Map<T, number>): Array<[T, number]> {
  return [...counts.entries()].sort(
    (left, right) => right[1] - left[1] || String(left[0]).localeCompare(String(right[0])),
  );
}

function topLevelArea(path: string): string {
  const [first] = path.split("/");
  return path.includes("/") ? `${first}/` : "(repository root)";
}

function activitySparkline(timestamps: readonly number[], weeks = 12): string {
  const now = Date.now();
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  const counts = Array.from({ length: weeks }, () => 0);
  for (const timestamp of timestamps) {
    const age = now - timestamp * 1000;
    const index = weeks - 1 - Math.floor(age / weekMs);
    if (index >= 0 && index < weeks) counts[index]++;
  }
  const bars = "▁▂▃▄▅▆▇█";
  const maximum = Math.max(...counts, 1);
  const sparkline = counts
    .map((count) => bars[Math.round((count / maximum) * (bars.length - 1))])
    .join("");
  return `${sparkline}  ${counts.join(" · ")} commits/week`;
}

function formatByteCount(bytes: number): string {
  return formatSize(bytes);
}

async function rootCommit(
  repository: string,
  signal: AbortSignal | undefined,
  execute: BrokeredCommandExecutor,
): Promise<string | undefined> {
  const roots = (await git(repository, ["rev-list", "--max-parents=0", "HEAD"], signal, execute))
    .trim()
    .split("\n");
  return roots.at(-1) || undefined;
}

async function firstCommit(
  repository: string,
  signal: AbortSignal | undefined,
  execute: BrokeredCommandExecutor,
): Promise<string> {
  const root = await rootCommit(repository, signal, execute);
  if (!root) return "(no commits)";
  return (
    await git(
      repository,
      ["show", "-s", "--date=short", "--format=%h %ad %an — %s", root],
      signal,
      execute,
    )
  ).trim();
}

async function formatLargestFiles(
  repository: string,
  workspace: string,
  limit: number,
  signal: AbortSignal | undefined,
  execute: BrokeredCommandExecutor,
): Promise<string> {
  const rows = (await trackedFiles(repository, workspace, signal, execute))
    .map((path) => {
      const stat = statSync(resolve(repository, path), { throwIfNoEntry: false });
      return stat?.isFile() ? { path, bytes: stat.size } : undefined;
    })
    .filter((row): row is { path: string; bytes: number } => Boolean(row))
    .sort((left, right) => right.bytes - left.bytes || left.path.localeCompare(right.path))
    .slice(0, limit)
    .map((row, index) => `${index + 1}. ${row.path} — ${formatByteCount(row.bytes)}`);
  return rows.length ? `Largest tracked files:\n${rows.join("\n")}` : "No tracked files.";
}

async function fileAges(
  repository: string,
  workspace: string,
  signal: AbortSignal | undefined,
  execute: BrokeredCommandExecutor,
): Promise<Array<{ path: string; timestamp: number }>> {
  const files = new Set(await trackedFiles(repository, workspace, signal, execute));
  const ages = new Map<string, number>();
  for (const commit of await historyCommits(repository, workspace, undefined, signal, execute)) {
    for (const path of commit.paths) {
      if (files.has(path) && !ages.has(path)) ages.set(path, commit.timestamp);
    }
  }
  return [...files].map((path) => ({ path, timestamp: ages.get(path) ?? 0 }));
}

async function formatContributorTrivia(
  repository: string,
  workspace: string,
  signal: AbortSignal | undefined,
  execute: BrokeredCommandExecutor,
): Promise<string> {
  const commits = await historyCommits(repository, workspace, undefined, signal, execute);
  const authors = ranked(histogram(commits.map((commit) => commit.author)));
  const weekdays = ranked(
    histogram(
      commits.map((commit) =>
        new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "UTC" }).format(
          new Date(commit.timestamp * 1000),
        ),
      ),
    ),
  );
  const biggest = [...commits].sort(
    (left, right) => right.paths.length - left.paths.length || left.hash.localeCompare(right.hash),
  )[0];
  const longest = (await git(repository, ["log", "--format=%s"], signal, execute))
    .split("\n")
    .sort((left, right) => right.length - left.length)[0];
  const fileTypes = formatStats(
    await git(repository, ["ls-files", "-z"], signal, execute),
    repository,
    workspace,
  )
    .split("\n")
    .slice(1, 3)
    .join(" ");
  return [
    `First commit: ${await firstCommit(repository, signal, execute)}`,
    `Most prolific contributor: ${authors[0]?.[0] ?? "unknown"} (${authors[0]?.[1] ?? 0} commits)`,
    `Busiest weekday: ${weekdays[0]?.[0] ?? "unknown"} (${weekdays[0]?.[1] ?? 0} commits)`,
    `Biggest commit: ${biggest ? `${biggest.hash.slice(0, 8)} (${biggest.paths.length} file touches)` : "unknown"}`,
    `Longest commit subject: ${longest || "(none)"}`,
    `Most common file type: ${fileTypes || "unknown"}`,
  ].join("\n");
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
    case "commit_details": {
      const selected = revision(input.revision);
      const [metadata, names] = await Promise.all([
        git(
          repository,
          [
            "show",
            "-s",
            "--date=iso-strict",
            "--format=Commit: %H%nAuthor: %an%nDate: %ad%nSubject: %s%n%n%b",
            selected,
          ],
          signal,
          execute,
        ),
        git(
          repository,
          ["diff-tree", "--root", "--no-commit-id", "--name-status", "-r", "-z", selected],
          signal,
          execute,
        ),
      ]);
      return present(
        `${metadata.trimEnd()}\n\nChanged files:\n${formatChangedFiles(names, repository, workspace)}`,
      );
    }
    case "search_commits": {
      const query = fixedText(input.query, "query");
      return present(
        await git(
          repository,
          [
            "log",
            `-${limit}`,
            "--fixed-strings",
            "--regexp-ignore-case",
            `--grep=${query}`,
            "--date=short",
            "--format=%h %ad %an — %s",
          ],
          signal,
          execute,
        ),
      );
    }
    case "branch_divergence": {
      const base = revision(input.baseRevision ?? "main");
      const head = revision(input.headRevision ?? "HEAD");
      const counts = (
        await git(
          repository,
          ["rev-list", "--left-right", "--count", `${base}...${head}`],
          signal,
          execute,
        )
      )
        .trim()
        .split(/\s+/);
      const mergeBase = (await git(repository, ["merge-base", base, head], signal, execute)).trim();
      return `Base ${base}: ${counts[0] ?? "0"} unique commit(s)\nHead ${head}: ${counts[1] ?? "0"} unique commit(s)\nMerge base: ${mergeBase}`;
    }
    case "release_notes": {
      const base = revision(fixedText(input.baseRevision, "baseRevision", 128));
      const head = revision(input.headRevision ?? "HEAD");
      return present(
        await git(
          repository,
          ["log", `-${limit}`, "--date=short", "--format=- %s (%h, %an, %ad)", `${base}..${head}`],
          signal,
          execute,
        ),
      );
    }
    case "activity_calendar": {
      const days = boundedInteger(input.days, 84, 7, 365, "days");
      const commits = await historyCommits(repository, workspace, days, signal, execute);
      const dates = ranked(histogram(commits.map((commit) => dateKey(commit.timestamp))));
      const daily = dates
        .sort((left, right) => String(left[0]).localeCompare(String(right[0])))
        .map(([date, count]) => `${date} ${"#".repeat(Math.min(count, 20))} ${count}`);
      return present(
        `Activity over ${days} days (${commits.length} commits)\n${activitySparkline(commits.map((commit) => commit.timestamp))}\n\n${daily.join("\n") || "No activity."}`,
      );
    }
    case "code_age": {
      const ages = await fileAges(repository, workspace, signal, execute);
      const now = Date.now() / 1000;
      const buckets = { "<30 days": 0, "30–179 days": 0, "180–364 days": 0, "1+ years": 0 };
      for (const file of ages) {
        const days = (now - file.timestamp) / 86_400;
        if (days < 30) buckets["<30 days"]++;
        else if (days < 180) buckets["30–179 days"]++;
        else if (days < 365) buckets["180–364 days"]++;
        else buckets["1+ years"]++;
      }
      return [
        `Tracked files aged: ${ages.length}`,
        ...Object.entries(buckets).map(([name, count]) => `- ${name}: ${count}`),
      ].join("\n");
    }
    case "file_ownership": {
      const path = repositoryPath(input.path, repository, workspace);
      const output = await git(
        repository,
        ["blame", "--line-porcelain", "--no-textconv", revision(input.revision), "--", path],
        signal,
        execute,
      );
      const authors = ranked(
        histogram(
          output
            .split("\n")
            .filter((line) => line.startsWith("author "))
            .map((line) => line.slice(7)),
        ),
      );
      const total = authors.reduce((sum, [, count]) => sum + count, 0);
      return present(
        `Ownership for ${path} (${total} lines):\n${authors
          .slice(0, limit)
          .map(
            ([author, count]) =>
              `- ${author}: ${count} lines (${((count / total) * 100).toFixed(1)}%)`,
          )
          .join("\n")}`,
      );
    }
    case "bus_factor": {
      const days = boundedInteger(input.days, 180, 7, 3650, "days");
      const commits = await historyCommits(repository, workspace, days, signal, execute);
      const authors = ranked(histogram(commits.map((commit) => commit.author)));
      const total = commits.length || 1;
      let cumulative = 0;
      let busFactor = 0;
      for (const [, count] of authors) {
        cumulative += count;
        busFactor++;
        if (cumulative / total >= 0.5) break;
      }
      return present(
        `Approximate bus factor over ${days} days: ${busFactor}\nContributors needed for 50% of commits: ${
          authors
            .slice(0, limit)
            .map(([author, count]) => `${author} (${((count / total) * 100).toFixed(1)}%)`)
            .join(", ") || "none"
        }`,
      );
    }
    case "stale_branches": {
      const output = await git(
        repository,
        [
          "for-each-ref",
          "--sort=committerdate",
          "--format=%(refname:short)%09%(committerdate:unix)%09%(committerdate:short)%09%(subject)",
          "refs/heads",
        ],
        signal,
        execute,
      );
      const rows = output
        .trim()
        .split("\n")
        .filter(Boolean)
        .slice(0, limit)
        .map((line) => {
          const [branch = "unknown", timestamp = "0", date = "unknown", ...subject] =
            line.split("\t");
          const age = Math.max(0, Math.floor((Date.now() / 1000 - Number(timestamp)) / 86_400));
          return `${branch} — ${age} days (${date}) — ${subject.join("\t")}`;
        });
      return present(`Local branches, stalest first:\n${rows.join("\n") || "(none)"}`);
    }
    case "largest_files":
      return present(await formatLargestFiles(repository, workspace, limit, signal, execute));
    case "oldest_files": {
      const rows = (await fileAges(repository, workspace, signal, execute))
        .sort(
          (left, right) => left.timestamp - right.timestamp || left.path.localeCompare(right.path),
        )
        .slice(0, limit)
        .map((file, index) => `${index + 1}. ${file.path} — ${dateKey(file.timestamp)}`);
      return present(`Oldest unchanged tracked files:\n${rows.join("\n") || "(none)"}`);
    }
    case "change_coupling": {
      const days = boundedInteger(input.days, 180, 7, 3650, "days");
      const pairs = new Map<string, number>();
      const commits = (await historyCommits(repository, workspace, days, signal, execute)).slice(
        0,
        MAX_COUPLING_COMMITS,
      );
      for (const commit of commits) {
        const paths = [...new Set(commit.paths)].sort().slice(0, MAX_COUPLING_FILES_PER_COMMIT);
        for (let left = 0; left < paths.length; left++) {
          for (let right = left + 1; right < paths.length; right++) {
            const key = `${paths[left]}\0${paths[right]}`;
            pairs.set(key, (pairs.get(key) ?? 0) + 1);
          }
        }
      }
      const rows = ranked(pairs)
        .slice(0, limit)
        .map(
          ([pair, count], index) => `${index + 1}. ${pair.replace("\0", " ↔ ")} — ${count} commits`,
        );
      return present(
        `Files that change together over ${days} days (latest ${commits.length} commits analyzed):\n${rows.join("\n") || "(none)"}`,
      );
    }
    case "commit_streaks": {
      const days = boundedInteger(input.days, 3650, 30, 3650, "days");
      const dates = [
        ...new Set(
          (await historyCommits(repository, workspace, days, signal, execute)).map((commit) =>
            dateKey(commit.timestamp),
          ),
        ),
      ].sort();
      let longest = 0;
      let current = 0;
      let previous: number | undefined;
      for (const date of dates) {
        const day = Date.parse(`${date}T00:00:00Z`) / 86_400_000;
        current = previous !== undefined && day === previous + 1 ? current + 1 : 1;
        longest = Math.max(longest, current);
        previous = day;
      }
      const latest = dates.at(-1);
      let active = 0;
      if (latest) {
        const latestDay = Date.parse(`${latest}T00:00:00Z`) / 86_400_000;
        const today = Math.floor(Date.now() / 86_400_000);
        if (today - latestDay <= 1) {
          active = 1;
          for (let index = dates.length - 2; index >= 0; index--) {
            const next = Date.parse(`${dates[index + 1]}T00:00:00Z`) / 86_400_000;
            const day = Date.parse(`${dates[index]}T00:00:00Z`) / 86_400_000;
            if (next - day !== 1) break;
            active++;
          }
        }
      }
      return `Longest daily commit streak: ${longest} day(s)\nCurrent streak: ${active} day(s)\nLatest active day: ${latest ?? "none"}\nActive days measured: ${dates.length}`;
    }
    case "repo_health": {
      const [branch, status, latest] = await Promise.all([
        git(repository, ["branch", "--show-current"], signal, execute),
        git(
          repository,
          ["status", "--porcelain=v1", "--ignore-submodules=all", "-z"],
          signal,
          execute,
        ),
        git(repository, ["log", "-1", "--format=%ct"], signal, execute),
      ]);
      const upstream = await rawGit(
        repository,
        ["rev-parse", "--abbrev-ref", "@{upstream}"],
        signal,
        execute,
      );
      let divergence = "No local upstream configured.";
      if (upstream.code === 0) {
        const name = upstream.stdout.trim();
        const counts = (
          await git(
            repository,
            ["rev-list", "--left-right", "--count", `${name}...HEAD`],
            signal,
            execute,
          )
        )
          .trim()
          .split(/\s+/);
        divergence = `Upstream ${name}: ${counts[0] ?? 0} behind, ${counts[1] ?? 0} ahead`;
      }
      const visibleStatus = formatStatus(status, repository, workspace);
      const latestAge = Math.max(
        0,
        Math.floor((Date.now() / 1000 - Number(latest.trim())) / 86_400),
      );
      return `Branch: ${branch.trim() || "(detached)"}\nLatest commit: ${latestAge} day(s) ago (${latestAge > 90 ? "stale" : "fresh"})\n${divergence}\nWorking tree: ${visibleStatus.includes("Working tree clean") ? "clean" : "has visible changes"}`;
    }
    case "contributor_trivia":
      return present(await formatContributorTrivia(repository, workspace, signal, execute));
  }
}

const FORTUNES = [
  "The next clean abstraction is probably smaller than the current one.",
  "A well-named test will save a future afternoon.",
  "The oldest file remembers why the shortcut exists.",
  "Today's tiny refactor is tomorrow's missing incident.",
  "A suspiciously hot file is asking for a calmer interface.",
  "The repository favors boring code and exciting lunch breaks.",
  "One more focused commit will reveal the path.",
  "The green build approaches, carrying snacks.",
] as const;

export async function runRepoFun(
  input: RepoFunInput,
  workspace: string,
  signal?: AbortSignal,
  execute: BrokeredCommandExecutor = executeBrokeredCommand,
): Promise<string> {
  const repository = await requireRepositoryRoot(input.repository, workspace, signal, execute);
  const days = boundedInteger(input.days, 84, 7, 3650, "days");
  const limit = boundedInteger(input.limit, 10, 1, 50, "limit");
  switch (input.action) {
    case "birthday": {
      const first = await firstCommit(repository, signal, execute);
      const root = await rootCommit(repository, signal, execute);
      const timestamp = root
        ? Number(
            (await git(repository, ["show", "-s", "--format=%ct", root], signal, execute)).trim(),
          )
        : Math.floor(Date.now() / 1000);
      const ageDays = Math.max(0, Math.floor((Date.now() / 1000 - timestamp) / 86_400));
      return `🎂 Codebase birthday\n${first}\nAge: ${ageDays} days (${(ageDays / 365.25).toFixed(1)} years)`;
    }
    case "ancient_artifacts":
      return `🏺 ${await runGitInspection({ action: "oldest_files", repository: input.repository, limit }, workspace, signal, execute)}`;
    case "hot_zone": {
      const commits = await historyCommits(repository, workspace, days, signal, execute);
      const areas = ranked(histogram(commits.flatMap((commit) => commit.paths.map(topLevelArea))));
      return present(
        `🔥 Hot zones over ${days} days:\n${
          areas
            .slice(0, limit)
            .map(([area, count], index) => `${index + 1}. ${area} — ${count} touches`)
            .join("\n") || "No recent activity."
        }`,
      );
    }
    case "team_constellation": {
      const commits = await historyCommits(repository, workspace, days, signal, execute);
      const areas = new Map<string, Map<string, number>>();
      for (const commit of commits) {
        for (const area of new Set(commit.paths.map(topLevelArea))) {
          const authors = areas.get(area) ?? new Map<string, number>();
          authors.set(commit.author, (authors.get(commit.author) ?? 0) + 1);
          areas.set(area, authors);
        }
      }
      const rows = [...areas.entries()]
        .map(([area, authors]) => ({ area, leaders: ranked(authors).slice(0, 3) }))
        .sort((left, right) => (right.leaders[0]?.[1] ?? 0) - (left.leaders[0]?.[1] ?? 0))
        .slice(0, limit)
        .map(
          ({ area, leaders }) =>
            `✦ ${area}: ${leaders.map(([author, count]) => `${author} (${count})`).join(", ")}`,
        );
      return present(
        `✨ Team constellation over ${days} days:\n${rows.join("\n") || "No stars yet."}`,
      );
    }
    case "commit_weather": {
      const commits = await historyCommits(repository, workspace, days, signal, execute);
      const touches = commits.reduce((sum, commit) => sum + commit.paths.length, 0);
      const perWeek = commits.length / Math.max(days / 7, 1);
      const weather =
        perWeek >= 25
          ? "🌋 volcanic"
          : perWeek >= 10
            ? "⛈️ stormy"
            : perWeek >= 3
              ? "🌦️ breezy"
              : perWeek > 0
                ? "☀️ calm"
                : "🌙 dormant";
      return `Commit weather: ${weather}\n${commits.length} commits and ${touches} file touches over ${days} days (${perWeek.toFixed(1)} commits/week).`;
    }
    case "fortune": {
      const head = (await git(repository, ["rev-parse", "HEAD"], signal, execute)).trim();
      const index = Number.parseInt(head.slice(0, 8), 16) % FORTUNES.length;
      return `🥠 Repository fortune\n${FORTUNES[index]}`;
    }
    case "activity_sparkline": {
      const commits = await historyCommits(repository, workspace, days, signal, execute);
      return `📈 Activity sparkline (${days} days)\n${activitySparkline(commits.map((commit) => commit.timestamp))}`;
    }
    case "milestones": {
      const count = Number(
        (await git(repository, ["rev-list", "--count", "HEAD"], signal, execute)).trim(),
      );
      const next = Math.ceil((count + 1) / 100) * 100;
      const root = await rootCommit(repository, signal, execute);
      const firstTimestamp = root
        ? Number(
            (await git(repository, ["show", "-s", "--format=%ct", root], signal, execute)).trim(),
          )
        : Math.floor(Date.now() / 1000);
      const birthday = new Date(firstTimestamp * 1000);
      const now = new Date();
      const anniversary = new Date(
        Date.UTC(now.getUTCFullYear(), birthday.getUTCMonth(), birthday.getUTCDate()),
      );
      if (anniversary.getTime() < now.getTime())
        anniversary.setUTCFullYear(now.getUTCFullYear() + 1);
      const anniversaryDays = Math.ceil((anniversary.getTime() - now.getTime()) / 86_400_000);
      return `🏁 Milestones\nCommits: ${count}; ${next - count} until ${next}.\nNext codebase anniversary: ${anniversary.toISOString().slice(0, 10)} (${anniversaryDays} days).`;
    }
    case "trivia":
      return `🧠 Repository trivia\n${await formatContributorTrivia(repository, workspace, signal, execute)}`;
    case "personality": {
      const commits = await historyCommits(repository, workspace, days, signal, execute);
      const files = await trackedFiles(repository, workspace, signal, execute);
      const authors = new Set(commits.map((commit) => commit.author)).size;
      const areas = new Set(files.map(topLevelArea)).size;
      const extensions = ranked(
        histogram(
          files.map((path) => {
            const name = path.split("/").at(-1) ?? path;
            return name.includes(".")
              ? `.${name.split(".").at(-1)!.toLowerCase()}`
              : "no extension";
          }),
        ),
      );
      const root = await rootCommit(repository, signal, execute);
      const firstTimestamp = root
        ? Number(
            (await git(repository, ["show", "-s", "--format=%ct", root], signal, execute)).trim(),
          )
        : Math.floor(Date.now() / 1000);
      const ageYears = (Date.now() / 1000 - firstTimestamp) / (365.25 * 86_400);
      const tempo = commits.length / Math.max(days / 7, 1);
      const mood = tempo > 15 ? "energetic" : tempo > 5 ? "steady" : "deliberate";
      const shape =
        areas > 10
          ? "a sprawling neighborhood"
          : areas > 4
            ? "a tidy little city"
            : "a focused workshop";
      return `🎭 Repository personality\nA ${mood} ${shape}, ${ageYears.toFixed(1)} years old: ${files.length} tracked files across ${areas} areas, led by ${
        extensions
          .slice(0, 3)
          .map(([extension, count]) => `${extension} (${count})`)
          .join(", ") || "an eclectic language mix"
      }, with ${authors} recent contributor${authors === 1 ? "" : "s"}. It prefers focused commits, explicit boundaries, and tests before adventures.`;
    }
  }
}

const SYSTEM_COMMANDS: Partial<Record<SystemAction, { executable: string; arguments: string[] }>> =
  {
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

async function fixedSystemCommand(
  executable: string,
  arguments_: string[],
  action: string,
  workspace: string,
  signal: AbortSignal | undefined,
  execute: BrokeredCommandExecutor,
): Promise<string> {
  const result = await execute({ executable, arguments: arguments_, cwd: workspace }, signal);
  if (result.code !== 0) {
    const detail =
      result.stderr.trim() || result.stdout.trim() || `${action} exited with code ${result.code}`;
    throw new Error(detail);
  }
  return result.stdout;
}

function jsonObject(output: string, action: string): Record<string, unknown> {
  try {
    const value = JSON.parse(output);
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
  } catch {}
  throw new Error(`${action} returned malformed system data`);
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function formatBatteryHealth(output: string): string {
  const entries = jsonObject(output, "battery_health").SPPowerDataType;
  if (!Array.isArray(entries)) throw new Error("battery_health data is unavailable");
  const battery = entries.map(object).find((entry) => object(entry?.sppower_battery_health_info));
  const health = object(battery?.sppower_battery_health_info);
  const charge = object(battery?.sppower_battery_charge_info);
  if (!health) throw new Error("This Mac did not report an internal battery");
  return [
    `Condition: ${String(health.sppower_battery_health ?? "unknown")}`,
    `Maximum capacity: ${String(health.sppower_battery_health_maximum_capacity ?? "unknown")}`,
    `Cycle count: ${String(health.sppower_battery_cycle_count ?? "unknown")}`,
    `Charge: ${String(charge?.sppower_battery_state_of_charge ?? "unknown")}%`,
    `Charging: ${charge?.sppower_battery_is_charging === "TRUE" ? "yes" : "no"}`,
  ].join("\n");
}

function formatDisplaySummary(output: string): string {
  const devices = jsonObject(output, "display_summary").SPDisplaysDataType;
  if (!Array.isArray(devices)) throw new Error("display_summary data is unavailable");
  const displays = devices
    .flatMap((device) => {
      const drivers = object(device)?.spdisplays_ndrvs;
      return Array.isArray(drivers) ? drivers.map(object).filter(Boolean) : [];
    })
    .map((display) => ({
      name: String(display?._name ?? "Display"),
      resolution: String(
        display?._spdisplays_resolution ?? display?.spdisplays_resolution ?? "unknown resolution",
      ),
      pixels: String(display?._spdisplays_pixels ?? "unknown pixels"),
      main: display?.spdisplays_main === "spdisplays_yes",
    }));
  return [
    `Connected displays: ${displays.length}`,
    ...displays.map(
      (display, index) =>
        `${index + 1}. ${display.name}${display.main ? " (main)" : ""} — ${display.resolution}; ${display.pixels}`,
    ),
  ].join("\n");
}

function formatPowerSettings(output: string): string {
  const allowed = new Set([
    "Battery Power:",
    "AC Power:",
    "displaysleep",
    "sleep",
    "disksleep",
    "lessbright",
    "lowpowermode",
    "powermode",
    "powernap",
    "womp",
  ]);
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => allowed.has(line) || allowed.has(line.split(/\s+/)[0] ?? ""))
    .join("\n");
}

function formatMemorySummary(vmOutput: string, memoryBytes: number, swap: string): string {
  const pageSize = Number(/page size of (\d+) bytes/.exec(vmOutput)?.[1] ?? 4096);
  const pages = (name: string) =>
    Number(new RegExp(`^Pages ${name}:\\s+(\\d+)`, "m").exec(vmOutput)?.[1] ?? 0);
  const free = (pages("free") + pages("inactive") + pages("speculative")) * pageSize;
  const active = pages("active") * pageSize;
  const wired = pages("wired down") * pageSize;
  const compressed = pages("occupied by compressor") * pageSize;
  return [
    `Installed: ${formatByteCount(memoryBytes)}`,
    `Available estimate: ${formatByteCount(free)}`,
    `Active: ${formatByteCount(active)}`,
    `Wired: ${formatByteCount(wired)}`,
    `Compressed: ${formatByteCount(compressed)}`,
    `Swap: ${swap || "unknown"}`,
  ].join("\n");
}

export async function runSystemInfo(
  input: SystemInfoInput,
  workspace: string,
  signal?: AbortSignal,
  execute: BrokeredCommandExecutor = executeBrokeredCommand,
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  if (platform !== "darwin") throw new Error("system_info is supported only on macOS");
  switch (input.action) {
    case "battery_health":
      return formatBatteryHealth(
        await fixedSystemCommand(
          "/usr/sbin/system_profiler",
          ["SPPowerDataType", "-json"],
          input.action,
          workspace,
          signal,
          execute,
        ),
      );
    case "cpu_summary": {
      const output = await fixedSystemCommand(
        "/usr/sbin/sysctl",
        ["-n", "machdep.cpu.brand_string", "hw.physicalcpu", "hw.logicalcpu"],
        input.action,
        workspace,
        signal,
        execute,
      );
      const [model = "unknown", physical = "unknown", logical = "unknown"] = output
        .trim()
        .split("\n");
      return `CPU: ${model}\nPhysical cores: ${physical}\nLogical cores: ${logical}\nArchitecture: ${process.arch}`;
    }
    case "memory_summary": {
      const [vm, installed] = await Promise.all([
        fixedSystemCommand("/usr/bin/vm_stat", [], input.action, workspace, signal, execute),
        fixedSystemCommand(
          "/usr/sbin/sysctl",
          ["-n", "hw.memsize", "vm.swapusage"],
          input.action,
          workspace,
          signal,
          execute,
        ),
      ]);
      const [memoryBytes = "0", swap = "unknown"] = installed.trim().split("\n");
      return formatMemorySummary(vm, Number(memoryBytes), swap);
    }
    case "volume_summary": {
      const output = await fixedSystemCommand(
        "/bin/df",
        ["-h", realpathSync(workspace)],
        input.action,
        workspace,
        signal,
        execute,
      );
      const [header, row] = output.trim().split("\n");
      return `Workspace volume:\n${header ?? ""}\n${row ?? ""}`;
    }
    case "power_settings":
      return formatPowerSettings(
        await fixedSystemCommand(
          "/usr/bin/pmset",
          ["-g", "custom"],
          input.action,
          workspace,
          signal,
          execute,
        ),
      );
    case "developer_tools": {
      const [xcode, clang] = await Promise.all([
        fixedSystemCommand(
          "/usr/bin/xcodebuild",
          ["-version"],
          input.action,
          workspace,
          signal,
          execute,
        ),
        fixedSystemCommand(
          "/usr/bin/clang",
          ["--version"],
          input.action,
          workspace,
          signal,
          execute,
        ),
      ]);
      return `Xcode:\n${xcode.trim()}\n\nCompiler:\n${clang.split("\n").slice(0, 2).join("\n")}`;
    }
    case "runtime_versions": {
      const tools: Array<[string, string, string[]]> = [
        ["Git", "/usr/bin/git", ["--version"]],
        ["Bun", process.execPath, ["--version"]],
      ];
      const unavailable: string[] = [];
      for (const [label, name] of [
        ["Mise", "mise"],
        ["Task", "task"],
      ] as const) {
        const executable = Bun.which(name);
        if (executable) tools.push([label, executable, ["--version"]]);
        else unavailable.push(`${label}: not installed`);
      }
      const versions = await Promise.all(
        tools.map(
          async ([label, executable, arguments_]) =>
            `${label}: ${(await fixedSystemCommand(executable, arguments_, input.action, workspace, signal, execute)).trim().split("\n")[0]}`,
        ),
      );
      return [...versions, ...unavailable].join("\n");
    }
    case "display_summary":
      return formatDisplaySummary(
        await fixedSystemCommand(
          "/usr/sbin/system_profiler",
          ["SPDisplaysDataType", "-json"],
          input.action,
          workspace,
          signal,
          execute,
        ),
      );
    case "system_pressure": {
      const [battery, uptime, memory, thermal, volume] = await Promise.all([
        runSystemInfo({ action: "battery" }, workspace, signal, execute, platform),
        runSystemInfo({ action: "uptime" }, workspace, signal, execute, platform),
        runSystemInfo({ action: "memory_pressure" }, workspace, signal, execute, platform),
        runSystemInfo({ action: "thermal_pressure" }, workspace, signal, execute, platform),
        runSystemInfo({ action: "volume_summary" }, workspace, signal, execute, platform),
      ]);
      const capacity = Number(/\s(\d+)%\s/.exec(volume)?.[1] ?? 0);
      const thermalWarning =
        /warn|critical/i.test(thermal) && !/no (?:thermal|performance) warning/i.test(thermal);
      const memoryWarning = /critical|urgent|warn/i.test(memory);
      const verdict =
        thermalWarning || memoryWarning || capacity >= 90 ? "attention recommended" : "normal";
      return present(
        `System pressure verdict: ${verdict}\n\nBattery: ${battery}\n\nUptime/load: ${uptime}\n\nMemory: ${memory}\n\nThermal: ${thermal}\n\nDisk: ${volume}`,
      );
    }
    case "service_health": {
      const hum = Bun.which("hum");
      if (!hum) {
        return "SlackDeskBot process is running, but Hum status is unavailable; readiness and restart count are unknown.";
      }
      const runtimeDirectory = join(tmpdir(), `hum-${process.getuid?.() ?? 0}`);
      const serviceProject = realpathSync(process.cwd());
      const output = await fixedSystemCommand(
        hum,
        [
          "--project",
          serviceProject,
          "--runtime-dir",
          runtimeDirectory,
          "status",
          "agent",
          "--json",
        ],
        input.action,
        workspace,
        signal,
        execute,
      );
      const status = jsonObject(output, input.action);
      const started = typeof status.started_at === "string" ? Date.parse(status.started_at) : NaN;
      const uptime = Number.isFinite(started)
        ? `${Math.max(0, Math.floor((Date.now() - started) / 1000))} seconds`
        : "unknown";
      return [
        `State: ${String(status.state ?? "unknown")}`,
        `Readiness: ${String(status.readiness ?? "unknown")}`,
        `Uptime: ${uptime}`,
        `Restart count: ${String(status.restart_count ?? "unknown")}`,
        `Relaunches: ${String(status.relaunches ?? "unknown")}`,
      ].join("\n");
    }
    default: {
      const selected = SYSTEM_COMMANDS[input.action];
      if (!selected) throw new Error(`Unsupported system_info action: ${input.action}`);
      const arguments_ = [
        ...selected.arguments,
        ...(input.action === "disk_space" ? [realpathSync(workspace)] : []),
      ];
      return present(
        await fixedSystemCommand(
          selected.executable,
          arguments_,
          input.action,
          workspace,
          signal,
          execute,
        ),
      );
    }
  }
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
          "Safely inspect repository state, history, ownership, activity, age, branch divergence, release notes, file size, coupling, streaks, health, and trivia without a shell. repository selects a Git root within the workspace and defaults to the workspace itself. Path actions require a repository-relative literal path. Ref actions accept only simple local commit IDs or ref names. Output is bounded to 50KB/2000 lines and sensitive paths are blocked.",
        promptSnippet:
          "Inspect Git state, history, blame, ownership, activity, coupling, release notes, and repository health",
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
          baseRevision: Type.Optional(
            Type.String({ description: "Simple base commit ID or ref for comparison actions" }),
          ),
          headRevision: Type.Optional(
            Type.String({ description: "Simple head commit ID or ref; defaults to HEAD" }),
          ),
          query: Type.Optional(
            Type.String({
              description: "Literal text for commit search; never interpreted as a regex",
            }),
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
            Type.Integer({ minimum: 1, maximum: 3650, description: "Analysis lookback window" }),
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
        name: "repo_fun",
        label: "Repo Fun",
        description:
          "Generate safe, deterministic repository personality, birthday, ancient-artifact, hot-zone, team-constellation, commit-weather, fortune, activity-sparkline, milestone, and trivia reports from local Git metadata. No network or mutation operations are used.",
        promptSnippet:
          "Share repository personality, birthday, weather, fortunes, sparklines, milestones, and team trivia",
        promptGuidelines: [
          "Use repo_fun for playful team questions and lightweight repository celebrations; label its personality, weather, fortune, and bus-factor-style conclusions as approximate.",
        ],
        parameters: Type.Object({
          action: StringEnum(REPO_FUN_ACTIONS, {
            description: "Playful repository insight to generate",
          }),
          repository: Type.Optional(
            Type.String({
              description: "Workspace-relative Git repository root; defaults to the workspace",
            }),
          ),
          days: Type.Optional(
            Type.Integer({ minimum: 7, maximum: 3650, description: "Analysis lookback window" }),
          ),
          limit: Type.Optional(
            Type.Integer({ minimum: 1, maximum: 50, description: "Maximum ranked results" }),
          ),
        }),
        async execute(_toolCallId, params, signal) {
          return {
            content: [{ type: "text", text: await runRepoFun(params, workspace, signal, execute) }],
            details: { action: params.action },
          };
        },
      });

      pi.registerTool({
        name: "system_info",
        label: "System Info",
        description:
          "Read benign, redacted macOS host facts through fixed commands without a shell. Reports battery and battery health, uptime/load, OS/kernel/CPU/runtime/tool versions, disk/volume/memory/thermal pressure, power settings, connected display summaries, computer name, local clock, combined system pressure, or SlackDeskBot process health. No arbitrary command or arguments are accepted; hardware serial numbers and private activity are omitted.",
        promptSnippet:
          "Check macOS battery health, pressure, CPU, memory, displays, tools, service health, disk, clock, and versions",
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
