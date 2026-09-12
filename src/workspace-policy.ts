import { lstatSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";

const PATH_TOOLS = new Set(["read", "grep", "find", "ls", "edit", "write"]);
const ALLOWED_ENV_TEMPLATES = new Set([".env.example", ".env.sample", ".env.template"]);
const PRIVATE_KEY_NAMES = new Set(["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"]);
const SENSITIVE_FILES = new Set([".netrc", ".npmrc", ".pypirc"]);

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/** Mirror Pi's tool path normalization so the policy judges the path the tool will actually open. */
function toolPath(path: string): string {
  let normalized = path.replace(UNICODE_SPACES, " ");
  if (normalized.startsWith("@")) normalized = normalized.slice(1);
  if (normalized === "~") return homedir();
  if (normalized.startsWith("~/")) return join(homedir(), normalized.slice(2));
  if (/^file:\/\//.test(normalized)) {
    try {
      return fileURLToPath(normalized);
    } catch {
      return normalized;
    }
  }
  return normalized;
}

function isSensitiveRelativePath(path: string): boolean {
  const parts = path
    .split(sep)
    .filter(Boolean)
    .map((part) => part.toLowerCase());
  const name = parts.at(-1);
  if (!name) return false;

  if (parts.includes(".ssh") || parts.includes(".git")) return true;
  if (name === "credentials" && parts.includes(".aws")) return true;
  if (name === "application_default_credentials.json" && parts.includes("gcloud")) return true;
  if (name === "config.json" && parts.includes(".docker")) return true;
  if (SENSITIVE_FILES.has(name) || PRIVATE_KEY_NAMES.has(name)) return true;
  if (name === ".env" || (name.startsWith(".env.") && !ALLOWED_ENV_TEMPLATES.has(name))) {
    return true;
  }
  return /\.(?:key|pem|p12|pfx)$/.test(name);
}

function canonicalTarget(path: string, workspace: string): string | undefined {
  const absolutePath = isAbsolute(path) ? path : resolve(workspace, path);
  let existingPath = absolutePath;
  while (!lstatSync(existingPath, { throwIfNoEntry: false })) {
    const parent = dirname(existingPath);
    if (parent === existingPath) return undefined;
    existingPath = parent;
  }

  try {
    return resolve(realpathSync(existingPath), relative(existingPath, absolutePath));
  } catch {
    return undefined;
  }
}

export function isPathInWorkspace(path: string, workspace: string): boolean {
  const canonicalPath = canonicalTarget(toolPath(path), workspace);
  if (!canonicalPath) return false;
  const relativePath = relative(realpathSync(workspace), canonicalPath);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

export function isSensitiveWorkspacePath(path: string, workspace: string): boolean {
  const normalizedPath = toolPath(path);
  const absolutePath = isAbsolute(normalizedPath)
    ? normalizedPath
    : resolve(workspace, normalizedPath);
  const canonicalWorkspace = realpathSync(workspace);
  const requestedRelativePath = relative(canonicalWorkspace, absolutePath);
  if (
    !requestedRelativePath.startsWith("..") &&
    !isAbsolute(requestedRelativePath) &&
    isSensitiveRelativePath(requestedRelativePath)
  ) {
    return true;
  }

  const canonicalPath = canonicalTarget(normalizedPath, workspace);
  if (!canonicalPath) return false;
  const canonicalRelativePath = relative(canonicalWorkspace, canonicalPath);
  return (
    !canonicalRelativePath.startsWith("..") &&
    !isAbsolute(canonicalRelativePath) &&
    isSensitiveRelativePath(canonicalRelativePath)
  );
}

interface FilteredToolOutput {
  text: string;
  blocked: boolean;
}

export function filterSensitiveToolOutput(
  toolName: string,
  input: { path?: unknown },
  text: string,
  workspace: string,
): FilteredToolOutput {
  if (toolName !== "grep" && toolName !== "find" && toolName !== "ls") {
    return { text, blocked: false };
  }

  const inputPath = typeof input.path === "string" ? toolPath(input.path) : ".";
  const searchPath = isAbsolute(inputPath) ? inputPath : resolve(workspace, inputPath);
  let resultRoot = searchPath;
  if (toolName === "grep") {
    try {
      if (!statSync(searchPath).isDirectory()) resultRoot = dirname(searchPath);
    } catch {
      return { text, blocked: false };
    }
  }

  let blocked = false;
  const lines = text.split("\n").filter((line) => {
    let reportedPath: string | undefined;
    if (toolName === "grep") {
      reportedPath = /^(.*?)(?::\d+: |-\d+- )/.exec(line)?.[1];
    } else if (
      line &&
      !line.startsWith("[") &&
      !line.startsWith("No ") &&
      line !== "(empty directory)"
    ) {
      reportedPath = line.endsWith("/") ? line.slice(0, -1) : line;
    }
    if (!reportedPath || !isSensitiveWorkspacePath(resolve(resultRoot, reportedPath), workspace)) {
      return true;
    }
    blocked = true;
    return false;
  });

  const filtered = lines.join("\n").trim();
  return {
    text: filtered || (blocked ? "Sensitive path results were blocked." : text),
    blocked,
  };
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
        if (isSensitiveWorkspacePath(path, workspace)) {
          return { block: true, reason: "Access to sensitive workspace paths is blocked" };
        }
      });
      pi.on("tool_result", (event) => {
        if (!PATH_TOOLS.has(event.toolName)) return;
        const input = event.input as { path?: unknown };
        let blocked = false;
        const content = event.content.map((item) => {
          if (item.type !== "text") return item;
          const filtered = filterSensitiveToolOutput(event.toolName, input, item.text, workspace);
          blocked ||= filtered.blocked;
          return { ...item, text: filtered.text };
        });
        return blocked ? { content } : undefined;
      });
    },
  };
}
