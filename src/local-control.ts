import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, stat, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import type { ConversationCoordinator, ConversationEvent } from "./conversation-coordinator.ts";

export const LOCAL_PROTOCOL_VERSION = 1;
export const MAX_LOCAL_FRAME_BYTES = 64 * 1024;
const MAX_LOCAL_CLIENTS = 8;
const MAX_PENDING_REQUESTS = 4;
const MAX_BUFFERED_BYTES = 256 * 1024;

interface LocalControlOptions {
  socketPath: string;
  coordinator: ConversationCoordinator;
  peerOwner?: (socket: Socket) => boolean;
}

interface ClientState {
  socket: Socket;
  buffer: Buffer;
  pending: number;
  detach?: () => void;
  conversationId?: string;
}

type ProtocolRequest = {
  v: 1;
  type: "list" | "attach" | "run" | "status" | "cancel";
  requestId: string;
  sessionId?: string;
  prompt?: string;
};

export class LocalControlServer {
  private server?: Server;
  private readonly clients = new Set<ClientState>();

  constructor(private readonly options: LocalControlOptions) {}

  async start(): Promise<void> {
    if (this.server) return;
    await prepareSocketPath(this.options.socketPath);
    const server = createServer((socket) => this.accept(socket));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.options.socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    }).catch((error) => {
      this.server = undefined;
      throw error;
    });
    await chmod(this.options.socketPath, 0o600);
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = undefined;
    for (const client of this.clients) {
      client.detach?.();
      client.socket.destroy();
    }
    this.clients.clear();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      const metadata = await lstat(this.options.socketPath);
      if (metadata.isSocket() && metadata.uid === process.getuid?.()) {
        await unlink(this.options.socketPath);
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }

  private accept(socket: Socket): void {
    if (
      this.clients.size >= MAX_LOCAL_CLIENTS ||
      !(this.options.peerOwner ?? isOwnerPeer)(socket)
    ) {
      socket.destroy();
      return;
    }
    const client: ClientState = { socket, buffer: Buffer.alloc(0), pending: 0 };
    this.clients.add(client);
    socket.on("data", (chunk) => this.receive(client, chunk));
    socket.on("close", () => this.disconnect(client));
    socket.on("error", () => this.disconnect(client));
  }

  private receive(client: ClientState, chunk: Buffer): void {
    client.buffer = Buffer.concat([client.buffer, chunk]);
    if (client.buffer.length > MAX_LOCAL_FRAME_BYTES && !client.buffer.includes(10)) {
      this.sendError(client, undefined, "Frame exceeds maximum size");
      client.socket.destroy();
      return;
    }

    let newline: number;
    while ((newline = client.buffer.indexOf(10)) >= 0) {
      const frame = client.buffer.subarray(0, newline);
      client.buffer = client.buffer.subarray(newline + 1);
      if (frame.length > MAX_LOCAL_FRAME_BYTES) {
        this.sendError(client, undefined, "Frame exceeds maximum size");
        client.socket.destroy();
        return;
      }
      if (frame.length === 0) continue;
      void this.handleFrame(client, frame);
    }
  }

  private async handleFrame(client: ClientState, frame: Buffer): Promise<void> {
    let request: ProtocolRequest;
    try {
      const value: unknown = JSON.parse(frame.toString("utf8"));
      if (!isRequest(value)) throw new Error("Invalid protocol request");
      request = value;
    } catch (error) {
      this.sendError(
        client,
        undefined,
        error instanceof Error ? error.message : "Malformed JSON request",
      );
      return;
    }

    if (client.pending >= MAX_PENDING_REQUESTS) {
      this.sendError(client, request.requestId, "Too many pending requests");
      return;
    }
    client.pending++;
    try {
      const result = await this.dispatch(client, request);
      this.send(client, {
        v: LOCAL_PROTOCOL_VERSION,
        type: "response",
        requestId: request.requestId,
        ok: true,
        result,
      });
    } catch (error) {
      this.sendError(
        client,
        request.requestId,
        error instanceof Error ? error.message : "Request failed",
      );
    } finally {
      client.pending--;
    }
  }

  private async dispatch(client: ClientState, request: ProtocolRequest): Promise<unknown> {
    if (request.type === "list") return this.options.coordinator.listConversations();
    if (request.type === "attach") {
      if (!request.sessionId) throw new Error("sessionId is required");
      const summaries = await this.options.coordinator.listConversations();
      const matches = summaries.filter(
        ({ sessionId }) =>
          sessionId === request.sessionId || sessionId.startsWith(request.sessionId!),
      );
      if (matches.length === 0) throw new Error("Session not found");
      if (matches.length > 1) throw new Error("Session ID is ambiguous");
      client.detach?.();
      client.conversationId = matches[0]!.conversationId;
      client.detach = this.options.coordinator.subscribe(client.conversationId, (event) =>
        this.sendEvent(client, event),
      );
      return matches[0];
    }
    if (!client.conversationId) throw new Error("Attach to a session first");
    if (request.type === "run") {
      if (typeof request.prompt !== "string" || !request.prompt.trim()) {
        throw new Error("prompt is required");
      }
      return {
        response: boundedProtocolText(
          await this.options.coordinator.runOperator(client.conversationId, request.prompt),
        ),
      };
    }
    if (request.type === "status") {
      return {
        status: boundedProtocolText(
          await this.options.coordinator.handleCommand(
            client.conversationId,
            "local-operator",
            "status",
          ),
        ),
      };
    }
    if (request.type === "cancel") {
      return { cancelled: this.options.coordinator.cancelOperator(client.conversationId) };
    }
    throw new Error("Unsupported request type");
  }

  private sendEvent(client: ClientState, event: ConversationEvent): void {
    this.send(client, { v: LOCAL_PROTOCOL_VERSION, type: "event", event });
  }

  private sendError(client: ClientState, requestId: string | undefined, message: string): void {
    this.send(client, {
      v: LOCAL_PROTOCOL_VERSION,
      type: "response",
      requestId: requestId ?? randomUUID(),
      ok: false,
      error: message,
    });
  }

  private send(client: ClientState, message: unknown): void {
    if (client.socket.destroyed) return;
    const frame = `${JSON.stringify(message)}\n`;
    if (client.socket.writableLength + Buffer.byteLength(frame) > MAX_BUFFERED_BYTES) {
      client.socket.destroy();
      return;
    }
    client.socket.write(frame);
  }

  private disconnect(client: ClientState): void {
    client.detach?.();
    this.clients.delete(client);
  }
}

function boundedProtocolText(text: string): string {
  const maxCharacters = 16_000;
  return text.length <= maxCharacters
    ? text
    : `${text.slice(0, maxCharacters)}\n\n[Local response truncated]`;
}

function isOwnerPeer(socket: Socket): boolean {
  const credentials = socket as Socket & {
    getPeerCredentials?: () => { uid?: number };
  };
  if (!credentials.getPeerCredentials) return true;
  try {
    return credentials.getPeerCredentials().uid === process.getuid?.();
  } catch {
    return false;
  }
}

function isRequest(value: unknown): value is ProtocolRequest {
  if (typeof value !== "object" || value === null) return false;
  const request = value as Record<string, unknown>;
  return (
    request.v === LOCAL_PROTOCOL_VERSION &&
    typeof request.requestId === "string" &&
    request.requestId.length > 0 &&
    ["list", "attach", "run", "status", "cancel"].includes(String(request.type))
  );
}

async function prepareSocketPath(socketPath: string): Promise<void> {
  const parent = dirname(socketPath);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const parentMetadata = await stat(parent);
  const uid = process.getuid?.();
  if (!parentMetadata.isDirectory() || (uid !== undefined && parentMetadata.uid !== uid)) {
    throw new Error("Local control socket parent must be an owner-controlled directory");
  }
  await chmod(parent, 0o700);

  let socketMetadata;
  try {
    socketMetadata = await lstat(socketPath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  if (!socketMetadata.isSocket() || (uid !== undefined && socketMetadata.uid !== uid)) {
    throw new Error("Local control socket path is occupied by an unsafe file");
  }
  if (await socketAcceptsConnections(socketPath)) {
    throw new Error("Another SlackDeskBot process owns the local control socket");
  }
  await unlink(socketPath);
}

async function socketAcceptsConnections(socketPath: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      socket.destroy();
      if (error.code === "ECONNREFUSED" || error.code === "ENOENT") resolve(false);
      else reject(error);
    });
  });
}
