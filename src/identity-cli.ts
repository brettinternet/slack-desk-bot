import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  defaultGlobalIdentityPath,
  GitSlackIdentityResolver,
  gitAuthors,
  linkIdentity,
  loadExplicitIdentities,
  loadSlackUsers,
  projectIdentityPath,
} from "./git-slack-identities.ts";

const execFileAsync = promisify(execFile);
export const IDENTITY_USAGE =
  "Usage: slack-desk identities scan | list | link <slack-user-id> <git-email> [--global]";

async function repositoryRoot(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "/usr/bin/git",
      ["-c", "safe.directory=*", "-C", cwd, "rev-parse", "--show-toplevel"],
      { encoding: "utf8" },
    );
    return stdout.trim();
  } catch {
    throw new Error("Identity commands must run inside a Git repository");
  }
}

export async function runIdentityCommand(
  args: readonly string[],
  options: { cwd?: string; botToken?: string; output?: (line: string) => void } = {},
): Promise<void> {
  const [command, ...rest] = args;
  const output = options.output ?? console.log;
  const repository = await repositoryRoot(options.cwd ?? process.cwd());

  if (command === "list") {
    if (rest.length > 0) throw new Error(IDENTITY_USAGE);
    const identities = [...loadExplicitIdentities(repository).entries()].sort();
    if (identities.length === 0) output("No explicit identity mappings configured.");
    for (const [email, slackUserId] of identities) output(`${email} → ${slackUserId}`);
    return;
  }

  if (command === "link") {
    const global = rest.includes("--global");
    const positional = rest.filter((value) => value !== "--global");
    if (positional.length !== 2) throw new Error(IDENTITY_USAGE);
    const [slackUserId, email] = positional as [string, string];
    const path = global ? defaultGlobalIdentityPath() : projectIdentityPath(repository);
    linkIdentity(path, slackUserId, email);
    output(`Linked ${email.toLowerCase()} → ${slackUserId} in ${path}`);
    return;
  }

  if (command === "scan") {
    if (rest.length > 0) throw new Error(IDENTITY_USAGE);
    const botToken = options.botToken?.trim();
    if (!botToken) throw new Error("SLACK_BOT_TOKEN is required to scan Slack identities");
    // Fail visibly for missing scopes or authentication instead of reporting every author unresolved.
    const slackUsers = await loadSlackUsers(botToken);
    const resolver = new GitSlackIdentityResolver(async () => slackUsers);
    const authors = await gitAuthors(repository);
    if (authors.length === 0) output("No commit authors found.");
    for (const author of authors) {
      const identity = await resolver.resolve(repository, author.email);
      output(
        identity
          ? `${author.name} <${author.email}> → ${identity.slackName ?? identity.slackUserId} (${identity.slackUserId}, ${identity.source})`
          : `${author.name} <${author.email}> → unresolved`,
      );
    }
    return;
  }

  throw new Error(IDENTITY_USAGE);
}
