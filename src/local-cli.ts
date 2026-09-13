#!/usr/bin/env bun
import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import { createInterface } from "node:readline";
import type { ConversationSummary } from "./agent.ts";
import { defaultSocketPath } from "./config.ts";
import { LOCAL_PROTOCOL_VERSION } from "./local-control.ts";

type ResponseMessage = {
  type: "response";
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
};

type EventMessage = {
  type: "event";
  event: { type: string; response?: string; error?: string };
};

class LocalClient {
  private buffer = "";
  private readonly pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  onEvent?: (event: EventMessage["event"]) => void;

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

  request(type: string, fields: Record<string, unknown> = {}): Promise<unknown> {
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
      const message = JSON.parse(line) as ResponseMessage | EventMessage;
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

function formatAge(timestamp: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

function printSessions(sessions: ConversationSummary[]): void {
  console.log("SESSION   CONVERSATION                 STATE      LAST ACTIVE");
  for (const session of sessions) {
    console.log(
      `${session.sessionId.slice(0, 8).padEnd(9)} ${session.conversationId.slice(0, 28).padEnd(28)} ${session.state.padEnd(10)} ${formatAge(session.lastActiveAt)}`,
    );
  }
}

async function attach(client: LocalClient, sessionId: string): Promise<void> {
  const session = (await client.request("attach", { sessionId })) as ConversationSummary;
  console.log(`Attached to ${session.conversationId}`);
  console.log("Enter a prompt, /status, /cancel, or /quit.");
  client.onEvent = (event) => {
    if (event.type === "response") console.log(`agent> ${event.response ?? ""}`);
    else if (event.type === "failure")
      console.error(`agent error> ${event.error ?? "request failed"}`);
    else if (event.type === "started") console.log("agent> Working…");
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

export async function main(args: string[] = process.argv.slice(2)): Promise<void> {
  const [command, argument] = args;
  if (
    !command ||
    !["sessions", "attach"].includes(command) ||
    (command === "attach" && !argument)
  ) {
    throw new Error("Usage: slack-desk sessions | slack-desk attach <session-id>");
  }
  const socketPath = process.env.SLACK_AGENT_SOCKET_PATH?.trim() || defaultSocketPath();
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
      await attach(client, argument!);
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
