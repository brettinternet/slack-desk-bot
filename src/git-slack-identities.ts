import { execFile } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { WebClient } from "@slack/web-api";

const execFileAsync = promisify(execFile);
const MAX_IDENTITY_FILE_BYTES = 256 * 1024;
const SLACK_USER_ID = /^[UW][A-Z0-9]+$/;
export const PROJECT_IDENTITY_PATH = ".slack-desk/identities.yaml";

export interface GitSlackIdentity {
  slackUserId: string;
  gitEmail: string;
  source: "explicit" | "email";
  slackName?: string;
}

interface IdentityFile {
  version: 1;
  users: Record<string, { git_emails: string[] }>;
}

interface SlackDirectoryUser {
  id: string;
  email?: string;
  name?: string;
}

export type SlackUserLoader = () => Promise<readonly SlackDirectoryUser[]>;

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function emptyIdentityFile(): IdentityFile {
  return { version: 1, users: {} };
}

function parseIdentityFile(path: string): IdentityFile {
  if (!existsSync(path)) return emptyIdentityFile();
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > MAX_IDENTITY_FILE_BYTES) {
    throw new Error(`Identity config must be a regular file no larger than 256 KiB: ${path}`);
  }
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`Identity config is not valid YAML: ${path}`);
  }
  if (!parsed || typeof parsed !== "object" || (parsed as { version?: unknown }).version !== 1) {
    throw new Error(`Identity config must have version: 1: ${path}`);
  }
  const users = (parsed as { users?: unknown }).users;
  if (!users || typeof users !== "object" || Array.isArray(users)) {
    throw new Error(`Identity config must contain a users map: ${path}`);
  }
  const result = emptyIdentityFile();
  for (const [slackUserId, entry] of Object.entries(users)) {
    if (!SLACK_USER_ID.test(slackUserId) || !entry || typeof entry !== "object") {
      throw new Error(`Identity config contains an invalid Slack user ID: ${path}`);
    }
    const emails = (entry as { git_emails?: unknown }).git_emails;
    if (
      !Array.isArray(emails) ||
      emails.some((email) => typeof email !== "string" || !email.trim())
    ) {
      throw new Error(`Identity config contains invalid git_emails for ${slackUserId}: ${path}`);
    }
    result.users[slackUserId] = { git_emails: [...new Set(emails.map(normalizeEmail))].sort() };
  }
  return result;
}

export function defaultGlobalIdentityPath(): string {
  return join(homedir(), ".config", "slack-desk", "identities.yaml");
}

export function projectIdentityPath(repository: string): string {
  return join(repository, PROJECT_IDENTITY_PATH);
}

export function loadExplicitIdentities(
  repository: string,
  globalPath = defaultGlobalIdentityPath(),
): Map<string, string> {
  const byEmail = new Map<string, string>();
  for (const path of [globalPath, projectIdentityPath(repository)]) {
    const config = parseIdentityFile(path);
    for (const [slackUserId, entry] of Object.entries(config.users)) {
      for (const email of entry.git_emails) byEmail.set(email, slackUserId);
    }
  }
  return byEmail;
}

export function linkIdentity(path: string, slackUserId: string, gitEmail: string): void {
  if (!SLACK_USER_ID.test(slackUserId)) throw new Error("Slack user ID must start with U or W");
  const email = normalizeEmail(gitEmail);
  if (!email || !email.includes("@") || /[\r\n]/.test(email)) throw new Error("Invalid Git email");
  const config = parseIdentityFile(path);
  for (const entry of Object.values(config.users)) {
    entry.git_emails = entry.git_emails.filter((existing) => existing !== email);
  }
  const entry = (config.users[slackUserId] ??= { git_emails: [] });
  entry.git_emails = [...new Set([...entry.git_emails, email])].sort();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, Bun.YAML.stringify(config), { encoding: "utf8", mode: 0o600 });
}

export async function loadSlackUsers(botToken: string): Promise<SlackDirectoryUser[]> {
  const client = new WebClient(botToken);
  const users: SlackDirectoryUser[] = [];
  let cursor: string | undefined;
  do {
    const response = await client.users.list({ limit: 200, ...(cursor ? { cursor } : {}) });
    for (const member of response.members ?? []) {
      if (!member.id || member.deleted || member.is_bot || member.is_app_user) continue;
      users.push({
        id: member.id,
        email: member.profile?.email,
        name: member.profile?.display_name || member.real_name || member.name,
      });
    }
    cursor = response.response_metadata?.next_cursor?.trim() || undefined;
  } while (cursor);
  return users;
}

export class GitSlackIdentityResolver {
  private slackUsers?: Promise<readonly SlackDirectoryUser[]>;

  constructor(
    private readonly loadUsers: SlackUserLoader,
    private readonly globalPath = defaultGlobalIdentityPath(),
  ) {}

  async resolve(repository: string, gitEmail: string): Promise<GitSlackIdentity | undefined> {
    const email = normalizeEmail(gitEmail);
    let explicitId: string | undefined;
    try {
      explicitId = loadExplicitIdentities(repository, this.globalPath).get(email);
    } catch {
      // A malformed local file must not let repository contents disable Git inspection.
    }
    if (explicitId) {
      const user = (await this.users().catch(() => [])).find(({ id }) => id === explicitId);
      return {
        slackUserId: explicitId,
        gitEmail: email,
        source: "explicit",
        slackName: user?.name,
      };
    }

    const matches = (await this.users().catch(() => [])).filter(
      (user) => user.email && normalizeEmail(user.email) === email,
    );
    if (matches.length !== 1) return undefined;
    return {
      slackUserId: matches[0]!.id,
      gitEmail: email,
      source: "email",
      slackName: matches[0]!.name,
    };
  }

  private users(): Promise<readonly SlackDirectoryUser[]> {
    return (this.slackUsers ??= this.loadUsers().catch((error: unknown) => {
      this.slackUsers = undefined;
      throw error;
    }));
  }
}

export async function gitAuthors(
  repository: string,
): Promise<Array<{ name: string; email: string }>> {
  const { stdout } = await execFileAsync(
    "/usr/bin/git",
    [
      "-c",
      `safe.directory=${repository}`,
      "-C",
      repository,
      "shortlog",
      "--summary",
      "--numbered",
      "--email",
      "--all",
    ],
    { encoding: "utf8", maxBuffer: 1024 * 1024 },
  );
  const authors = new Map<string, { name: string; email: string }>();
  for (const line of stdout.split("\n")) {
    const match = /^\s*\d+\s+(.+) <([^<>]+)>$/.exec(line);
    if (!match) continue;
    const [, name, rawEmail] = match;
    const email = normalizeEmail(rawEmail!);
    authors.set(email, { name: name!, email });
  }
  return [...authors.values()].sort((left, right) => left.email.localeCompare(right.email));
}
