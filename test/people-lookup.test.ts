import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { linkIdentity, type SlackDirectoryUser } from "../src/git-slack-identities.ts";
import { findPeople } from "../src/people-lookup.ts";

const repository = mkdtempSync(join(tmpdir(), "slack-people-lookup-"));
afterAll(() => rmdirSync(repository));
const users: SlackDirectoryUser[] = [
  {
    id: "U1",
    name: "Alex Kim",
    handle: "alex",
    realName: "Alexander Kim",
    email: "alex@work.test",
  },
  { id: "U2", name: "Alex Rivera", handle: "arivera", email: "rivera@work.test" },
  { id: "U3", name: "Bob", handle: "bob", email: "bob@work.test" },
];

const search = (query: string, directory: readonly SlackDirectoryUser[] = users) =>
  findPeople(query, directory, repository, join(repository, "global.yaml"));

afterEach(() => {
  // Explicit mappings are a fixture local to this owned temporary directory.
  try {
    unlinkSync(join(repository, ".slack-desk-bot", "identities.yaml"));
    rmdirSync(join(repository, ".slack-desk-bot"));
  } catch {}
});

test("returns exact email, handle, and ambiguous name candidates without exposing emails", () => {
  expect(search("Alex@WORK.test")).toEqual([
    { userId: "U1", name: "Alex Kim", handle: "alex", match: "email" },
  ]);
  expect(search("@alex")[0]?.userId).toBe("U1");
  expect(search("alex").map(({ userId }) => userId)).toEqual(["U1", "U2"]);
  expect(search("bo")).toEqual([]);
  expect(search("ian", [{ id: "U9", name: "Brian Smith" }])).toEqual([]);
  expect(search("Alex K")[0]?.userId).toBe("U1");
  expect(
    search("@jane", [
      { id: "U4", name: "Jane", handle: "jdoe" },
      { id: "U5", name: "Someone Else", handle: "jane" },
    ]).map(({ userId }) => userId),
  ).toEqual(["U4", "U5"]);
});

test("resolves an explicit Git email mapping and rejects unsafe searches", () => {
  mkdirSync(join(repository, ".slack-desk-bot"), { recursive: true });
  linkIdentity(join(repository, ".slack-desk-bot", "identities.yaml"), "U2", "old@example.test");
  expect(search("OLD@example.test")).toEqual([
    { userId: "U2", name: "Alex Rivera", handle: "arivera", match: "git_email" },
  ]);
  expect(() => search("a\nb")).toThrow();
  expect(() => search(" ")).toThrow();
});

test("falls back to exact profile email when optional identity config is malformed", () => {
  mkdirSync(join(repository, ".slack-desk-bot"), { recursive: true });
  writeFileSync(join(repository, ".slack-desk-bot", "identities.yaml"), "invalid: yaml");
  expect(search("alex@work.test")).toEqual([
    { userId: "U1", name: "Alex Kim", handle: "alex", match: "email" },
  ]);
});
