import { execFile } from "node:child_process";
import { writeStructuredLog } from "./log.ts";

const REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const REPOSITORY = /^([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9_.-]{1,100})$/;

export type GitHubFailure =
  | "auth"
  | "cancelled"
  | "forbidden"
  | "invalid_response"
  | "not_found"
  | "rate_limited"
  | "timeout"
  | "too_large"
  | "unavailable";

const FAILURE_MESSAGES: Record<GitHubFailure, string> = {
  auth: "GitHub rejected the service owner's gh login; re-authenticate gh for github.com",
  cancelled: "GitHub request was cancelled",
  forbidden: "GitHub denied access to this resource for the service owner's gh login",
  invalid_response: "GitHub returned an unexpected response",
  not_found: "GitHub resource was not found or is not accessible to the service owner's gh login",
  rate_limited: "GitHub API rate limit reached; try again later",
  timeout: "GitHub request timed out",
  too_large: "GitHub response exceeded the size limit",
  unavailable: "GitHub lookup failed; verify the service owner's gh login and repository access",
};

/** Carries only a fixed failure class; gh diagnostics and response bodies never reach callers. */
export class GitHubRequestError extends Error {
  constructor(readonly failure: GitHubFailure) {
    super(FAILURE_MESSAGES[failure]);
    this.name = "GitHubRequestError";
  }
}

export interface GitHubRequestOptions {
  /** Media type for the Accept header, for example `application/vnd.github.diff`. */
  accept?: string;
  maxBytes?: number;
  signal?: AbortSignal;
}

export interface GitHubResponse {
  status: number;
  /** Lower-cased header names. */
  headers: ReadonlyMap<string, string>;
  body: string;
}

/** Fixed GET requests through the service owner's gh login. Endpoints must be built from validated parts. */
export interface GitHubClient {
  get(endpoint: string, options?: GitHubRequestOptions): Promise<GitHubResponse>;
}

/** JSON-only lookup used by status watches. */
export interface GitHubLookup {
  get(endpoint: string): Promise<unknown>;
}

export type GhExecutor = (
  file: string,
  args: readonly string[],
  options: {
    env: NodeJS.ProcessEnv;
    cwd: string;
    timeout: number;
    maxBuffer: number;
    signal?: AbortSignal;
  },
) => Promise<{ stdout: string }>;

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

const executeGh: GhExecutor = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { ...options, encoding: "utf8" }, (error, stdout) => {
      if (error) reject(Object.assign(error, { stdout }));
      else resolve({ stdout });
    });
  });

export async function checkGithubReadiness(execute: GhExecutor = executeGh): Promise<string> {
  try {
    await execute("gh", ["auth", "status", "--hostname", "github.com"], {
      env: ghEnvironment(),
      cwd: "/",
      timeout: REQUEST_TIMEOUT_MS,
      maxBuffer: 1_000_000,
    });
    return "GitHub CLI is authenticated for the service owner";
  } catch {
    throw new Error(
      "GitHub integration requires gh authenticated for github.com as the service owner",
    );
  }
}

function parseIncludedResponse(stdout: string): GitHubResponse | undefined {
  const separator = /\r?\n\r?\n/.exec(stdout);
  if (!separator) return undefined;
  const [statusLine, ...headerLines] = stdout.slice(0, separator.index).split(/\r?\n/);
  const status = /^HTTP\/[\d.]+ (\d{3})\b/.exec(statusLine ?? "");
  if (!status) return undefined;
  const headers = new Map<string, string>();
  for (const line of headerLines) {
    const colon = line.indexOf(":");
    if (colon > 0)
      headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  return {
    status: Number(status[1]),
    headers,
    body: stdout.slice(separator.index + separator[0].length),
  };
}

function httpFailure(response: GitHubResponse): GitHubFailure {
  if (response.status === 401) return "auth";
  if (
    response.status === 429 ||
    (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0")
  )
    return "rate_limited";
  if (response.status === 403) return "forbidden";
  if (response.status === 404) return "not_found";
  // GitHub answers 406 (and occasionally 422) when a diff is too large to render.
  if (response.status === 406 || response.status === 422) return "too_large";
  return "unavailable";
}

function processFailure(error: unknown, signal: AbortSignal | undefined): GitHubFailure {
  const failure = error as NodeJS.ErrnoException & { killed?: boolean; stdout?: string };
  if (signal?.aborted || failure.name === "AbortError") return "cancelled";
  if (failure.code === "ENOENT") return "unavailable";
  if (failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return "too_large";
  if (failure.killed) return "timeout";
  const response =
    typeof failure.stdout === "string" ? parseIncludedResponse(failure.stdout) : undefined;
  return response ? httpFailure(response) : "unavailable";
}

/** The service owns these requests; Pi receives neither a shell tool nor gh credentials. */
export function githubCliClient(execute: GhExecutor = executeGh): GitHubClient {
  return {
    async get(endpoint, { accept, maxBytes = DEFAULT_MAX_BYTES, signal } = {}) {
      if (signal?.aborted) throw new GitHubRequestError("cancelled");
      // Endpoints are relative REST paths built from validated values; never options or URLs.
      if (!/^[a-z][A-Za-z0-9_.~%/-]*(\?[A-Za-z0-9_.~%=&-]*)?$/.test(endpoint))
        throw new Error("Invalid GitHub endpoint");
      let failure: GitHubFailure;
      try {
        const { stdout } = await execute(
          "gh",
          [
            "api",
            "--hostname",
            "github.com",
            "--method",
            "GET",
            "--include",
            ...(accept ? ["--header", `Accept: ${accept}`] : []),
            endpoint,
          ],
          // A neutral cwd keeps gh from inferring a repository for {owner}/{repo} placeholders.
          {
            env: ghEnvironment(),
            cwd: "/",
            timeout: REQUEST_TIMEOUT_MS,
            maxBuffer: maxBytes,
            signal,
          },
        );
        const response = parseIncludedResponse(stdout);
        if (response && response.status >= 200 && response.status < 300) return response;
        failure = response ? httpFailure(response) : "invalid_response";
      } catch (error) {
        failure = processFailure(error, signal);
      }
      // gh diagnostics can include sensitive response content, so only the failure class is logged.
      // Expected outcomes (cancellation, missing resources, oversized responses) are not operator errors.
      if (failure !== "cancelled" && failure !== "too_large" && failure !== "not_found")
        writeStructuredLog({
          event: "operator_error",
          component: "github",
          message: "GitHub request failed",
          error_type: `GitHub_${failure}`,
        });
      throw new GitHubRequestError(failure);
    },
  };
}

export function githubJsonLookup(client: GitHubClient): GitHubLookup {
  return {
    async get(endpoint) {
      const { body } = await client.get(endpoint);
      try {
        return JSON.parse(body);
      } catch {
        throw new GitHubRequestError("invalid_response");
      }
    },
  };
}

export function githubObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid GitHub response");
  return value as Record<string, unknown>;
}

export interface ApprovedRepository {
  owner: string;
  name: string;
  fullName: string;
}

/** Resolves a requested repository against the exact allowlist before any request is made. */
export function approvedRepository(
  requested: string,
  allowedRepos: readonly string[],
): ApprovedRepository | undefined {
  if (!REPOSITORY.test(requested)) return undefined;
  const fullName = allowedRepos.find((repo) => repo.toLowerCase() === requested.toLowerCase());
  const match = fullName ? REPOSITORY.exec(fullName) : null;
  return match ? { owner: match[1]!, name: match[2]!, fullName: fullName! } : undefined;
}

/**
 * Validates a repository object returned by GitHub. A renamed or transferred repository is
 * followed by GitHub's redirect, so its returned identity no longer matches and is rejected.
 */
export function assertOrganizationRepository(value: unknown, expectedFullName: string): void {
  const repository = githubObject(value);
  if (
    typeof repository.full_name !== "string" ||
    repository.full_name.toLowerCase() !== expectedFullName.toLowerCase() ||
    githubObject(repository.owner).type !== "Organization"
  )
    throw new Error("GitHub target must belong to an approved organization repository");
}
