import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GitSlackIdentityResolver,
  gitAuthors,
  linkIdentity,
  loadExplicitIdentities,
  projectIdentityPath,
} from "../src/git-slack-identities.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "slack-identities-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("Git-to-Slack identities", () => {
  test("merges global aliases with project overrides", () => {
    const repository = temporaryDirectory();
    const globalPath = join(temporaryDirectory(), "identities.yaml");
    linkIdentity(globalPath, "UGLOBAL", "person@example.com");
    linkIdentity(globalPath, "UOTHER", "other@example.com");
    linkIdentity(projectIdentityPath(repository), "ULOCAL", "person@example.com");

    expect(loadExplicitIdentities(repository, globalPath)).toEqual(
      new Map([
        ["person@example.com", "ULOCAL"],
        ["other@example.com", "UOTHER"],
      ]),
    );
    expect(readFileSync(projectIdentityPath(repository), "utf8")).toContain("git_emails");
  });

  test("prefers explicit aliases and only accepts unique exact Slack email matches", async () => {
    const repository = temporaryDirectory();
    const globalPath = join(temporaryDirectory(), "identities.yaml");
    linkIdentity(globalPath, "UEXPLICIT", "alias@example.com");
    const resolver = new GitSlackIdentityResolver(
      async () => [
        { id: "UAUTO", email: "person@example.com", name: "Person" },
        { id: "UDUP1", email: "duplicate@example.com" },
        { id: "UDUP2", email: "DUPLICATE@example.com" },
      ],
      globalPath,
    );

    expect(await resolver.resolve(repository, "ALIAS@example.com")).toMatchObject({
      slackUserId: "UEXPLICIT",
      source: "explicit",
    });
    expect(await resolver.resolve(repository, "Person@Example.com")).toMatchObject({
      slackUserId: "UAUTO",
      source: "email",
      slackName: "Person",
    });
    expect(await resolver.resolve(repository, "duplicate@example.com")).toBeUndefined();
    expect(await resolver.resolve(repository, "missing@example.com")).toBeUndefined();
  });

  test("degrades malformed config and retries a transient Slack failure", async () => {
    const repository = temporaryDirectory();
    const globalPath = join(temporaryDirectory(), "identities.yaml");
    writeFileSync(globalPath, "not: an identity file\n");
    let attempts = 0;
    const resolver = new GitSlackIdentityResolver(async () => {
      attempts++;
      if (attempts === 1) throw new Error("temporary Slack failure");
      return [{ id: "WGRID", email: "person@example.com" }];
    }, globalPath);

    expect(await resolver.resolve(repository, "person@example.com")).toBeUndefined();
    expect(await resolver.resolve(repository, "person@example.com")).toMatchObject({
      slackUserId: "WGRID",
      source: "email",
    });
    expect(attempts).toBe(2);
  });

  test("refreshes Slack users after five minutes and retries failed refreshes", async () => {
    const repository = temporaryDirectory();
    let now = 0;
    let loads = 0;
    const resolver = new GitSlackIdentityResolver(
      async () => {
        loads++;
        if (loads === 2) throw new Error("temporary Slack failure");
        return [{ id: "UPERSON", email: loads === 1 ? "old@example.com" : "new@example.com" }];
      },
      join(temporaryDirectory(), "identities.yaml"),
      () => now,
    );

    expect(await resolver.resolve(repository, "old@example.com")).toMatchObject({
      slackUserId: "UPERSON",
    });
    now = 299_999;
    expect(await resolver.resolve(repository, "old@example.com")).toBeDefined();
    expect(loads).toBe(1);

    now = 300_000;
    expect(await resolver.resolve(repository, "new@example.com")).toBeUndefined();
    expect(await resolver.resolve(repository, "new@example.com")).toMatchObject({
      slackUserId: "UPERSON",
    });
    expect(await resolver.resolve(repository, "old@example.com")).toBeUndefined();
    expect(loads).toBe(3);
  });

  test("accepts Enterprise Grid user IDs in explicit mappings", () => {
    const path = join(temporaryDirectory(), "identities.yaml");
    linkIdentity(path, "WGRID", "person@example.com");
    expect(readFileSync(path, "utf8")).toContain("WGRID");
  });

  test("uses mailmap-canonicalized author names and emails", async () => {
    const repository = temporaryDirectory();
    execFileSync("/usr/bin/git", ["init", "-q", "-b", "main", repository]);
    execFileSync("/usr/bin/git", ["-C", repository, "config", "user.name", "Alias Name"]);
    execFileSync("/usr/bin/git", ["-C", repository, "config", "user.email", "alias@example.com"]);
    writeFileSync(join(repository, "file.txt"), "content\n");
    execFileSync("/usr/bin/git", ["-C", repository, "add", "file.txt"]);
    execFileSync("/usr/bin/git", [
      "-C",
      repository,
      "commit",
      "-q",
      "--author=Alias Name <alias@example.com>",
      "-m",
      "Initial",
    ]);
    writeFileSync(
      join(repository, ".mailmap"),
      "Canonical Name <canonical@example.com> <alias@example.com>\n",
    );

    expect(await gitAuthors(repository)).toEqual([
      { name: "Canonical Name", email: "canonical@example.com" },
    ]);
  });
});
