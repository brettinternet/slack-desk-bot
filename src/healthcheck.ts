import { DEFAULT_HEALTH_PORT } from "./health.ts";

const port = process.env.SLACK_AGENT_HEALTH_PORT?.trim() || String(DEFAULT_HEALTH_PORT);

try {
  const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
    signal: AbortSignal.timeout(1_000),
  });
  if (!response.ok || (await response.json()).status !== "ok") process.exitCode = 1;
} catch {
  process.exitCode = 1;
}
