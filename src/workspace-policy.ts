import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";

const PATH_TOOLS = new Set(["read", "grep", "find", "ls", "edit", "write"]);

export function isPathInWorkspace(path: string, workspace: string): boolean {
  const absolutePath = isAbsolute(path) ? path : resolve(workspace, path);
  let existingPath = absolutePath;
  while (!existsSync(existingPath)) {
    const parent = dirname(existingPath);
    if (parent === existingPath) return false;
    existingPath = parent;
  }

  const canonicalWorkspace = realpathSync(workspace);
  const canonicalExistingPath = realpathSync(existingPath);
  const relativePath = relative(canonicalWorkspace, canonicalExistingPath);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

export function workspacePolicy(workspace: string): InlineExtension {
  return {
    name: "slack-workspace-policy",
    factory: (pi) => {
      pi.on("tool_call", (event) => {
        if (!PATH_TOOLS.has(event.toolName)) return;
        const input = event.input as { path?: unknown };
        const path = typeof input.path === "string" ? input.path : ".";
        if (!isPathInWorkspace(path, workspace)) {
          return { block: true, reason: `Path is outside the configured workspace: ${path}` };
        }
      });
    },
  };
}
