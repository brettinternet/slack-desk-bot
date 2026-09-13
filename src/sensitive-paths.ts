import { sep } from "node:path";

export type SensitivePathRule =
  | { kind: "directory"; path: string }
  | { kind: "basename"; name: string }
  | { kind: "path-suffix"; path: string }
  | { kind: "basename-prefix"; prefix: string }
  | { kind: "extension"; extension: string };

/** Sensitive workspace paths. Every enforcement layer is derived from this table. */
export const SENSITIVE_PATH_RULES: readonly SensitivePathRule[] = [
  { kind: "directory", path: ".ssh" },
  { kind: "directory", path: ".git" },
  { kind: "directory", path: ".codex" },
  { kind: "directory", path: ".claude" },
  { kind: "directory", path: ".pi/agent" },
  { kind: "directory", path: "Library/Keychains" },
  { kind: "basename", name: "auth.json" },
  { kind: "basename", name: ".netrc" },
  { kind: "basename", name: ".npmrc" },
  { kind: "basename", name: ".pypirc" },
  { kind: "basename", name: "id_rsa" },
  { kind: "basename", name: "id_dsa" },
  { kind: "basename", name: "id_ecdsa" },
  { kind: "basename", name: "id_ed25519" },
  { kind: "path-suffix", path: ".aws/credentials" },
  { kind: "path-suffix", path: "gcloud/application_default_credentials.json" },
  { kind: "path-suffix", path: ".docker/config.json" },
  { kind: "basename-prefix", prefix: ".env" },
  { kind: "extension", extension: ".key" },
  { kind: "extension", extension: ".pem" },
  { kind: "extension", extension: ".p12" },
  { kind: "extension", extension: ".pfx" },
];

function normalizedParts(path: string): string[] {
  return path
    .split(sep)
    .flatMap((part) => part.split("/"))
    .filter(Boolean)
    .map((part) => part.toLowerCase());
}

/** Structured predicate used by the Pi workspace policy. */
export function isSensitiveRelativePath(path: string): boolean {
  const parts = normalizedParts(path);
  const name = parts.at(-1);
  if (!name) return false;
  const normalizedPath = parts.join("/");

  return SENSITIVE_PATH_RULES.some((rule) => {
    switch (rule.kind) {
      case "directory": {
        const directory = rule.path.toLowerCase();
        return (
          normalizedPath === directory ||
          normalizedPath.includes(`/${directory}/`) ||
          normalizedPath.endsWith(`/${directory}`) ||
          normalizedPath.startsWith(`${directory}/`)
        );
      }
      case "basename":
        return name === rule.name.toLowerCase();
      case "path-suffix": {
        const suffix = rule.path.toLowerCase();
        return normalizedPath === suffix || normalizedPath.endsWith(`/${suffix}`);
      }
      case "basename-prefix": {
        const prefix = rule.prefix.toLowerCase();
        return name === prefix || name.startsWith(`${prefix}.`);
      }
      case "extension":
        return name.endsWith(rule.extension.toLowerCase());
    }
  });
}

function escapedRegex(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");
}

/** Seatbelt regex fragment rooted at the configured workspace. */
export function sensitiveSeatbeltRegex(workspace: string): string {
  const root = escapedRegex(workspace);
  const patterns = SENSITIVE_PATH_RULES.map((rule) => {
    switch (rule.kind) {
      case "directory":
        return `(.*/)?${escapedRegex(rule.path)}(/|$)`;
      case "basename":
        return `(.*/)?${escapedRegex(rule.name)}$`;
      case "path-suffix":
        return `(.*/)?${escapedRegex(rule.path)}$`;
      case "basename-prefix":
        // `[^/]*` keeps the suffix inside one path segment so a directory such
        // as `.env.d/` is not denied when the structured predicate allows it.
        return `(.*/)?${escapedRegex(rule.prefix)}(\\.[^/]*)?$`;
      case "extension":
        return `(.*/)?[^/]*${escapedRegex(rule.extension)}$`;
    }
  });
  return `${root}/(${patterns.join("|")})`;
}

function rootAndNested(path: string): string[] {
  return [path, `**/${path}`];
}

/** Claude Code Read permission globs for the shared sensitive path table. */
export function claudeSensitiveReadPermissions(): string[] {
  const globs = SENSITIVE_PATH_RULES.flatMap((rule): string[] => {
    switch (rule.kind) {
      case "directory":
        return rootAndNested(rule.path).flatMap((path) => [path, `${path}/**`]);
      case "basename":
      case "path-suffix":
        return rootAndNested(rule.kind === "basename" ? rule.name : rule.path);
      case "basename-prefix":
        return rootAndNested(rule.prefix).concat(rootAndNested(`${rule.prefix}.*`));
      case "extension":
        return [`*${rule.extension}`, `**/*${rule.extension}`];
    }
  });
  return [...new Set(globs)].map((glob) => `Read(${glob})`);
}
