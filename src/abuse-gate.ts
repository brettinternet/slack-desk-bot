import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { TurnBudget, TurnBudgetReason } from "./agent.ts";
import { type LogWriter, writeStructuredLog } from "./log.ts";

/** Bounded reason codes; prompts and file contents are never recorded. */
export type AbuseReason =
  "duplicate" | "spam" | "high_budget" | "cooldown" | "blocked" | TurnBudgetReason;

export type RejectionReason = Extract<
  AbuseReason,
  "duplicate" | "spam" | "high_budget" | "cooldown" | "blocked"
>;

export interface AbuseEvent {
  at: number;
  lastAt: number;
  count: number;
  user: string;
  conversation: string;
  reason: AbuseReason;
}

export interface UserBlock {
  userId: string;
  kind: "block" | "cooldown";
  createdAt: number;
  /** Absent for permanent operator blocks. */
  until?: number;
}

export interface ElevatedGrant {
  userId: string;
  createdAt: number;
  until: number;
}

export interface AbuseSnapshot {
  blocks: UserBlock[];
  grants: ElevatedGrant[];
  events: AbuseEvent[];
}

export interface GateRequest {
  requesterId: string;
  conversationId: string;
  prompt: string;
  fileIds: readonly string[];
  /** Parsed command; commands skip content rules, and `cancel` is always allowed. */
  command?: string;
}

export type GateDecision =
  | {
      allowed: true;
      /** Undefined for commands, which do not start an agent turn. */
      budget?: TurnBudget;
      /** Forgets the duplicate fingerprint so a failed request can be retried. */
      forget(): void;
    }
  | {
      allowed: false;
      reason: RejectionReason;
      /** True for the first rejection per user, conversation, and reason in the dedupe window. */
      notify: boolean;
    };

interface AbuseGateOptions {
  operatorUserIds: ReadonlySet<string>;
  budgets: { standard: TurnBudget; elevated: TurnBudget };
  statePath?: string;
  now?: () => number;
  log?: LogWriter;
}

interface StoredAbuseState {
  version: 1;
  blocks: UserBlock[];
  grants: ElevatedGrant[];
}

const DUPLICATE_WINDOW_MS = 10 * 60_000;
const MIN_DUPLICATE_WORDS = 4;
const REPLY_DEDUPE_MS = 10 * 60_000;
const STRIKE_WINDOW_MS = 15 * 60_000;
const STRIKES_BEFORE_COOLDOWN = 3;
const COOLDOWN_MS = 15 * 60_000;
const MAX_GRANT_MS = 24 * 60 * 60_000;
const MAX_EVENTS = 200;
const MAX_TRACKED_KEYS = 5_000;
const SLACK_USER_ID = /^[UW][A-Z0-9]{2,}$/;

/**
 * Transport-level gate that runs before attachment download, queue admission, or session use.
 * Rules are deterministic and explainable; "serious" high-budget work is established by operator
 * authorization, not by classifying the requester's intent.
 */
export class AbuseGate {
  private readonly now: () => number;
  private readonly log: LogWriter;
  private readonly blocks = new Map<string, UserBlock>();
  private readonly grants = new Map<string, ElevatedGrant>();
  private readonly fingerprints = new Map<string, number>();
  private readonly strikes = new Map<string, number[]>();
  private readonly replies = new Map<string, number>();
  private readonly events: AbuseEvent[] = [];

  constructor(private readonly options: AbuseGateOptions) {
    this.now = options.now ?? Date.now;
    this.log = options.log ?? writeStructuredLog;
    this.load();
  }

  check(request: GateRequest): GateDecision {
    const now = this.now();
    this.expire(now);
    const { requesterId: user, conversationId: conversation } = request;
    if (this.options.operatorUserIds.has(user)) {
      return {
        allowed: true,
        budget: request.command ? undefined : this.options.budgets.elevated,
        forget() {},
      };
    }
    if (request.command === "cancel") return { allowed: true, forget() {} };

    const block = this.blocks.get(user);
    if (block)
      return this.reject(
        user,
        conversation,
        block.kind === "block" ? "blocked" : "cooldown",
        now,
        false,
      );
    if (request.command) return { allowed: true, forget() {} };

    if (isSpam(request.prompt, request.fileIds.length))
      return this.reject(user, conversation, "spam", now);
    const elevated = this.grants.has(user);
    if (!elevated && isHighBudget(request.prompt))
      return this.reject(user, conversation, "high_budget", now);

    const budget = elevated ? this.options.budgets.elevated : this.options.budgets.standard;
    // Short replies such as "yes, go ahead" legitimately recur in one conversation.
    const words = normalizePrompt(request.prompt).split(" ").filter(Boolean).length;
    if (request.fileIds.length === 0 && words < MIN_DUPLICATE_WORDS) {
      return { allowed: true, budget, forget() {} };
    }
    const key = `${user}\u0000${conversation}\u0000${fingerprint(request.prompt, request.fileIds)}`;
    if (this.fingerprints.has(key)) return this.reject(user, conversation, "duplicate", now);
    this.fingerprints.set(key, now + DUPLICATE_WINDOW_MS);
    bound(this.fingerprints);
    return { allowed: true, budget, forget: () => this.fingerprints.delete(key) };
  }

  /** Records a per-turn budget abort as an abuse strike. */
  recordBudgetExceeded(user: string, conversation: string, reason: TurnBudgetReason): void {
    const now = this.now();
    this.record(user, conversation, reason, now);
    if (!this.options.operatorUserIds.has(user)) this.strike(user, now);
  }

  block(userId: string, durationMs?: number): UserBlock {
    this.assertUser(userId);
    if (this.options.operatorUserIds.has(userId)) throw new Error("Operators cannot be blocked");
    if (durationMs !== undefined && (!Number.isSafeInteger(durationMs) || durationMs <= 0))
      throw new Error("Block duration must be positive");
    const now = this.now();
    const block: UserBlock = {
      userId,
      kind: "block",
      createdAt: now,
      ...(durationMs !== undefined ? { until: now + durationMs } : {}),
    };
    this.blocks.set(userId, block);
    this.save();
    return block;
  }

  /** Removes an operator block or automatic cooldown. */
  unblock(userId: string): boolean {
    this.strikes.delete(userId);
    const removed = this.blocks.delete(userId);
    if (removed) this.save();
    return removed;
  }

  /** Authorizes bounded elevated budgets, including high-budget requests, for a limited time. */
  grant(userId: string, durationMs: number): ElevatedGrant {
    this.assertUser(userId);
    if (!Number.isSafeInteger(durationMs) || durationMs < 60_000 || durationMs > MAX_GRANT_MS)
      throw new Error("Grant duration must be between 1 minute and 24 hours");
    const now = this.now();
    const grant = { userId, createdAt: now, until: now + durationMs };
    this.grants.set(userId, grant);
    this.save();
    return grant;
  }

  revoke(userId: string): boolean {
    const removed = this.grants.delete(userId);
    if (removed) this.save();
    return removed;
  }

  snapshot(): AbuseSnapshot {
    this.expire(this.now());
    return {
      blocks: [...this.blocks.values()],
      grants: [...this.grants.values()],
      events: this.events.map((event) => ({ ...event })),
    };
  }

  private reject(
    user: string,
    conversation: string,
    reason: RejectionReason,
    now: number,
    countsAsStrike = true,
  ): GateDecision {
    const notify = !this.replies.has(`${user}\u0000${conversation}\u0000${reason}`);
    if (notify) {
      this.replies.set(`${user}\u0000${conversation}\u0000${reason}`, now + REPLY_DEDUPE_MS);
      bound(this.replies);
    }
    this.record(user, conversation, reason, now);
    if (countsAsStrike && this.strike(user, now)) {
      return this.reject(user, conversation, "cooldown", now, false);
    }
    return { allowed: false, reason, notify };
  }

  /** Returns true when this strike starts a cooldown. */
  private strike(user: string, now: number): boolean {
    const recent = (this.strikes.get(user) ?? []).filter((at) => at > now - STRIKE_WINDOW_MS);
    recent.push(now);
    if (recent.length < STRIKES_BEFORE_COOLDOWN) {
      this.strikes.set(user, recent);
      bound(this.strikes);
      return false;
    }
    this.strikes.delete(user);
    if (!this.blocks.has(user)) {
      this.blocks.set(user, {
        userId: user,
        kind: "cooldown",
        createdAt: now,
        until: now + COOLDOWN_MS,
      });
      this.save();
    }
    return true;
  }

  /** Aggregates repeats into one bounded event and logs only the first in each dedupe window. */
  private record(user: string, conversation: string, reason: AbuseReason, now: number): void {
    const existing = this.events.find(
      (event) =>
        event.user === user &&
        event.conversation === conversation &&
        event.reason === reason &&
        event.lastAt > now - REPLY_DEDUPE_MS,
    );
    if (existing) {
      existing.count++;
      existing.lastAt = now;
      return;
    }
    this.events.push({ at: now, lastAt: now, count: 1, user, conversation, reason });
    if (this.events.length > MAX_EVENTS) this.events.shift();
    this.log({ event: "abuse_rejected", reason, user, conversation });
  }

  private expire(now: number): void {
    let changed = false;
    for (const [user, block] of this.blocks) {
      if (block.until !== undefined && block.until <= now) {
        this.blocks.delete(user);
        changed = true;
      }
    }
    for (const [user, grant] of this.grants) {
      if (grant.until <= now) {
        this.grants.delete(user);
        changed = true;
      }
    }
    for (const map of [this.fingerprints, this.replies]) {
      for (const [key, expiresAt] of map) if (expiresAt <= now) map.delete(key);
    }
    if (changed) this.save();
  }

  private assertUser(userId: string): void {
    if (!SLACK_USER_ID.test(userId))
      throw new Error("A Slack member ID such as U0123456789 is required");
  }

  /** Fails closed: an unreadable block list must not silently unblock users. */
  private load(): void {
    const path = this.options.statePath;
    if (!path || !existsSync(path)) return;
    let stored: StoredAbuseState;
    try {
      stored = JSON.parse(readFileSync(path, "utf8")) as StoredAbuseState;
    } catch {
      throw new Error(`Abuse state is unreadable; repair or remove ${path}`);
    }
    if (stored?.version !== 1 || !Array.isArray(stored.blocks) || !Array.isArray(stored.grants))
      throw new Error(`Abuse state is invalid; repair or remove ${path}`);
    for (const block of stored.blocks) {
      if (
        typeof block?.userId !== "string" ||
        (block.kind !== "block" && block.kind !== "cooldown") ||
        (block.until !== undefined && !Number.isFinite(block.until))
      )
        throw new Error(`Abuse state is invalid; repair or remove ${path}`);
      this.blocks.set(block.userId, block);
    }
    for (const grant of stored.grants) {
      if (typeof grant?.userId !== "string" || !Number.isFinite(grant.until))
        throw new Error(`Abuse state is invalid; repair or remove ${path}`);
      this.grants.set(grant.userId, grant);
    }
  }

  private save(): void {
    const path = this.options.statePath;
    if (!path) return;
    const state: StoredAbuseState = {
      version: 1,
      blocks: [...this.blocks.values()],
      grants: [...this.grants.values()],
    };
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  }
}

function bound(map: Map<string, unknown>): void {
  while (map.size > MAX_TRACKED_KEYS) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) return;
    map.delete(oldest);
  }
}

/**
 * Case, Unicode compatibility forms, punctuation, and spacing are ignored; words, numbers, and
 * attachments are not, so "check PR 12" and "check PR 13" stay distinct.
 */
export function normalizePrompt(prompt: string): string {
  return prompt
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function fingerprint(prompt: string, fileIds: readonly string[]): string {
  return createHash("sha256")
    .update(normalizePrompt(prompt))
    .update("\u0000")
    .update([...fileIds].sort().join(","))
    .digest("hex")
    .slice(0, 32);
}

const FENCED_CODE = /```[\s\S]*?```/g;
const NOISE = /:[a-z0-9_+'-]+:|<[@!][^>]*>/gi;
const LINK = /https?:\/\/[^\s<>|]+/gi;
const MENTION =
  /<@[UW][A-Z0-9]+(?:\|[^>]*)?>|<!(?:subteam\^[A-Z0-9]+|here|channel|everyone)[^>]*>/g;
/** A short word-like unit repeated many times; punctuation-only separators such as `====` pass. */
const REPEATED_UNIT = /((?=\S{0,9}[\p{L}\p{N}])\S{1,10}?\s?)\1{49,}/u;
const FAN_OUT_AUDIENCE =
  /\b(?:dm|message|ping|notify|text|email|remind|spam)\s+(?:every(?:one|body)|all\s+(?:the\s+)?(?:users|members|people|employees|staff))\b/i;
const FAN_OUT_COUNT =
  /\b(?:send|post|repeat|run|do|create|schedule|ping|message|dm|spam|generate|write|make)\b[^.?!\n]{0,40}?\b(\d{2,}|dozens|hundreds|thousands)\s+(?:of\s+)?(?:times|messages|dms|pings|reminders|schedules|automations|watches|copies|posts|replies|variations)\b(?!\s+(?:slower|faster|more|less|larger|bigger|smaller|longer|shorter|as)\b)/i;
const MAX_LINKS = 12;
const MAX_MENTIONS = 5;
const FAN_OUT_MINIMUM = 10;

/** Narrow, explainable spam rules; pasted code blocks are exempt from repetition checks. */
export function isSpam(prompt: string, fileCount: number): boolean {
  if (fileCount === 0 && !/[\p{L}\p{N}]/u.test(prompt.replace(NOISE, ""))) return true;
  if (new Set(prompt.match(LINK) ?? []).size > MAX_LINKS) return true;
  if (new Set(prompt.match(MENTION) ?? []).size > MAX_MENTIONS) return true;

  const prose = prompt.replace(FENCED_CODE, " ");
  if (REPEATED_UNIT.test(prose)) return true;
  const words = normalizePrompt(prose).split(" ").filter(Boolean);
  if (words.length >= 30 && maxCount(words) / words.length >= 0.5) return true;
  const lines = prose
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const repeatedLine = maxCount(lines);
  if (repeatedLine >= 10 && repeatedLine / lines.length >= 0.5) return true;

  if (FAN_OUT_AUDIENCE.test(prose)) return true;
  const fanOut = FAN_OUT_COUNT.exec(prose)?.[1];
  return fanOut !== undefined && countValue(fanOut) >= FAN_OUT_MINIMUM;
}

const HIGH_BUDGET_PHRASES = [
  /\b(?:exhaustive(?:ly)?|comprehensive(?:ly)?|extensive(?:ly)?|in[- ]depth|deep|open[- ]ended|unlimited|massive)\s+(?:web\s+|internet\s+|online\s+)?(?:research|literature review|survey|web search(?:es|ing)?|search(?:es|ing)?\s+(?:of|across|through)\s+(?:the\s+)?(?:web|internet|all))\b/i,
  /\bresearch\s+(?:everything|exhaustively|as much as)\b/i,
  /\b(?:search|scour|crawl|scrape|browse)\s+(?:the\s+)?(?:entire|whole|full)\s+(?:web|internet|github|org(?:anization)?)\b/i,
  /\bleave no stone unturned\b/i,
  /\bas many\s+(?:sources|searches|queries|tool calls|tools|lookups|websites|sites|references|citations)\s+as\s+(?:possible|you can)\b/i,
  /\b(?:use|call|make|run|do)\s+(?:as many|unlimited|lots of|tons of|a ton of|hundreds of|thousands of)\s+(?:tools?|tool calls|searches|queries|lookups)\b/i,
  /\b(?:never|don'?t|do not)\s+stop\s+(?:searching|researching|looking|digging|querying)\b/i,
  /\b(?:search|research|look|dig|query)(?:ing)?\b[^.?!\n]{0,30}\b(?:indefinitely|forever|without (?:stopping|limits?))\b/i,
  /\bevery\s+(?:single\s+)?(?:source|website|web page|search result|article|paper|citation)\b/i,
];
const HIGH_BUDGET_COUNT =
  /\b(\d{2,}|dozens|hundreds|thousands)\+?\s+(?:different\s+|separate\s+|unique\s+|distinct\s+)?(?:sources|searches|web searches|queries|tool calls|tool uses|lookups|websites|sites|web pages|references|citations|articles|papers)\b/gi;
const HIGH_BUDGET_MINIMUM = 20;

/**
 * Explicit requests for open-ended research or large tool/source fan-out. Ordinary detailed
 * engineering questions ("explain in depth", "search the codebase for every caller") do not match.
 */
export function isHighBudget(prompt: string): boolean {
  const prose = prompt.replace(FENCED_CODE, " ");
  if (HIGH_BUDGET_PHRASES.some((pattern) => pattern.test(prose))) return true;
  for (const match of prose.matchAll(HIGH_BUDGET_COUNT)) {
    if (countValue(match[1]!) >= HIGH_BUDGET_MINIMUM) return true;
  }
  return false;
}

function countValue(value: string): number {
  const named: Record<string, number> = { dozens: 24, hundreds: 200, thousands: 2_000 };
  return named[value.toLowerCase()] ?? Number(value);
}

function maxCount(values: readonly string[]): number {
  const counts = new Map<string, number>();
  let max = 0;
  for (const value of values) {
    const count = (counts.get(value) ?? 0) + 1;
    counts.set(value, count);
    max = Math.max(max, count);
  }
  return max;
}
