import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { sensitiveSeatbeltRegex } from "./sensitive-paths.ts";

export interface SeatbeltOptions {
  /** Directory the agent may read, and write when `allowWorkspaceWrite` is set. */
  workspace: string;
  /** Backend-owned state directory the agent process may read and write. */
  home: string;
  /** Agent executable; its install root stays readable. */
  executable: string;
  allowWorkspaceWrite?: boolean;
  /** Additional absolute paths the CLI needs for its own runtime state. */
  extraWritePaths?: readonly string[];
}

function literal(value: string): string {
  return JSON.stringify(value);
}

/**
 * Seatbelt boundary shared by the external CLI backends.
 *
 * Path metadata stays readable because the CLIs canonicalize their own
 * executable, home, and workspace before starting; only file *contents*
 * outside the workspace, backend home, and executable root are denied.
 */
export function seatbeltProfile(options: SeatbeltOptions): string {
  const workspace = realpathSync(options.workspace);
  const home = realpathSync(options.home);
  const executableRoot = dirname(dirname(realpathSync(options.executable)));
  const writable = [home, ...(options.extraWritePaths ?? [])];
  if (options.allowWorkspaceWrite) writable.push(workspace);
  const readable = [workspace, home, executableRoot];
  const confidentialRoots = [
    dirname(workspace),
    dirname(homedir()),
    "/private/tmp",
    "/private/var/folders",
    "/Volumes",
  ];
  const sensitive = sensitiveSeatbeltRegex(workspace);

  return [
    "(version 1)",
    "(deny default)",
    "(allow process*)",
    "(allow network*)",
    "(allow sysctl-read)",
    "(allow mach-lookup)",
    "(allow file-read-metadata)",
    "(allow file-read*)",
    ...writable.map((path) => `(allow file-write* (subpath ${literal(path)}))`),
    ...[...new Set(confidentialRoots)].map(
      (root) =>
        `(deny file-read-data (require-all (subpath ${literal(root)})` +
        [...new Set([...readable, ...(options.extraWritePaths ?? [])])]
          .map((path) => ` (require-not (subpath ${literal(path)}))`)
          .join("") +
        "))",
    ),
    '(allow file-read* file-write* (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random"))',
    `(deny file-read* file-write* (regex #"${sensitive}"))`,
    "",
  ].join("\n");
}
