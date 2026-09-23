import { expect, test } from "bun:test";
import { lstat, mkdtemp, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { installMcpLauncher } from "../scripts/install-mcp-launcher.ts";

test("installs a stable stdio launcher and refuses to overwrite unmanaged files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "slack-desk-mcp-launcher-"));
  const launcherPath = join(directory, "bin", "slack-desk-mcp");
  const mise = Bun.which("mise");
  expect(mise).toBeTruthy();
  try {
    const options = { repository: process.cwd(), mise: mise!, launcherPath };
    expect(await installMcpLauncher(options)).toBe(launcherPath);
    const script = await readFile(launcherPath, "utf8");
    expect(script).toContain("# Managed by SlackDeskBot task mcp:install");
    expect((await lstat(launcherPath)).mode & 0o111).not.toBe(0);
    expect(await installMcpLauncher(options)).toBe(launcherPath);
    expect(await readFile(launcherPath, "utf8")).toBe(script);

    const client = new Client({ name: "launcher-smoke", version: "1" });
    const transport = new StdioClientTransport({
      command: launcherPath,
      env: { HOME: homedir(), PATH: "/usr/bin:/bin" },
    });
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools.map(({ name }) => name).sort()).toEqual([
        "find_people",
        "send_dm",
      ]);
    } finally {
      await client.close();
    }

    await writeFile(launcherPath, "user-owned launcher\n");
    await expect(installMcpLauncher(options)).rejects.toThrow("unmanaged launcher");
    expect(await readFile(launcherPath, "utf8")).toBe("user-owned launcher\n");
  } finally {
    await unlink(launcherPath).catch(() => {});
    await rmdir(join(directory, "bin")).catch(() => {});
    await rmdir(directory);
  }
});
