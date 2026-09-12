import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmdirSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isPathInWorkspace } from "../src/workspace-policy.ts";

const workspace = process.cwd();

describe("workspace policy", () => {
  test("allows existing and prospective paths inside the workspace", () => {
    expect(isPathInWorkspace("package.json", workspace)).toBe(true);
    expect(isPathInWorkspace("future/directory/file.ts", workspace)).toBe(true);
    expect(isPathInWorkspace(resolve(workspace, "src/index.ts"), workspace)).toBe(true);
  });

  test("blocks relative and absolute paths outside the workspace", () => {
    expect(isPathInWorkspace("../outside.txt", workspace)).toBe(false);
    expect(isPathInWorkspace("/etc/passwd", workspace)).toBe(false);
  });

  test("blocks broken symlinks that point outside the workspace", () => {
    const temporaryWorkspace = mkdtempSync(join(tmpdir(), "slack-agent-policy-"));
    const symlink = join(temporaryWorkspace, "escape");
    symlinkSync(join(tmpdir(), `slack-agent-missing-${randomUUID()}`), symlink);

    try {
      expect(isPathInWorkspace(symlink, temporaryWorkspace)).toBe(false);
    } finally {
      unlinkSync(symlink);
      rmdirSync(temporaryWorkspace);
    }
  });
});
