import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
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
});
