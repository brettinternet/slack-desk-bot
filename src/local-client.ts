import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import type { ConversationEvent } from "./conversation-coordinator.ts";
import {
  isLocalServerMessage,
  LOCAL_PROTOCOL_VERSION,
  MAX_LOCAL_FRAME_BYTES,
  type LocalRequestType,
} from "./local-protocol.ts";

/** Client for the owner-only local control socket, shared by the CLI and MCP adapter. */
export class LocalClient {
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

  static connect(socketPath: string, timeoutMs?: number): Promise<LocalClient> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(socketPath);
      if (timeoutMs) {
        socket.setTimeout(timeoutMs, () =>
          socket.destroy(new Error("SlackDeskBot did not respond in 30 seconds")),
        );
      }
      socket.once("connect", () => {
        socket.off("error", reject);
        resolve(new LocalClient(socket));
      });
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
      if (Buffer.byteLength(line) > MAX_LOCAL_FRAME_BYTES * 4) {
        this.socket.destroy(new Error("Local response exceeds maximum size"));
        return;
      }
      if (!line) continue;
      let message;
      try {
        const value: unknown = JSON.parse(line);
        if (!isLocalServerMessage(value)) throw new Error("unrecognized message");
        message = value;
      } catch {
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
    if (Buffer.byteLength(this.buffer) > MAX_LOCAL_FRAME_BYTES * 4) {
      this.socket.destroy(new Error("Local response exceeds maximum size"));
    }
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}
