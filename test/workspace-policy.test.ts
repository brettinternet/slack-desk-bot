import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  filterSensitiveToolOutput,
  isPathInWorkspace,
  isSensitiveWorkspacePath,
  workspacePolicy,
} from "../src/workspace-policy.ts";

const workspace = process.cwd();

describe("workspace policy", () => {
  test("blocks every tool outside the service allowlist", async () => {
    let toolCall: ((event: { toolName: string; input: unknown }) => unknown) | undefined;
    const policy = workspacePolicy(workspace, ["read"]);
    if (typeof policy === "function") throw new Error("Expected a named policy extension");
    await policy.factory({
      on: (eventName: string, handler: typeof toolCall) => {
        if (eventName === "tool_call") toolCall = handler;
      },
    } as never);

    expect(toolCall?.({ toolName: "read", input: { path: "README.md" } })).toBeUndefined();
    expect(toolCall?.({ toolName: "write", input: { path: "output.txt" } })).toEqual({
      block: true,
      reason: "Tool is not allowed for the Slack service: write",
    });
    expect(toolCall?.({ toolName: "extension_shell", input: {} })).toEqual({
      block: true,
      reason: "Tool is not allowed for the Slack service: extension_shell",
    });
  });

  test("allows existing and prospective paths inside the workspace", () => {
    expect(isPathInWorkspace("package.json", workspace)).toBe(true);
    expect(isPathInWorkspace("future/directory/file.ts", workspace)).toBe(true);
    expect(isPathInWorkspace(resolve(workspace, "src/index.ts"), workspace)).toBe(true);
  });

  test("blocks relative and absolute paths outside the workspace", () => {
    expect(isPathInWorkspace("../outside.txt", workspace)).toBe(false);
    expect(isPathInWorkspace("/etc/passwd", workspace)).toBe(false);
  });

  test("normalizes paths the same way Pi's tools do before checking them", () => {
    for (const path of ["~", "~/.ssh/id_rsa", "@~/.ssh/id_rsa", "file:///etc/passwd"]) {
      expect(isPathInWorkspace(path, workspace), path).toBe(false);
    }
    expect(isPathInWorkspace(`file://${resolve(workspace, "package.json")}`, workspace)).toBe(true);
    expect(isPathInWorkspace("@package.json", workspace)).toBe(true);
    expect(isSensitiveWorkspacePath("secrets\u00A0dir/.env", workspace)).toBe(true);
  });

  test("blocks documented sensitive paths and allows near-matches", () => {
    const sensitivePaths = [
      ".env",
      ".env.local",
      "nested/.env.production",
      "server.key",
      "certificates/client.pem",
      "identity.p12",
      ".ssh/config",
      ".git/config",
      ".git/hooks/pre-commit",
      ".aws/credentials",
      ".config/gcloud/application_default_credentials.json",
      ".docker/config.json",
      ".npmrc",
      "auth.json",
      ".codex/config.toml",
      ".claude/settings.json",
      ".pi/agent/auth.json",
      "Library/Keychains/login.keychain-db",
      "id_ed25519",
    ];
    for (const path of sensitivePaths) {
      expect(isSensitiveWorkspacePath(path, workspace), path).toBe(true);
      expect(isSensitiveWorkspacePath(resolve(workspace, path), workspace), path).toBe(true);
    }

    for (const path of [
      ".environment",
      "src/environment.ts",
      "server.key.test.ts",
      "id_ed25519.pub",
      "credentials.ts",
      ".gitignore",
      ".github/workflows/ci.yaml",
    ]) {
      expect(isSensitiveWorkspacePath(path, workspace), path).toBe(false);
    }
  });

  test("filters sensitive entries from recursive discovery tool results", () => {
    expect(
      filterSensitiveToolOutput(
        "grep",
        { path: "." },
        ".env:1: SECRET=:2: value\nsrc/index.ts:2: safe\nserver.key-2- private",
        workspace,
      ),
    ).toEqual({ text: "src/index.ts:2: safe", blocked: true });
    expect(
      filterSensitiveToolOutput(
        "find",
        { path: "." },
        ".env\nsrc/index.ts\ncertificates/client.pem",
        workspace,
      ),
    ).toEqual({ text: "src/index.ts", blocked: true });
    expect(
      filterSensitiveToolOutput("ls", { path: "." }, ".ssh/\nsrc/\n.env.example", workspace),
    ).toEqual({ text: "src/", blocked: true });
  });

  test("filters grep output reached through a benign symlink name", () => {
    const temporaryWorkspace = mkdtempSync(join(tmpdir(), "slack-agent-result-policy-"));
    const secret = join(temporaryWorkspace, ".env");
    const alias = join(temporaryWorkspace, "settings");
    writeFileSync(secret, "SECRET=value");
    symlinkSync(secret, alias);

    try {
      expect(
        filterSensitiveToolOutput(
          "grep",
          { path: temporaryWorkspace },
          "settings:1: SECRET=value",
          temporaryWorkspace,
        ),
      ).toEqual({ text: "Sensitive path results were blocked.", blocked: true });
    } finally {
      unlinkSync(alias);
      unlinkSync(secret);
      rmdirSync(temporaryWorkspace);
    }
  });

  test("blocks aliases and prospective descendants of sensitive paths", () => {
    const temporaryWorkspace = mkdtempSync(join(tmpdir(), "slack-agent-sensitive-policy-"));
    const nested = join(temporaryWorkspace, "nested");
    const secret = join(nested, ".env");
    const alias = join(temporaryWorkspace, "settings");
    mkdirSync(nested);
    writeFileSync(secret, "SECRET=value");
    symlinkSync(secret, alias);

    try {
      expect(isSensitiveWorkspacePath(alias, temporaryWorkspace)).toBe(true);
      expect(isSensitiveWorkspacePath(".ssh/future-key", temporaryWorkspace)).toBe(true);
    } finally {
      unlinkSync(alias);
      unlinkSync(secret);
      rmdirSync(nested);
      rmdirSync(temporaryWorkspace);
    }
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
