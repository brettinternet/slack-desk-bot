import type { ConversationEvent } from "./conversation-coordinator.ts";

export const LOCAL_PROTOCOL_VERSION = 1;
export const MAX_LOCAL_FRAME_BYTES = 64 * 1024;

/**
 * Requester ID for local terminal turns. Slack user IDs are uppercase and
 * start with `U`/`W`, so this value cannot collide with one.
 */
export const LOCAL_OPERATOR_ID = "local-operator";

export type LocalRequestType =
  | "list"
  | "attach"
  | "run"
  | "status"
  | "cancel"
  | "dm"
  | "channel-leave"
  | "dm-audit-conversations"
  | "dm-audit-messages"
  | "find-people"
  | "schedule-list"
  | "schedule-create"
  | "schedule-update"
  | "schedule-cancel";

export interface LocalRequest {
  v: typeof LOCAL_PROTOCOL_VERSION;
  type: LocalRequestType;
  requestId: string;
  sessionId?: string;
  prompt?: string;
  historyLimit?: number;
  userId?: string;
  channel?: string;
  oldest?: string;
  latest?: string;
  threadTs?: string;
  cursor?: string;
  query?: string;
  text?: string;
  id?: string;
  at?: string;
  recurrence?: { time: string; timezone: string; weekdays?: number[] };
}

export interface LocalResponse {
  v: typeof LOCAL_PROTOCOL_VERSION;
  type: "response";
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface LocalEventMessage {
  v: typeof LOCAL_PROTOCOL_VERSION;
  type: "event";
  event: ConversationEvent;
}

export type LocalServerMessage = LocalResponse | LocalEventMessage;

const REQUEST_TYPES: readonly string[] = [
  "list",
  "attach",
  "run",
  "status",
  "cancel",
  "dm",
  "channel-leave",
  "dm-audit-conversations",
  "dm-audit-messages",
  "find-people",
  "schedule-list",
  "schedule-create",
  "schedule-update",
  "schedule-cancel",
];

export function isLocalRequest(value: unknown): value is LocalRequest {
  if (typeof value !== "object" || value === null) return false;
  const request = value as Record<string, unknown>;
  return (
    request.v === LOCAL_PROTOCOL_VERSION &&
    typeof request.requestId === "string" &&
    request.requestId.length > 0 &&
    typeof request.type === "string" &&
    REQUEST_TYPES.includes(request.type)
  );
}

export function isLocalServerMessage(value: unknown): value is LocalServerMessage {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Record<string, unknown>;
  if (message.v !== LOCAL_PROTOCOL_VERSION) return false;
  if (message.type === "response") {
    return typeof message.requestId === "string" && typeof message.ok === "boolean";
  }
  return message.type === "event" && typeof message.event === "object" && message.event !== null;
}
