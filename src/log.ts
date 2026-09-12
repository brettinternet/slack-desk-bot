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

export type LogWriter = (fields: RequestLog) => void;

export const writeStructuredLog: LogWriter = (fields) => {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), ...fields }));
};
