import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

const MAX_STDERR_TAIL_BYTES = 4 * 1024;
const FORCE_KILL_DELAY_MS = 5_000;

export interface CliProcessStreams {
  /** Bounded tail of the child's stderr, for operator logs only. */
  stderrTail(): string;
  /** Rejects with the first stdin/spawn failure, so EPIPE never goes unhandled. */
  failure(): Error | undefined;
}

/**
 * Writes the prompt to stdin and captures failures that would otherwise become
 * unhandled stream errors and crash the service, plus a bounded stderr tail so
 * a nonzero exit is diagnosable.
 */
export function writePromptAndCapture(
  child: ChildProcessWithoutNullStreams,
  prompt: string,
): CliProcessStreams {
  let tail = "";
  let failure: Error | undefined;

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    tail = `${tail}${chunk}`.slice(-MAX_STDERR_TAIL_BYTES);
  });
  // An early child exit makes this write fail with EPIPE; record it instead of
  // letting it reach the process-level error handler.
  child.stdin.on("error", (error: Error) => {
    failure ??= error;
  });
  child.stdin.end(prompt);

  return { stderrTail: () => tail.trim(), failure: () => failure };
}

export interface SandboxedJsonlExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderrTail: string;
  stdinFailure?: Error;
}

interface SandboxedJsonlOptions {
  profile: string;
  executable: string;
  arguments: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  prompt: string;
  signal?: AbortSignal;
  spawnProcess?: typeof spawn;
  onSpawn?(process: ChildProcessWithoutNullStreams): void;
  onEvent(event: Record<string, unknown>): void;
  malformedOutputError(): Error;
}

/** Runs a CLI inside Seatbelt, aborts it safely, and drains its JSONL output. */
export async function runSandboxedJsonl({
  profile,
  executable,
  arguments: processArguments,
  cwd,
  env,
  prompt,
  signal,
  spawnProcess = spawn,
  onSpawn,
  onEvent,
  malformedOutputError,
}: SandboxedJsonlOptions): Promise<SandboxedJsonlExit> {
  const child = spawnProcess(
    "/usr/bin/sandbox-exec",
    ["-f", profile, executable, ...processArguments],
    { cwd, env, stdio: ["pipe", "pipe", "pipe"] },
  ) as ChildProcessWithoutNullStreams;
  onSpawn?.(child);

  let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
  const abort = () => {
    child.kill("SIGTERM");
    forceKillTimer ??= setTimeout(() => child.kill("SIGKILL"), FORCE_KILL_DELAY_MS);
    forceKillTimer.unref();
  };
  signal?.addEventListener("abort", abort, { once: true });

  const streams = writePromptAndCapture(child, prompt);
  let parseError: Error | undefined;
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    if (!line.trim() || parseError) return;
    try {
      onEvent(JSON.parse(line) as Record<string, unknown>);
    } catch {
      parseError = malformedOutputError();
      child.kill("SIGTERM");
    }
  });

  try {
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolveExit, reject) => {
        child.once("error", reject);
        child.once("close", (code, exitSignal) => resolveExit({ code, signal: exitSignal }));
      },
    );
    if (signal?.aborted) throw signal.reason;
    if (parseError) throw parseError;
    return {
      ...exit,
      stderrTail: streams.stderrTail(),
      stdinFailure: streams.failure(),
    };
  } finally {
    signal?.removeEventListener("abort", abort);
    if (forceKillTimer) clearTimeout(forceKillTimer);
    lines.close();
  }
}
