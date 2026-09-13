import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seatbeltProfile } from "../src/seatbelt.ts";

const darwinOnly = test.skipIf(process.platform !== "darwin");

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "slack-desk-seatbelt-"));
  const workspace = join(root, "workspace");
  const home = join(root, "home");
  mkdirSync(workspace);
  mkdirSync(home);
  writeFileSync(join(workspace, "public.txt"), "public");
  writeFileSync(join(workspace, ".env"), "secret");
  writeFileSync(join(workspace, "auth.json"), "secret");
  for (const directory of [".codex", ".claude", ".pi/agent", "Library/Keychains"]) {
    mkdirSync(join(workspace, directory), { recursive: true });
    writeFileSync(join(workspace, directory, "secret"), "secret");
  }
  writeFileSync(join(root, "outside.txt"), "outside");
  writeFileSync(join(home, "auth.json"), "token");
  return { root, workspace, home };
}

function runUnderProfile(profile: string, cwd: string, script: string): string {
  const path = join(cwd, "profile.sb");
  writeFileSync(path, profile);
  return execFileSync("/usr/bin/sandbox-exec", ["-f", path, "/bin/sh", "-c", script], {
    cwd,
    encoding: "utf8",
  });
}

function which(command: string): string | undefined {
  try {
    return realpathSync(execFileSync("/usr/bin/which", [command], { encoding: "utf8" }).trim());
  } catch {
    return undefined;
  }
}

describe("shared Seatbelt boundary", () => {
  darwinOnly("confines reads and writes while keeping the backend home usable", () => {
    const { root, workspace, home } = fixture();
    try {
      const profile = seatbeltProfile({ workspace, home, executable: "/usr/bin/true" });
      const output = runUnderProfile(
        profile,
        workspace,
        [
          "cat public.txt",
          "cat ../outside.txt 2>/dev/null || echo outside-blocked",
          "cat .env 2>/dev/null || echo credential-blocked",
          "cat auth.json 2>/dev/null || echo auth-blocked",
          "cat .codex/secret 2>/dev/null || echo codex-blocked",
          "cat .claude/secret 2>/dev/null || echo claude-blocked",
          "cat .pi/agent/secret 2>/dev/null || echo pi-agent-blocked",
          "cat Library/Keychains/secret 2>/dev/null || echo keychain-blocked",
          `cat ${home}/auth.json >/dev/null 2>&1 && echo home-readable || echo home-blocked`,
          "touch write-test 2>/dev/null || echo write-blocked",
          `touch ${home}/state 2>/dev/null && echo home-writable || echo home-write-blocked`,
        ].join("; "),
      );
      expect(output).toContain("public");
      expect(output).toContain("outside-blocked");
      expect(output).toContain("credential-blocked");
      expect(output).toContain("auth-blocked");
      expect(output).toContain("codex-blocked");
      expect(output).toContain("claude-blocked");
      expect(output).toContain("pi-agent-blocked");
      expect(output).toContain("keychain-blocked");
      expect(output).toContain("home-readable");
      expect(output).toContain("write-blocked");
      expect(output).toContain("home-writable");
      expect(output).not.toContain("outside\n");
      expect(output).not.toContain("secret");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  darwinOnly("allows workspace writes only when requested", () => {
    const { root, workspace, home } = fixture();
    try {
      const output = runUnderProfile(
        seatbeltProfile({
          workspace,
          home,
          executable: "/usr/bin/true",
          allowWorkspaceWrite: true,
        }),
        workspace,
        "touch allowed && echo wrote; touch ../outside-write 2>/dev/null || echo outside-write-blocked; touch .env 2>/dev/null || echo credential-write-blocked",
      );
      expect(output).toContain("wrote");
      expect(output).toContain("outside-write-blocked");
      expect(output).toContain("credential-write-blocked");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  darwinOnly("grants extra write paths a CLI needs for its own runtime state", () => {
    const { root, workspace, home } = fixture();
    const runtime = join(realpathSync(root), "runtime");
    mkdirSync(runtime);
    try {
      const output = runUnderProfile(
        seatbeltProfile({
          workspace,
          home,
          executable: "/usr/bin/true",
          extraWritePaths: [runtime],
        }),
        workspace,
        `touch ${runtime}/socket && echo runtime-writable || echo runtime-blocked`,
      );
      expect(output).toContain("runtime-writable");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Regression: denying `file-read*` (rather than only `file-read-data`)
  // outside the allowlist also denied path metadata, so Codex and Claude could
  // not canonicalize their own home directory and refused to start at all.
  darwinOnly("permits path metadata outside the allowlist while denying contents", () => {
    const { root, workspace, home } = fixture();
    try {
      const output = runUnderProfile(
        seatbeltProfile({ workspace, home, executable: "/usr/bin/true" }),
        workspace,
        [
          `/bin/ls -di / /Users ${root} >/dev/null && echo metadata-ok || echo metadata-blocked`,
          `/usr/bin/readlink -f ${home}`,
          "cat ../outside.txt 2>/dev/null || echo content-blocked",
        ].join("; "),
      );
      expect(output).toContain("metadata-ok");
      expect(output).toContain(realpathSync(home));
      expect(output).toContain("content-blocked");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  for (const command of ["codex", "claude"]) {
    const executable = which(command);
    test.skipIf(process.platform !== "darwin" || !executable || !existsSync(executable))(
      `lets the real ${command} executable start`,
      () => {
        const { root, workspace, home } = fixture();
        try {
          const path = join(root, "profile.sb");
          writeFileSync(
            path,
            seatbeltProfile({
              workspace,
              home,
              executable: executable!,
              extraWritePaths: [`/private/tmp/claude-${process.getuid?.() ?? 0}`],
            }),
          );
          const version = execFileSync(
            "/usr/bin/sandbox-exec",
            ["-f", path, executable!, "--version"],
            {
              cwd: workspace,
              encoding: "utf8",
              timeout: 30_000,
              env: { PATH: process.env.PATH ?? "", HOME: home, TMPDIR: home },
            },
          );
          expect(version.trim()).not.toBe("");
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      },
    );
  }
});
