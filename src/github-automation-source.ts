import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AutomationSource, Observation } from "./automations.ts";
import { writeStructuredLog } from "./log.ts";

const run = promisify(execFile);
const TARGET = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9_.-]{1,100})#([1-9]\d{0,8})$/;

export interface GitHubLookup {
  get(endpoint: string): Promise<unknown>;
}

/** Use the service owner's gh login, never inherited token overrides or an interactive prompt. */
export function ghEnvironment(inherited: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...inherited,
    GH_HOST: "github.com",
    GH_PROMPT_DISABLED: "1",
  };
  delete environment.GH_TOKEN;
  delete environment.GITHUB_TOKEN;
  delete environment.GH_ENTERPRISE_TOKEN;
  delete environment.GITHUB_ENTERPRISE_TOKEN;
  return environment;
}

export async function checkGithubReadiness(): Promise<string> {
  try {
    await run("gh", ["auth", "status", "--hostname", "github.com"], {
      env: ghEnvironment(),
      timeout: 30_000,
      maxBuffer: 1_000_000,
    });
    return "GitHub CLI is authenticated for the service owner";
  } catch {
    throw new Error("GitHub watches require gh authenticated for github.com as the service owner");
  }
}

/** The service owns this lookup; Pi receives neither a shell tool nor gh credentials. */
export function githubCliLookup(): GitHubLookup {
  return {
    async get(endpoint) {
      try {
        const { stdout } = await run("gh", ["api", "--hostname", "github.com", endpoint], {
          env: ghEnvironment(),
          timeout: 30_000,
          maxBuffer: 1_000_000,
        });
        return JSON.parse(stdout);
      } catch (error) {
        // gh diagnostics can include sensitive response content. Log only the bounded process code.
        const code = (error as NodeJS.ErrnoException).code;
        writeStructuredLog({
          event: "operator_error",
          component: "automations",
          message: "GitHub lookup failed",
          error_type:
            code === "ENOENT"
              ? "GitHubCliUnavailable"
              : code === "ETIMEDOUT"
                ? "GitHubCliTimeout"
                : typeof code === "number"
                  ? `GitHubCliExit${code}`
                  : "GitHubLookupError",
        });
        throw new Error(
          "GitHub lookup failed; verify the service owner's gh login and repository access",
        );
      }
    },
  };
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid GitHub response");
  return value as Record<string, unknown>;
}

export function githubSources(
  lookup: GitHubLookup,
  allowedRepos: readonly string[],
): Record<string, AutomationSource> {
  const allowed = new Set(allowedRepos.map((repo) => repo.toLowerCase()));
  function parse(id: string) {
    const match = TARGET.exec(id);
    if (!match || !allowed.has(`${match[1]}/${match[2]}`.toLowerCase()))
      throw new Error("Invalid or unapproved GitHub repository target");
    return { owner: match[1]!, repo: match[2]!, number: Number(match[3]) };
  }
  async function read(id: string, kind: "pulls" | "issues"): Promise<Observation> {
    const { owner, repo, number } = parse(id);
    const repository = object(await lookup.get(`repos/${owner}/${repo}`));
    if (
      typeof repository.full_name !== "string" ||
      repository.full_name.toLowerCase() !== `${owner}/${repo}`.toLowerCase() ||
      object(repository.owner).type !== "Organization"
    )
      throw new Error("GitHub target must belong to an approved organization repository");
    const value = object(await lookup.get(`repos/${owner}/${repo}/${kind}/${number}`));
    const url = `https://github.com/${owner}/${repo}/${kind === "pulls" ? "pull" : "issues"}/${number}`;
    if (
      value.number !== number ||
      typeof value.html_url !== "string" ||
      value.html_url.toLowerCase() !== url.toLowerCase() ||
      (value.state !== "open" && value.state !== "closed")
    )
      throw new Error("Invalid GitHub target response");
    if (kind === "issues") {
      if (value.pull_request !== undefined)
        throw new Error("Target is a pull request, not an issue");
      return { fields: { state: value.state }, url };
    }
    if (
      value.merged_at !== null &&
      (typeof value.merged_at !== "string" || !Number.isFinite(Date.parse(value.merged_at)))
    )
      throw new Error("Invalid GitHub PR response");
    if (value.merged_at !== null && value.state !== "closed")
      throw new Error("Invalid GitHub PR response");
    return { fields: { merged: value.merged_at === null ? "false" : "true" }, url };
  }
  return {
    "github-pr": {
      fields: ["merged"],
      validId: (id) => TARGET.test(id) && allowed.has(id.slice(0, id.indexOf("#")).toLowerCase()),
      validCondition: (field, equals) => field === "merged" && equals === "true",
      read: (id) => read(id, "pulls"),
    },
    "github-issue": {
      fields: ["state"],
      validId: (id) => TARGET.test(id) && allowed.has(id.slice(0, id.indexOf("#")).toLowerCase()),
      validCondition: (field, equals) => field === "state" && equals === "closed",
      read: (id) => read(id, "issues"),
    },
  };
}
