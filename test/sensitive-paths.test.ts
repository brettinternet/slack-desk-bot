import { describe, expect, test } from "bun:test";
import {
  claudeSensitiveReadPermissions,
  isSensitiveRelativePath,
  sensitiveSeatbeltRegex,
} from "../src/sensitive-paths.ts";

const sensitivePaths = [
  ".env",
  ".env.local",
  ".env.example",
  ".env.sample",
  ".env.template",
  "nested/.env.production",
  "server.key",
  ".key",
  "certificates/client.pem",
  "identity.p12",
  "certificate.pfx",
  ".ssh/config",
  ".git/config",
  ".git/hooks/pre-commit",
  ".aws/credentials",
  ".config/gcloud/application_default_credentials.json",
  ".docker/config.json",
  ".slack-desk/identities.yaml",
  ".netrc",
  ".npmrc",
  ".pypirc",
  "auth.json",
  ".codex/config.toml",
  ".claude/settings.json",
  ".pi/agent/auth.json",
  "Library/Keychains/login.keychain-db",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
];

const publicPaths = [
  ".environment",
  "src/environment.ts",
  ["server", "key", "test.ts"].join("."),
  "id_ed25519.pub",
  ".env.d/settings.yaml",
  "credentials.ts",
  ".gitignore",
  ".github/workflows/ci.yaml",
];

function claudeDenies(path: string): boolean {
  return claudeSensitiveReadPermissions().some((permission) => {
    const glob = /^Read\((.*)\)$/.exec(permission)?.[1];
    return glob ? new Bun.Glob(glob).match(path) : false;
  });
}

describe("shared sensitive path rules", () => {
  test.each([...sensitivePaths, ...publicPaths])("all formatters agree for %s", (path) => {
    const expected = sensitivePaths.includes(path);
    const seatbeltDenies = new RegExp(sensitiveSeatbeltRegex("/workspace")).test(
      `/workspace/${path}`,
    );

    expect(isSensitiveRelativePath(path)).toBe(expected);
    expect(seatbeltDenies).toBe(expected);
    expect(claudeDenies(path)).toBe(expected);
  });
});
