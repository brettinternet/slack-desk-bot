#!/usr/bin/env bun
import { createInterface } from "node:readline";
import type { ConversationSummary, DirectMessageReceipt } from "./agent.ts";
import { defaultSocketPath } from "./config.ts";
import type { Schedule, ScheduleInput } from "./schedules.ts";
import type { DmAuditConversationsPage, DmAuditMessage, DmAuditMessagesPage } from "./dm-audit.ts";
import { IDENTITY_USAGE, runIdentityCommand } from "./identity-cli.ts";
import { LocalClient } from "./local-client.ts";
import type { ConversationEvent } from "./conversation-coordinator.ts";
import type { LocalRequestType } from "./local-protocol.ts";

const USAGE = `Usage: slack-desk [--socket <path>] sessions | slack-desk [--socket <path>] attach <session-id> [--history <0-100> | --no-history] | slack-desk [--socket <path>] dm <slack-user-id> <message...>\n       slack-desk [--socket <path>] dm audit [--since <YYYY-MM-DD | ISO-offset>] [--to <user-id>] [--json]\n       slack-desk [--socket <path>] schedule list | cancel <id> | add <user-id> (--at <ISO-offset> | --daily <HH:mm> --tz <IANA-zone> | --weekly <0-6,...> --time <HH:mm> --tz <IANA-zone>) <message...>\n       slack-desk [--socket <path>] schedule update <id> <user-id> (--at ... | --daily ... | --weekly ...) <message...>\n${IDENTITY_USAGE}`;

function terminalText(text: string): string {
  return text
    .replace(/\u001b(?:\[[0-?]*[ -/]*[@-~]|[@-_])/g, "")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}

function terminalLine(text: string): string {
  return terminalText(text).replace(/\s+/g, " ").trim();
}

function formatAge(timestamp: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

export function formatSessions(sessions: ConversationSummary[], now = Date.now()): string[] {
  const labels = sessions.map((session) =>
    terminalLine(session.details?.label ?? session.conversationId),
  );
  const conversationWidth = Math.max("CONVERSATION".length, ...labels.map((label) => label.length));
  const participantLabels = sessions.map(
    (session) =>
      session.details?.participants.map(({ name }) => terminalLine(name)).join(", ") || "-",
  );
  const participantWidth = Math.max(
    "PARTICIPANTS".length,
    ...participantLabels.map((label) => label.length),
  );
  return [
    `SESSION   ${"CONVERSATION".padEnd(conversationWidth)} ${"PARTICIPANTS".padEnd(participantWidth)} STATE      LAST ACTIVE`,
    ...sessions.map(
      (session, index) =>
        `${session.sessionId.slice(0, 8).padEnd(9)} ${labels[index]!.padEnd(conversationWidth)} ${participantLabels[index]!.padEnd(participantWidth)} ${session.state.padEnd(10)} ${formatAge(session.lastActiveAt, now)}`,
    ),
  ];
}

export function formatHistory(session: ConversationSummary): string[] {
  const details = session.details;
  if (!details) return [];
  const lines = [terminalLine(details.label)];
  const participants = details.participants.map((participant) =>
    participant.handle
      ? `${terminalLine(participant.name)} (@${terminalLine(participant.handle)}, ${terminalLine(participant.id)})`
      : `${terminalLine(participant.name)} (${terminalLine(participant.id)})`,
  );
  if (participants.length > 0) lines.push(`Participants: ${participants.join(", ")}`);
  if (details.permalink) lines.push(`Slack: ${terminalLine(details.permalink)}`);
  if (details.historyUnavailable) lines.push(terminalLine(details.historyUnavailable));
  if (details.history.length > 0) {
    lines.push("── recent history ──");
    for (const entry of details.history) {
      const time = Number.isFinite(entry.timestamp)
        ? new Date(entry.timestamp).toISOString().replace("T", " ").slice(0, 19)
        : "unknown time";
      lines.push(`[${time}] ${terminalLine(entry.authorName)}> ${terminalText(entry.text)}`);
      for (const attachment of entry.attachments ?? []) {
        lines.push(`  attachment: ${terminalLine(attachment)}`);
      }
    }
    lines.push("── live events ──");
  }
  return lines;
}

export class ConversationEventFormatter {
  private readonly queuedPrompts = new Map<string, number>();

  format(event: ConversationEvent): string[] {
    if (event.type === "response") return [`agent> ${terminalText(event.response ?? "")}`];
    if (event.type === "failure") {
      return [`agent error> ${terminalText(event.error ?? "request failed")}`];
    }
    if (event.type !== "queued" && event.type !== "started") return [];

    const prompt = this.promptLine(event);
    if (!prompt) return event.type === "started" ? ["agent> Working…"] : [];
    const key = `${event.requesterKind}\0${event.promptExcerpt}`;
    if (event.type === "queued") {
      this.queuedPrompts.set(key, (this.queuedPrompts.get(key) ?? 0) + 1);
      return [prompt];
    }

    const queued = this.queuedPrompts.get(key) ?? 0;
    if (queued <= 1) this.queuedPrompts.delete(key);
    else this.queuedPrompts.set(key, queued - 1);
    return queued > 0 ? ["agent> Working…"] : [prompt, "agent> Working…"];
  }

  private promptLine(event: ConversationEvent): string | undefined {
    if (!event.requesterKind || event.promptExcerpt === undefined) return undefined;
    const label = event.requesterKind === "operator" ? "operator" : "user";
    return `${label}> ${terminalLine(event.promptExcerpt)}`;
  }
}

function printSessions(sessions: ConversationSummary[]): void {
  for (const line of formatSessions(sessions)) console.log(line);
}

async function attach(
  client: LocalClient,
  sessionId: string,
  historyLimit?: number,
): Promise<void> {
  const session = (await client.request("attach", {
    sessionId,
    historyLimit,
  })) as ConversationSummary;
  console.log(`Attached to ${session.conversationId}`);
  for (const line of formatHistory(session)) console.log(line);
  console.log("Enter a prompt, /status, /cancel, or /quit.");
  const formatter = new ConversationEventFormatter();
  client.onEvent = (event) => {
    for (const line of formatter.format(event)) {
      if (event.type === "failure") console.error(line);
      else console.log(line);
    }
  };

  const input = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "operator> ",
  });
  input.prompt();
  input.on("line", async (line) => {
    const value = line.trim();
    try {
      if (value === "/quit") {
        input.close();
        return;
      }
      if (value === "/status") {
        const result = (await client.request("status")) as { status: string };
        console.log(result.status);
      } else if (value === "/cancel") {
        const result = (await client.request("cancel")) as { cancelled: boolean };
        console.log(result.cancelled ? "Cancellation requested." : "No active request.");
      } else if (value) {
        await client.request("run", { prompt: value });
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : "Request failed");
    }
    input.prompt();
  });
  await new Promise<void>((resolve) => input.once("close", resolve));
}

export function parseArguments(args: readonly string[]): {
  command: "sessions" | "attach" | "dm";
  sessionId?: string;
  userId?: string;
  text?: string;
  socketPath?: string;
  historyLimit?: number;
} {
  const positional: string[] = [];
  let dmText: string[] | undefined;
  let socketPath: string | undefined;
  let historyLimit: number | undefined;
  for (let index = 0; index < args.length; index++) {
    const value = args[index]!;
    if (value === "--socket") {
      socketPath = args[++index];
      if (!socketPath) throw new Error("--socket requires a path");
    } else if (value.startsWith("--socket=")) {
      socketPath = value.slice("--socket=".length);
      if (!socketPath) throw new Error("--socket requires a path");
    } else if (value === "--no-history") {
      historyLimit = 0;
    } else if (value === "--history") {
      const requested = args[++index];
      if (!requested || !/^\d+$/.test(requested)) throw new Error("--history requires 0-100");
      historyLimit = Number(requested);
      if (historyLimit > 100) throw new Error("--history requires 0-100");
    } else if (value.startsWith("--history=")) {
      const requested = value.slice("--history=".length);
      if (!/^\d+$/.test(requested)) throw new Error("--history requires 0-100");
      historyLimit = Number(requested);
      if (historyLimit > 100) throw new Error("--history requires 0-100");
    } else if (positional[0] === "dm" && positional.length === 2) {
      // Everything after the recipient is message text, including flag-like words.
      dmText = args.slice(index);
      break;
    } else {
      positional.push(value);
    }
  }
  const [command, sessionId] = positional;
  if (command === "dm") {
    const text = dmText?.join(" ").trim();
    if (!sessionId || !text || historyLimit !== undefined) throw new Error(USAGE);
    return { command, userId: sessionId, text, socketPath };
  }
  if (command !== "sessions" && command !== "attach") {
    throw new Error(USAGE);
  }
  if (command === "attach" && !sessionId) throw new Error(USAGE);
  if (command === "sessions" && historyLimit !== undefined) throw new Error(USAGE);
  return { command, sessionId, socketPath, historyLimit };
}

export function parseScheduleArguments(args: readonly string[]): {
  socketPath?: string;
  type: LocalRequestType;
  id?: string;
  input?: ScheduleInput;
} {
  const tokens = [...args];
  let socketPath: string | undefined;
  if (tokens[0] === "--socket") {
    socketPath = tokens[1];
    tokens.splice(0, 2);
    if (!socketPath) throw new Error("--socket requires a path");
  } else if (tokens[0]?.startsWith("--socket=")) {
    socketPath = tokens.shift()!.slice(9);
    if (!socketPath) throw new Error("--socket requires a path");
  }
  if (tokens.shift() !== "schedule") throw new Error(USAGE);
  const verb = tokens.shift();
  if (verb === "list" && tokens.length === 0) return { socketPath, type: "schedule-list" };
  if (verb === "cancel" && tokens.length === 1)
    return { socketPath, type: "schedule-cancel", id: tokens[0] };
  if (verb !== "add" && verb !== "update") throw new Error(USAGE);
  const id = verb === "update" ? tokens.shift() : undefined;
  const userId = tokens.shift();
  if (!userId || (verb === "update" && !id)) throw new Error(USAGE);
  let at: string | undefined;
  let time: string | undefined;
  let timezone: string | undefined;
  let weekdays: number[] | undefined;
  let scheduleKind: "daily" | "weekly" | undefined;
  while (tokens[0]?.startsWith("--")) {
    const flag = tokens.shift();
    const value = tokens.shift();
    if (!value) throw new Error(`${flag} requires a value`);
    if (flag === "--at") at = value;
    else if (flag === "--daily") {
      scheduleKind = "daily";
      time = value;
    } else if (flag === "--weekly") {
      scheduleKind = "weekly";
      weekdays = value.split(",").map(Number);
    } else if (flag === "--time") time = value;
    else if (flag === "--tz") timezone = value;
    else throw new Error(USAGE);
  }
  const text = tokens.join(" ").trim();
  if (
    !text ||
    (at
      ? Boolean(scheduleKind || time || timezone || weekdays)
      : !scheduleKind || !time || !timezone) ||
    (scheduleKind === "weekly" && !weekdays)
  )
    throw new Error(USAGE);
  const input: ScheduleInput = {
    userId,
    text,
    ...(at
      ? { at }
      : { recurrence: { time: time!, timezone: timezone!, ...(weekdays ? { weekdays } : {}) } }),
  };
  return { socketPath, type: verb === "add" ? "schedule-create" : "schedule-update", id, input };
}

export function parseDmAuditArguments(args: readonly string[]): {
  socketPath?: string;
  oldest: string;
  recentOnly: boolean;
  userId?: string;
  json: boolean;
} {
  const tokens = [...args];
  let socketPath: string | undefined;
  if (tokens[0] === "--socket") {
    socketPath = tokens[1];
    tokens.splice(0, 2);
    if (!socketPath) throw new Error("--socket requires a path");
  } else if (tokens[0]?.startsWith("--socket=")) {
    socketPath = tokens.shift()!.slice(9);
    if (!socketPath) throw new Error("--socket requires a path");
  }
  if (tokens.shift() !== "dm" || tokens.shift() !== "audit") throw new Error(USAGE);
  let since: string | undefined;
  let userId: string | undefined;
  let json = false;
  while (tokens.length > 0) {
    const flag = tokens.shift();
    if (flag === "--json" && !json) json = true;
    else if (flag === "--since" && !since) {
      since = tokens.shift();
      if (!since) throw new Error(USAGE);
    } else if (flag === "--to" && !userId) {
      userId = tokens.shift();
      if (!userId) throw new Error(USAGE);
    } else throw new Error(USAGE);
  }
  if (
    (since !== undefined &&
      (!(
        /^\d{4}-\d{2}-\d{2}$/.test(since) ||
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(since)
      ) ||
        !Number.isFinite(Date.parse(since)))) ||
    (userId !== undefined && !/^[UW][A-Z0-9]+$/.test(userId))
  )
    throw new Error(USAGE);
  if (
    since &&
    /^\d{4}-\d{2}-\d{2}$/.test(since) &&
    new Date(Date.parse(since)).toISOString().slice(0, 10) !== since
  )
    throw new Error(USAGE);
  const sinceMs = since ? Date.parse(since) : undefined;
  if (sinceMs !== undefined && sinceMs > Date.now())
    throw new Error("--since must not be in the future");
  return {
    socketPath,
    oldest: sinceMs === undefined ? "0" : String(sinceMs / 1_000 - 0.000001),
    recentOnly: sinceMs === undefined,
    userId,
    json,
  };
}

export async function auditDms(
  client: LocalClient,
  options: ReturnType<typeof parseDmAuditArguments>,
  print: (line: string) => void = console.log,
): Promise<void> {
  let cursor: string | undefined;
  let count = 0;
  const recent: DmAuditMessage[] = [];
  const until = String(Date.now() / 1_000);
  do {
    const page = (await client.request("dm-audit-conversations", {
      cursor,
    })) as DmAuditConversationsPage;
    for (const conversation of page.conversations) {
      if (options.userId && options.userId !== conversation.recipientId) continue;
      let latest: string | undefined = until;
      let heading = false;
      const emitMessage = (message: DmAuditMessage): void => {
        if (options.recentOnly) {
          recent.push(message);
          if (recent.length > 100) {
            recent.sort((a, b) => Number(b.ts) - Number(a.ts));
            recent.pop();
          }
          return;
        }
        count++;
        if (options.json) print(JSON.stringify(message));
        else {
          if (!heading) {
            print(`── ${terminalLine(message.recipientId)} ──`);
            heading = true;
          }
          print(
            `[${new Date(Number(message.ts) * 1_000).toISOString()}] ${terminalText(message.text).replace(/\n/g, "\n    ")}`,
          );
          print(`  ${terminalLine(message.permalink)}`);
        }
      };
      do {
        const history = (await client.request("dm-audit-messages", {
          channel: conversation.channel,
          userId: conversation.recipientId,
          oldest: options.oldest,
          latest,
        })) as DmAuditMessagesPage;
        for (const message of history.messages) emitMessage(message);
        for (const threadTs of history.threads) {
          let threadOldest = options.oldest;
          let threadCursor: string | undefined;
          do {
            const replies = (await client.request("dm-audit-messages", {
              channel: conversation.channel,
              userId: conversation.recipientId,
              oldest: threadOldest,
              latest: until,
              threadTs,
              cursor: threadCursor,
            })) as DmAuditMessagesPage;
            for (const message of replies.messages) emitMessage(message);
            if (replies.nextOldest) threadOldest = replies.nextOldest;
            threadCursor = replies.nextCursor;
            if (!threadCursor && !replies.nextOldest) break;
          } while (true);
        }
        latest = history.nextLatest;
      } while (latest);
    }
    cursor = page.nextCursor;
  } while (cursor);
  if (options.recentOnly) {
    recent.sort((a, b) => Number(b.ts) - Number(a.ts));
    for (const message of recent) {
      if (options.json) print(JSON.stringify(message));
      else {
        print(
          `[${new Date(Number(message.ts) * 1_000).toISOString()}] ${terminalLine(message.recipientId)}: ${terminalText(message.text).replace(/\n/g, "\n    ")}`,
        );
        print(`  ${terminalLine(message.permalink)}`);
      }
    }
    count = recent.length;
  }
  if (!count && !options.json) print("No bot-authored DMs found.");
}

export async function main(args: string[] = process.argv.slice(2)): Promise<void> {
  if (
    (args[0] === "dm" && args[1] === "audit") ||
    (args[0] === "--socket" && args[2] === "dm" && args[3] === "audit") ||
    (args[0]?.startsWith("--socket=") && args[1] === "dm" && args[2] === "audit")
  ) {
    const options = parseDmAuditArguments(args);
    const socketPath =
      options.socketPath ?? (process.env.SLACK_AGENT_SOCKET_PATH?.trim() || defaultSocketPath());
    let client: LocalClient;
    try {
      client = await LocalClient.connect(socketPath);
    } catch {
      throw new Error(`Cannot connect to SlackDeskBot at ${socketPath}`);
    }
    try {
      await auditDms(client, options);
    } finally {
      client.close();
    }
    return;
  }
  if (
    args[0] === "schedule" ||
    (args[0] === "--socket" && args[2] === "schedule") ||
    (args[0]?.startsWith("--socket=") && args[1] === "schedule")
  ) {
    const { socketPath: requested, type, id, input } = parseScheduleArguments(args);
    const socketPath =
      requested ?? (process.env.SLACK_AGENT_SOCKET_PATH?.trim() || defaultSocketPath());
    let client: LocalClient;
    try {
      client = await LocalClient.connect(socketPath);
    } catch {
      throw new Error(`Cannot connect to SlackDeskBot at ${socketPath}`);
    }
    try {
      const result = await client.request(type, { ...(id ? { id } : {}), ...input });
      if (type === "schedule-list") {
        for (const item of result as Schedule[])
          console.log(
            `${item.id} ${item.status} ${item.nextAt} ${item.userId} ${item.recurrence ? `${item.recurrence.time} ${item.recurrence.timezone} ${item.recurrence.weekdays?.join(",") ?? "daily"}` : "once"} ${terminalLine(item.text)}${item.lastError ? ` [last error: ${terminalLine(item.lastError)}]` : ""}`,
          );
      } else if (type === "schedule-cancel") console.log(`Cancelled ${id}`);
      else {
        const item = result as Schedule;
        console.log(`Scheduled ${item.id} for ${item.nextAt}`);
      }
    } finally {
      client.close();
    }
    return;
  }
  if (args[0] === "identities") {
    await runIdentityCommand(args.slice(1), { botToken: process.env.SLACK_BOT_TOKEN });
    return;
  }
  const {
    command,
    sessionId,
    userId,
    text,
    socketPath: requested,
    historyLimit,
  } = parseArguments(args);
  const socketPath =
    requested ?? (process.env.SLACK_AGENT_SOCKET_PATH?.trim() || defaultSocketPath());
  let client: LocalClient;
  try {
    client = await LocalClient.connect(socketPath);
  } catch {
    throw new Error(`Cannot connect to SlackDeskBot at ${socketPath}`);
  }
  try {
    if (command === "sessions") {
      printSessions((await client.request("list")) as ConversationSummary[]);
    } else if (command === "dm") {
      const receipt = (await client.request("dm", { userId, text })) as DirectMessageReceipt;
      console.log(`Sent to ${terminalLine(receipt.recipientName)} (${receipt.recipientId})`);
    } else {
      await attach(client, sessionId!, historyLimit);
    }
  } finally {
    client.close();
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "slack-desk failed");
    process.exitCode = 1;
  });
}
