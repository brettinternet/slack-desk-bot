import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AutomationService } from "../src/automations.ts";
import {
  ghEnvironment,
  githubSources,
  type GitHubLookup,
} from "../src/github-automation-source.ts";
import { slackAutomationTool } from "../src/automation-tool.ts";

const repo = { full_name: "work-org/project", owner: { type: "Organization" } };
const prInput = {
  source: { kind: "github-pr", id: "work-org/project#42" },
  condition: { field: "merged", equals: "true" },
};
const issueInput = {
  source: { kind: "github-issue", id: "work-org/project#17" },
  condition: { field: "state", equals: "closed" },
};
const file = () => join(mkdtempSync(join(tmpdir(), "github-watches-")), "automations.json");
const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

function fixture() {
  let pr = {
    number: 42,
    state: "open",
    merged_at: null as string | null,
    html_url: "https://github.com/work-org/project/pull/42",
  };
  let issue = {
    number: 17,
    state: "open",
    html_url: "https://github.com/work-org/project/issues/17",
  };
  const calls: string[] = [];
  const lookup: GitHubLookup = {
    get: async (endpoint) => {
      calls.push(endpoint);
      if (endpoint === "repos/work-org/project") return repo;
      if (endpoint.endsWith("/pulls/42")) return pr;
      if (endpoint.endsWith("/issues/17")) return issue;
      throw new Error("not found or inaccessible");
    },
  };
  return {
    lookup,
    calls,
    setPr: (value: typeof pr) => {
      pr = value;
    },
    setIssue: (value: typeof issue) => {
      issue = value;
    },
    pr: () => pr,
    issue: () => issue,
  };
}

describe("GitHub watches", () => {
  test("uses the saved gh login without inherited token overrides or prompts", () => {
    expect(
      ghEnvironment({
        GH_TOKEN: "personal-token",
        GITHUB_TOKEN: "another-token",
        GH_ENTERPRISE_TOKEN: "enterprise-token",
        GH_CONFIG_DIR: "/service/gh-config",
        GH_HOST: "untrusted.example",
      }),
    ).toEqual({
      GH_CONFIG_DIR: "/service/gh-config",
      GH_HOST: "github.com",
      GH_PROMPT_DISABLED: "1",
    });
  });
  test("tool schema only offers configured sources and fields", () => {
    function schema(kinds: ("linear-issue" | "github-pr" | "github-issue")[]) {
      let parameters: any;
      const extension = slackAutomationTool(() => {
        throw new Error("not called");
      }, kinds);
      if (typeof extension === "function") throw new Error("Unexpected extension factory");
      extension.factory({
        registerTool: (tool: { parameters: unknown }) => {
          parameters = tool.parameters;
        },
      } as any);
      return parameters.properties;
    }
    expect(schema(["linear-issue"]).source.properties.kind.enum).toEqual(["linear-issue"]);
    expect(schema(["github-pr", "github-issue"]).source.properties.kind.enum).toEqual([
      "github-pr",
      "github-issue",
    ]);
    expect(schema(["github-pr", "github-issue"]).condition.properties.field.enum).toEqual([
      "merged",
      "state",
    ]);
  });
  test("closed-but-unmerged PR never matches; merged PR and closed issue DM once across restart", async () => {
    const f = fixture();
    const filename = file();
    let now = Date.parse("2026-01-01T08:00:00Z");
    const sent: string[] = [];
    const build = () =>
      new AutomationService(
        filename,
        githubSources(f.lookup, ["work-org/project"]),
        async (_recipient, text) => {
          expect(
            JSON.parse(readFileSync(filename, "utf8")).automations.filter(
              (a: { status: string }) => a.status === "completed",
            ).length,
          ).toBeGreaterThan(0);
          sent.push(text);
        },
        () => now,
      );
    const service = build();
    await service.create(prInput, "U0ALICE");
    await service.create(issueInput, "U0ALICE");
    f.setPr({ ...f.pr(), state: "closed" });
    now += 15 * 60_000;
    service.start();
    await tick();
    await service.stop();
    expect(sent).toEqual([]);
    f.setPr({ ...f.pr(), merged_at: "2026-01-01T09:00:00Z" });
    f.setIssue({ ...f.issue(), state: "closed" });
    now += 15 * 60_000;
    const restored = build();
    restored.start();
    await tick();
    await restored.stop();
    expect(sent).toHaveLength(2);
    expect(sent[0]).toContain("https://github.com/work-org/project/pull/42");
    expect(sent[1]).toContain("https://github.com/work-org/project/issues/17");
    const again = build();
    again.start();
    await tick();
    await again.stop();
    expect(sent).toHaveLength(2);
  });

  test("already met, invalid, unapproved, personal, inaccessible and mismatched targets cannot create", async () => {
    const f = fixture();
    const service = new AutomationService(
      file(),
      githubSources(f.lookup, ["work-org/project"]),
      async () => {},
    );
    f.setPr({ ...f.pr(), state: "closed", merged_at: "2026-01-01T09:00:00Z" });
    f.setIssue({ ...f.issue(), state: "closed" });
    expect(await service.create(prInput, "U0ALICE")).toEqual({ alreadyMet: true });
    expect(await service.create(issueInput, "U0ALICE")).toEqual({ alreadyMet: true });
    expect(service.list("U0ALICE")).toEqual([]);
    for (const id of [
      "personal/repo#42",
      "work-org/project#0",
      "work-org/project#42;evil",
      "work-org/other#42",
    ])
      await expect(
        service.create({ ...prInput, source: { kind: "github-pr", id } }, "U0ALICE"),
      ).rejects.toThrow("invalid source identifier");
    expect(f.calls).toHaveLength(4);
    await expect(
      service.create({ ...prInput, condition: { field: "merged", equals: "false" } }, "U0ALICE"),
    ).rejects.toThrow("Unsupported condition");
    await expect(
      service.create({ ...issueInput, condition: { field: "state", equals: "open" } }, "U0ALICE"),
    ).rejects.toThrow("Unsupported condition");
    const unavailable = new AutomationService(
      file(),
      githubSources(
        {
          get: async () => {
            throw new Error("not found");
          },
        },
        ["work-org/project"],
      ),
      async () => {},
    );
    await expect(unavailable.create(prInput, "U0ALICE")).rejects.toThrow("not found");
    const personal = new AutomationService(
      file(),
      githubSources(
        {
          get: async (endpoint) =>
            endpoint === "repos/work-org/project" ? { ...repo, owner: { type: "User" } } : f.pr(),
        },
        ["work-org/project"],
      ),
      async () => {},
    );
    await expect(personal.create(prInput, "U0ALICE")).rejects.toThrow("organization repository");
    f.setIssue({ ...f.issue(), html_url: "https://evil.example/issues/17" });
    await expect(service.create(issueInput, "U0ALICE")).rejects.toThrow(
      "Invalid GitHub target response",
    );
    const prAsIssue = new AutomationService(
      file(),
      githubSources(
        {
          get: async (endpoint) =>
            endpoint === "repos/work-org/project"
              ? repo
              : {
                  ...f.issue(),
                  html_url: "https://github.com/work-org/project/issues/17",
                  pull_request: {},
                },
        },
        ["work-org/project"],
      ),
      async () => {},
    );
    await expect(prAsIssue.create(issueInput, "U0ALICE")).rejects.toThrow("not an issue");
  });

  test("cancel during GitHub lookup suppresses delivery; missing source is not polled after restart", async () => {
    let now = Date.parse("2026-01-01T08:00:00Z");
    let finish: ((value: unknown) => void) | undefined;
    let pending = false;
    let sent = 0;
    const f = fixture();
    const lookup: GitHubLookup = {
      get: async (endpoint) =>
        endpoint.endsWith("/pulls/42") && pending
          ? new Promise((resolve) => {
              finish = resolve;
            })
          : f.lookup.get(endpoint),
    };
    const filename = file();
    const build = (sources = githubSources(lookup, ["work-org/project"])) =>
      new AutomationService(
        filename,
        sources,
        async () => {
          sent++;
        },
        () => now,
      );
    const service = build();
    const created = (await service.create(prInput, "U0ALICE")).automation!;
    pending = true;
    now += 15 * 60_000;
    service.start();
    await tick();
    service.cancel(created.id, "U0ALICE");
    finish!({ ...f.pr(), state: "closed", merged_at: "2026-01-01T09:00:00Z" });
    await service.stop();
    expect(sent).toBe(0);
    pending = false;
    await service.create(prInput, "U0ALICE");
    now += 15 * 60_000;
    const withoutGithub = build({});
    withoutGithub.start();
    await tick();
    await withoutGithub.stop();
    expect(sent).toBe(0);
  });
});
