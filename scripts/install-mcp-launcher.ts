import { lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

const MARKER = "# Managed by SlackDeskBot task mcp:install";

function shell(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function mcpLauncher(repository: string, mise: string): string {
  return `#!/bin/sh
${MARKER}
cd ${shell(repository)} || exit 1
exec ${shell(mise)} exec bun -- bun src/mcp-server.ts
`;
}

export async function installMcpLauncher(
  options: {
    repository?: string;
    mise?: string;
    launcherPath?: string;
  } = {},
): Promise<string> {
  const repository = await realpath(options.repository ?? process.cwd());
  const mise = options.mise ?? Bun.which("mise");
  if (!mise || !isAbsolute(mise)) throw new Error("Mise is not installed or is not on PATH");
  await realpath(mise);
  const launcherPath = options.launcherPath ?? join(homedir(), ".local", "bin", "slack-desk-mcp");
  const parent = dirname(launcherPath);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const parentStat = await lstat(parent);
  if (!parentStat.isDirectory() || parentStat.uid !== process.getuid?.()) {
    throw new Error(`Launcher directory must belong to the current user: ${parent}`);
  }

  let existing;
  try {
    existing = await lstat(launcherPath);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  if (existing) {
    if (
      !existing.isFile() ||
      existing.uid !== process.getuid?.() ||
      !(await readFile(launcherPath, "utf8")).startsWith(`#!/bin/sh\n${MARKER}\n`)
    ) {
      throw new Error(`Refusing to replace an unmanaged launcher: ${launcherPath}`);
    }
  }

  const content = mcpLauncher(repository, mise);
  if (existing && (await readFile(launcherPath, "utf8")) === content && existing.mode & 0o111) {
    return launcherPath;
  }
  const temporaryPath = join(parent, `.slack-desk-mcp-${randomUUID()}`);
  await writeFile(temporaryPath, content, { mode: 0o700, flag: "wx" });
  // Rename replaces only the verified managed file (or creates the new launcher).
  await rename(temporaryPath, launcherPath);
  return launcherPath;
}

if (import.meta.main) {
  try {
    console.log(`Installed MCP launcher: ${await installMcpLauncher()}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "MCP launcher installation failed");
    process.exitCode = 1;
  }
}
