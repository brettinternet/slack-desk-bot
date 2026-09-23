export interface RequestLog {
  event: "agent_request_completed";
  request_id: string;
  user: string;
  conversation: string;
  duration_ms: number;
  tool_count: number;
  execution_outcome: "success" | "cancelled" | "error";
  delivery_outcome: "success" | "partial" | "failure";
  published_messages: number;
  cancelled_by?: string;
}

export interface StartupLog {
  event: "startup";
  component: "application" | "slack";
  outcome: "starting" | "connected" | "failure";
  backend?: string;
  mode?: string;
  max_concurrent?: number;
  configured_max_concurrent?: number;
  error_type?: string;
  error_message?: string;
}

export interface UnauthorizedLog {
  event: "unauthorized";
  channel: string;
}

export interface CapacityDropLog {
  event: "capacity_drop";
  active_responses: number;
  limit: number;
}

export interface OperatorErrorLog {
  event: "operator_error";
  component: "slack" | "pi" | "codex" | "claude" | "schedules" | "automations";
  message: string;
  error_type: string;
  request_id?: string;
  moved_to?: string;
}

export interface ShutdownLog {
  event: "shutdown";
  outcome: "success" | "timeout" | "failure";
  stage: string;
  timeout_ms?: number;
  error_type?: string;
  error_message?: string;
}

export interface DirectMessageLog {
  event: "direct_message_sent";
  recipient: string;
  requester: string;
  messages: number;
}

export type StructuredLog =
  | RequestLog
  | StartupLog
  | UnauthorizedLog
  | CapacityDropLog
  | OperatorErrorLog
  | ShutdownLog
  | DirectMessageLog;

export type RequestLogWriter = (fields: RequestLog) => void;
export type LogWriter = (fields: StructuredLog) => void;

export const writeStructuredLog: LogWriter = (fields) => {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), ...fields }));
};
