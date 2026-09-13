import type { ChildProcessWithoutNullStreams } from "node:child_process";

const MAX_STDERR_TAIL_BYTES = 4 * 1024;

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
