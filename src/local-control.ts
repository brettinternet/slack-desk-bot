import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, stat, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import type {
  ConversationInspector,
  ConversationSummary,
  DirectMessage,
  DirectMessageReceipt,
} from "./agent.ts";
import type { ConversationCoordinator, ConversationEvent } from "./conversation-coordinator.ts";
import type { ScheduleInput, ScheduleService } from "./schedules.ts";
import type { DmAuditConversationsPage, DmAuditMessagesPage, DmAuditQuery } from "./dm-audit.ts";
import type { PersonMatch } from "./people-lookup.ts";
import {
  isLocalRequest,
  LOCAL_OPERATOR_ID,
  LOCAL_PROTOCOL_VERSION,
  MAX_LOCAL_FRAME_BYTES,
  type LocalRequest,
} from "./local-protocol.ts";

export { LOCAL_PROTOCOL_VERSION, MAX_LOCAL_FRAME_BYTES };

const MAX_LOCAL_CLIENTS = 8;
const MAX_PENDING_REQUESTS = 4;
const MAX_BUFFERED_BYTES = 256 * 1024;

interface LocalControlOptions {
  socketPath: string;
  coordinator: ConversationCoordinator;
  inspector?: ConversationInspector;
  sendDirectMessage?: (message: DirectMessage) => Promise<DirectMessageReceipt>;
  leaveChannel?: (channel: string) => Promise<void>;
  listDmAuditConversations?: (cursor?: string) => Promise<DmAuditConversationsPage>;
  auditDmMessages?: (query: DmAuditQuery) => Promise<DmAuditMessagesPage>;
  findPeople?: (query: string) => Promise<PersonMatch[]>;
  schedules?: ScheduleService;
  /**
   * Test seam for simulating a rejected peer. Neither Node nor Bun exposes
   * `SO_PEERCRED`/`getpeereid`, so the real boundary is the owner-only `0700`
   * parent directory and `0600` socket enforced in `prepareSocketPath`.
   */
  acceptPeer?: (socket: Socket) => boolean;
}

interface ClientState {
  socket: Socket;
  buffer: Buffer;
  pending: number;
  detach?: () => void;
  conversationId?: string;
}

export class LocalControlServer {
  private server?: Server;
  private readonly clients = new Set<ClientState>();

  constructor(private readonly options: LocalControlOptions) {}

  async start(): Promise<void> {
    if (this.server) return;
    await prepareSocketPath(this.options.socketPath);
    const server = createServer((socket) => this.accept(socket));
    this.server = server;
    // Bind under a restrictive umask so the socket is never briefly
    // group/world-accessible between listen() and a follow-up chmod.
    const previousUmask = process.umask(0o077);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(this.options.socketPath, () => {
          server.off("error", reject);
          resolve();
        });
      });
    } catch (error) {
      this.server = undefined;
      throw error;
    } finally {
      process.umask(previousUmask);
    }
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
    if (this.clients.size >= MAX_LOCAL_CLIENTS || this.options.acceptPeer?.(socket) === false) {
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
    let request: LocalRequest;
    try {
      const value: unknown = JSON.parse(frame.toString("utf8"));
      if (!isLocalRequest(value)) throw new Error("Invalid protocol request");
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

  private async dispatch(client: ClientState, request: LocalRequest): Promise<unknown> {
    if (request.type === "list") {
      const summaries = await this.options.coordinator.listConversations();
      const detailed: ConversationSummary[] = [];
      for (let index = 0; index < summaries.length; index += 4) {
        detailed.push(
          ...(await Promise.all(
            summaries.slice(index, index + 4).map((summary) => this.withDetails(summary, 0)),
          )),
        );
      }
      return detailed;
    }
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
      const historyLimit = Number.isInteger(request.historyLimit)
        ? Math.max(0, Math.min(100, request.historyLimit!))
        : 20;
      return this.withDetails(matches[0]!, historyLimit);
    }
    if (request.type === "find-people") {
      if (!this.options.findPeople) throw new Error("People lookup is unavailable");
      if (typeof request.query !== "string") throw new Error("query is required");
      return this.options.findPeople(request.query);
    }
    if (request.type === "dm") {
      if (!this.options.sendDirectMessage) throw new Error("Direct messages are unavailable");
      if (typeof request.userId !== "string" || typeof request.text !== "string") {
        throw new Error("userId and text are required");
      }
      return this.options.sendDirectMessage({ userId: request.userId, text: request.text });
    }
    if (request.type === "channel-leave") {
      if (typeof request.channel !== "string" || !/^[CG][A-Z0-9]+$/.test(request.channel))
        throw new Error("A public or private channel ID (C/G) is required");
      if (!this.options.leaveChannel) throw new Error("Channel leave is unavailable");
      await this.options.leaveChannel(request.channel);
      return { channel: request.channel };
    }
    if (request.type === "dm-audit-conversations") {
      if (!this.options.listDmAuditConversations) throw new Error("DM audit is unavailable");
      if (request.cursor !== undefined && typeof request.cursor !== "string")
        throw new Error("Invalid cursor");
      return this.options.listDmAuditConversations(request.cursor);
    }
    if (request.type === "dm-audit-messages") {
      if (!this.options.auditDmMessages) throw new Error("DM audit is unavailable");
      if (
        typeof request.channel !== "string" ||
        !/^D[A-Z0-9]+$/.test(request.channel) ||
        typeof request.userId !== "string" ||
        !/^[UW][A-Z0-9]+$/.test(request.userId) ||
        typeof request.oldest !== "string" ||
        !Number.isFinite(Number(request.oldest)) ||
        (request.latest !== undefined &&
          (typeof request.latest !== "string" || !Number.isFinite(Number(request.latest)))) ||
        (request.threadTs !== undefined &&
          (typeof request.threadTs !== "string" || !/^\d+\.\d+$/.test(request.threadTs))) ||
        (request.cursor !== undefined && (typeof request.cursor !== "string" || !request.threadTs))
      )
        throw new Error("Invalid DM audit query");
      return this.options.auditDmMessages({
        channel: request.channel,
        recipientId: request.userId,
        oldest: request.oldest,
        ...(request.latest ? { latest: request.latest } : {}),
        ...(request.threadTs ? { threadTs: request.threadTs } : {}),
        ...(request.cursor ? { cursor: request.cursor } : {}),
      });
    }
    if (request.type.startsWith("schedule-")) {
      const schedules = this.options.schedules;
      if (!schedules) throw new Error("Schedules are unavailable");
      if (request.type === "schedule-list") return schedules.list(LOCAL_OPERATOR_ID, true);
      if (request.type === "schedule-cancel") {
        if (typeof request.id !== "string") throw new Error("id is required");
        schedules.cancel(request.id, LOCAL_OPERATOR_ID, true);
        return { cancelled: request.id };
      }
      if (typeof request.userId !== "string" || typeof request.text !== "string")
        throw new Error("userId and text are required");
      const input: ScheduleInput = { userId: request.userId, text: request.text };
      if (request.at !== undefined) {
        if (typeof request.at !== "string") throw new Error("at must be a string");
        input.at = request.at;
      }
      if (request.recurrence !== undefined) {
        if (
          typeof request.recurrence !== "object" ||
          request.recurrence === null ||
          typeof request.recurrence.time !== "string" ||
          typeof request.recurrence.timezone !== "string" ||
          (request.recurrence.weekdays !== undefined && !Array.isArray(request.recurrence.weekdays))
        )
          throw new Error("Invalid recurrence");
        input.recurrence = request.recurrence;
      }
      if (request.type === "schedule-create") return schedules.create(input, LOCAL_OPERATOR_ID);
      if (typeof request.id !== "string") throw new Error("id is required");
      return schedules.update(request.id, input, LOCAL_OPERATOR_ID, true);
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
            LOCAL_OPERATOR_ID,
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

  private async withDetails(
    summary: ConversationSummary,
    historyLimit: number,
  ): Promise<ConversationSummary> {
    if (!this.options.inspector) return summary;
    try {
      return {
        ...summary,
        details: await this.options.inspector.inspectConversation(
          summary.conversationId,
          historyLimit,
        ),
      };
    } catch {
      return summary;
    }
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
