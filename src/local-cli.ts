#!/usr/bin/env bun
import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import { createInterface } from "node:readline";
import type { ConversationSummary } from "./agent.ts";
import { defaultSocketPath } from "./config.ts";
import type { ConversationEvent } from "./conversation-coordinator.ts";
import {
  isLocalServerMessage,
  LOCAL_PROTOCOL_VERSION,
  type LocalRequestType,
} from "./local-protocol.ts";

class LocalClient {
  private buffer = "";
  private readonly pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  onEvent?: (event: ConversationEvent) => void;

  private constructor(private readonly socket: Socket) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => this.receive(String(chunk)));
    socket.on("close", () => this.failPending(new Error("SlackDeskBot disconnected")));
    socket.on("error", (error) => this.failPending(error));
  }

  static connect(socketPath: string): Promise<LocalClient> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(socketPath);
      socket.once("connect", () => resolve(new LocalClient(socket)));
      socket.once("error", reject);
    });
  }

  request(type: LocalRequestType, fields: Record<string, unknown> = {}): Promise<unknown> {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      this.socket.write(
        `${JSON.stringify({ v: LOCAL_PROTOCOL_VERSION, type, requestId, ...fields })}\n`,
      );
    });
  }

  close(): void {
    this.socket.end();
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        const value: unknown = JSON.parse(line);
        if (!isLocalServerMessage(value)) throw new Error("unrecognized message");
        message = value;
      } catch {
        // A malformed or unsupported frame must not kill the client.
        console.error("Ignoring an unrecognized message from SlackDeskBot");
        continue;
      }
      if (message.type === "event") {
        this.onEvent?.(message.event);
        continue;
      }
      const pending = this.pending.get(message.requestId);
      if (!pending) continue;
      this.pending.delete(message.requestId);
      if (message.ok) pending.resolve(message.result);
      else pending.reject(new Error(message.error ?? "Local control request failed"));
    }
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

const USAGE =
  "Usage: slack-desk [--socket <path>] sessions | slack-desk [--socket <path>] attach <session-id>";

function formatAge(timestamp: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

export function formatSessions(sessions: ConversationSummary[], now = Date.now()): string[] {
  const conversationWidth = Math.max(
    "CONVERSATION".length,
    ...sessions.map(({ conversationId }) => conversationId.length),
  );
  return [
    `SESSION   ${"CONVERSATION".padEnd(conversationWidth)} STATE      LAST ACTIVE`,
    ...sessions.map(
      (session) =>
        `${session.sessionId.slice(0, 8).padEnd(9)} ${session.conversationId.padEnd(conversationWidth)} ${session.state.padEnd(10)} ${formatAge(session.lastActiveAt, now)}`,
    ),
  ];
}

export class ConversationEventFormatter {
  private readonly queuedPrompts = new Map<string, number>();

  format(event: ConversationEvent): string[] {
    if (event.type === "response") return [`agent> ${event.response ?? ""}`];
    if (event.type === "failure") return [`agent error> ${event.error ?? "request failed"}`];
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
    return `${label}> ${event.promptExcerpt}`;
  }
}

function printSessions(sessions: ConversationSummary[]): void {
  for (const line of formatSessions(sessions)) console.log(line);
}

async function attach(client: LocalClient, sessionId: string): Promise<void> {
  const session = (await client.request("attach", { sessionId })) as ConversationSummary;
  console.log(`Attached to ${session.conversationId}`);
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
  command: "sessions" | "attach";
  sessionId?: string;
  socketPath?: string;
} {
  const positional: string[] = [];
  let socketPath: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const value = args[index]!;
    if (value === "--socket") {
      socketPath = args[++index];
      if (!socketPath) throw new Error("--socket requires a path");
    } else if (value.startsWith("--socket=")) {
      socketPath = value.slice("--socket=".length);
      if (!socketPath) throw new Error("--socket requires a path");
    } else {
      positional.push(value);
    }
  }
  const [command, sessionId] = positional;
  if (command !== "sessions" && command !== "attach") {
    throw new Error(USAGE);
  }
  if (command === "attach" && !sessionId) throw new Error(USAGE);
  return { command, sessionId, socketPath };
}

export async function main(args: string[] = process.argv.slice(2)): Promise<void> {
  const { command, sessionId, socketPath: requested } = parseArguments(args);
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
    } else {
      await attach(client, sessionId!);
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
