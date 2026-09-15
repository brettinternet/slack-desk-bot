import type { QueueSnapshot } from "./agent.ts";

export const DEFAULT_HEALTH_PORT = 3210;
export const SLACK_FAILURE_DEGRADED_THRESHOLD = 3;

export type SlackConnectionState =
  "starting" | "connecting" | "connected" | "reconnecting" | "disconnecting" | "disconnected";
export type ReadinessStatus = "ready" | "degraded" | "unhealthy";

export interface HealthSnapshot {
  status: ReadinessStatus;
  started_at: string;
  uptime_ms: number;
  slack: {
    connection: SlackConnectionState;
    consecutive_delivery_failures: number;
  };
  backend: { available: boolean };
  queue: QueueSnapshot;
  last_successful_slack_operation_at: string | null;
}

export class HealthState {
  readonly startedAt = Date.now();
  private connection: SlackConnectionState = "starting";
  private backendAvailable = true;
  private lastSuccessfulSlackOperationAt: number | undefined;
  private consecutiveDeliveryFailures = 0;

  setSlackConnection(connection: SlackConnectionState): void {
    this.connection = connection;
  }

  markBackendDisposed(): void {
    this.backendAvailable = false;
  }

  recordSuccessfulSlackOperation(): void {
    this.lastSuccessfulSlackOperationAt = Date.now();
  }

  recordSlackDeliverySuccess(): void {
    this.recordSuccessfulSlackOperation();
    this.consecutiveDeliveryFailures = 0;
  }

  recordSlackDeliveryFailure(): void {
    this.consecutiveDeliveryFailures++;
  }

  snapshot(queue: QueueSnapshot): HealthSnapshot {
    const backendAvailable = this.backendAvailable && queue.backend_available;
    const unhealthy =
      !backendAvailable ||
      this.connection === "disconnected" ||
      this.connection === "disconnecting" ||
      this.connection === "starting";
    const degraded =
      this.connection === "connecting" ||
      this.connection === "reconnecting" ||
      this.consecutiveDeliveryFailures >= SLACK_FAILURE_DEGRADED_THRESHOLD;
    const status: ReadinessStatus = unhealthy ? "unhealthy" : degraded ? "degraded" : "ready";

    return {
      status,
      started_at: new Date(this.startedAt).toISOString(),
      uptime_ms: Date.now() - this.startedAt,
      slack: {
        connection: this.connection,
        consecutive_delivery_failures: this.consecutiveDeliveryFailures,
      },
      backend: { available: backendAvailable },
      queue,
      last_successful_slack_operation_at: this.lastSuccessfulSlackOperationAt
        ? new Date(this.lastSuccessfulSlackOperationAt).toISOString()
        : null,
    };
  }
}

function livenessSnapshot(state: HealthState) {
  return {
    status: "ok",
    started_at: new Date(state.startedAt).toISOString(),
    uptime_ms: Date.now() - state.startedAt,
  };
}

export interface HealthServerOptions {
  host?: string;
  state?: HealthState;
  queue?: () => QueueSnapshot;
}

const emptyQueueSnapshot = (): QueueSnapshot => ({
  active: 0,
  queued: 0,
  limits: { max_concurrent: 0, max_queued: 0 },
  saturated: false,
  backend_available: true,
});

export function startHealthServer(port = DEFAULT_HEALTH_PORT, options: HealthServerOptions = {}) {
  const state = options.state ?? new HealthState();
  const queue = options.queue ?? emptyQueueSnapshot;
  return Bun.serve({
    hostname: options.host ?? "127.0.0.1",
    port,
    fetch(request) {
      const pathname = new URL(request.url).pathname;
      if (pathname === "/healthz") return Response.json(livenessSnapshot(state));
      if (pathname === "/readyz") {
        const snapshot = state.snapshot(queue());
        return Response.json(snapshot, { status: snapshot.status === "ready" ? 200 : 503 });
      }
      return new Response("Not found", { status: 404 });
    },
  });
}
