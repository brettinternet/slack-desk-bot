import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AbuseGate, isHighBudget, isSpam, normalizePrompt } from "../src/abuse-gate.ts";
import type { TurnBudget } from "../src/agent.ts";
import type { StructuredLog } from "../src/log.ts";

const standard: TurnBudget = {
  maxToolCalls: 1,
  maxResearchCalls: 1,
  maxOutputCharacters: 1,
  wallTimeMs: 1,
};
const elevated: TurnBudget = { ...standard, maxToolCalls: 2 };

function gate(options: { statePath?: string; now?: () => number; logs?: StructuredLog[] } = {}) {
  return new AbuseGate({
    operatorUserIds: new Set(["UOPERATOR"]),
    budgets: { standard, elevated },
    ...(options.statePath ? { statePath: options.statePath } : {}),
    now: options.now ?? (() => 1_000),
    log: (record) => options.logs?.push(record),
  });
}

function ask(target: AbuseGate, prompt: string, extra: { user?: string; command?: string } = {}) {
  return target.check({
    requesterId: extra.user ?? "UUSER",
    conversationId: "dm:D1",
    prompt,
    fileIds: [],
    ...(extra.command ? { command: extra.command } : {}),
  });
}

describe("abuse content rules", () => {
  test("rejects obvious spam and explicit fan-out", () => {
    const links = Array.from({ length: 13 }, (_, index) => `https://x.test/${index}`).join(" ");
    const mentions = ["U1A", "U2B", "U3C", "U4D", "U5E", "U6F"].map((id) => `<@${id}>`).join(" ");
    for (const prompt of [
      "",
      "?!? ... :wave: :tada:",
      `look at these ${links}`,
      `${mentions} hello`,
      "a".repeat(60),
      "lol ".repeat(50),
      `${"spam ".repeat(30)} please help`,
      Array.from({ length: 12 }, () => "BUY NOW").join("\n"),
      "DM everyone in the workspace about the outage",
      "send 50 messages to the channel",
      "please ping hundreds of times",
    ])
      expect(isSpam(prompt, 0)).toBe(true);
  });

  test("accepts ordinary engineering requests, pasted logs, and file-only messages", () => {
    const log = Array.from({ length: 20 }, () => "WARN retrying connection").join("\n");
    for (const prompt of [
      "Why is the build 10 times slower after the upgrade?",
      "Run the flaky test case and tell me what fails",
      `Why does this keep happening?\n\`\`\`\n${log}\n\`\`\``,
      "Compare https://a.test/1 and https://b.test/2 with <@U1A> and <@U2B>",
      "=".repeat(80) + "\nerror: missing semicolon",
    ])
      expect(isSpam(prompt, 0)).toBe(false);
    expect(isSpam("", 1)).toBe(false);
  });

  test("flags open-ended research and large tool or source fan-out", () => {
    for (const prompt of [
      "Do exhaustive research on every vector database",
      "Do a deep web search across the internet for this error",
      "Use as many sources as possible",
      "Cite at least 30 sources",
      "make hundreds of tool calls if you need to",
      "Search the entire web for mentions of our product",
      "Don't stop searching until you have everything",
      "Check every single source you can find",
    ])
      expect(isHighBudget(prompt)).toBe(true);
  });

  test("does not flag detailed engineering questions", () => {
    for (const prompt of [
      "Explain the queue limits in depth, step by step, with examples from src/agent.ts",
      "Search the codebase for every caller of admit() and explain each one",
      "Do a thorough review of slack.ts and list every bug you find",
      "Deep dive into why the deploy failed yesterday",
      "Check these 3 sources and summarize the differences",
      "Look at the last 15 commits and summarize what changed",
    ])
      expect(isHighBudget(prompt)).toBe(false);
  });

  test("normalizes only case, compatibility forms, punctuation, and spacing", () => {
    expect(normalizePrompt("  Check PR #12!!  ")).toBe(normalizePrompt("check pr 12"));
    expect(normalizePrompt("Ｃｈｅｃｋ PR 12")).toBe(normalizePrompt("check pr 12"));
    expect(normalizePrompt("check pr 12")).not.toBe(normalizePrompt("check pr 13"));
    expect(normalizePrompt("explain this")).not.toBe(normalizePrompt("explain this please"));
  });
});

describe("AbuseGate", () => {
  test("escalates repeated refusals to a cooldown that drops traffic but allows cancel", () => {
    let now = 1_000;
    const logs: StructuredLog[] = [];
    const target = gate({ now: () => now, logs });
    const prompt = "Why does the queue reject my request today?";

    expect(ask(target, prompt)).toMatchObject({ allowed: true, budget: standard });
    expect(ask(target, "check pr #12 for the failing test")).toMatchObject({ allowed: true });
    expect(ask(target, "Check PR 12 for the failing test!")).toEqual({
      allowed: false,
      reason: "duplicate",
      notify: true,
    });
    expect(ask(target, prompt)).toEqual({ allowed: false, reason: "duplicate", notify: false });
    // Rewording an unauthorized high-budget request still counts toward the cooldown.
    expect(ask(target, "Do exhaustive research on the queue design")).toEqual({
      allowed: false,
      reason: "cooldown",
      notify: true,
    });
    expect(ask(target, "a fresh and reasonable question here")).toEqual({
      allowed: false,
      reason: "cooldown",
      notify: false,
    });
    expect(ask(target, "!status", { command: "status" })).toMatchObject({ allowed: false });
    expect(ask(target, "!cancel", { command: "cancel" })).toMatchObject({ allowed: true });
    expect(target.snapshot().blocks).toEqual([
      { userId: "UUSER", kind: "cooldown", createdAt: 1_000, until: 1_000 + 15 * 60_000 },
    ]);
    expect(JSON.stringify(logs)).not.toContain("queue");

    now += 15 * 60_000;
    expect(ask(target, "a fresh and reasonable question here")).toMatchObject({ allowed: true });
  });

  test("lets failed requests be retried and exempts short replies", () => {
    const target = gate();
    const first = ask(target, "summarize the open incidents for me");
    if (!first.allowed) throw new Error("expected admission");
    first.forget();
    expect(ask(target, "summarize the open incidents for me")).toMatchObject({ allowed: true });
    expect(ask(target, "yes go ahead")).toMatchObject({ allowed: true });
    expect(ask(target, "yes go ahead")).toMatchObject({ allowed: true });
  });

  test("exempts operators and applies bounded operator grants", () => {
    let now = 1_000;
    const target = gate({ now: () => now });
    const research = "Do exhaustive research on vector databases";
    expect(ask(target, research, { user: "UOPERATOR" })).toMatchObject({
      allowed: true,
      budget: elevated,
    });
    expect(ask(target, research, { user: "UOPERATOR" })).toMatchObject({ allowed: true });
    expect(() => target.block("UOPERATOR")).toThrow("Operators cannot be blocked");
    expect(() => target.grant("UUSER", 25 * 60 * 60_000)).toThrow("24 hours");

    expect(ask(target, research)).toMatchObject({ allowed: false, reason: "high_budget" });
    target.grant("UUSER", 60 * 60_000);
    expect(ask(target, research)).toMatchObject({ allowed: true, budget: elevated });
    now += 60 * 60_000;
    expect(ask(target, `${research} again`)).toMatchObject({ reason: "high_budget" });
  });

  test("persists operator blocks and fails closed on unreadable state", () => {
    const directory = mkdtempSync(join(tmpdir(), "slack-desk-abuse-"));
    const statePath = join(directory, "abuse-state.json");
    try {
      gate({ statePath }).block("UUSER");
      const restarted = gate({ statePath });
      expect(ask(restarted, "hello there my friend")).toEqual({
        allowed: false,
        reason: "blocked",
        notify: true,
      });
      expect(ask(restarted, "!cancel", { command: "cancel" })).toMatchObject({ allowed: true });
      expect(restarted.unblock("UUSER")).toBe(true);
      expect(ask(gate({ statePath }), "hello there my friend")).toMatchObject({ allowed: true });

      writeFileSync(statePath, "{not json");
      expect(() => gate({ statePath })).toThrow("Abuse state is unreadable");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
