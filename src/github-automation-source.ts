import type { AutomationSource, Observation } from "./automations.ts";
import {
  approvedRepository,
  assertOrganizationRepository,
  type GitHubLookup,
  githubObject as object,
} from "./github-client.ts";

const TARGET = /^([^#]+)#([1-9]\d{0,8})$/;

export function githubSources(
  lookup: GitHubLookup,
  allowedRepos: readonly string[],
): Record<string, AutomationSource> {
  function parse(id: string) {
    const match = TARGET.exec(id);
    const repository = match ? approvedRepository(match[1]!, allowedRepos) : undefined;
    if (!match || !repository) throw new Error("Invalid or unapproved GitHub repository target");
    return { owner: repository.owner, repo: repository.name, number: Number(match[2]) };
  }
  function validId(id: string): boolean {
    const match = TARGET.exec(id);
    return Boolean(match && approvedRepository(match[1]!, allowedRepos));
  }
  async function read(id: string, kind: "pulls" | "issues"): Promise<Observation> {
    const { owner, repo, number } = parse(id);
    assertOrganizationRepository(await lookup.get(`repos/${owner}/${repo}`), `${owner}/${repo}`);
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
      validId,
      validCondition: (field, equals) => field === "merged" && equals === "true",
      read: (id) => read(id, "pulls"),
    },
    "github-issue": {
      fields: ["state"],
      validId,
      validCondition: (field, equals) => field === "state" && equals === "closed",
      read: (id) => read(id, "issues"),
    },
  };
}
