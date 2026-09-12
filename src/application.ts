import { type CancellableAgentBackend, type QueueSnapshot, QueuedAgentBackend } from "./agent.ts";
import type { Config } from "./config.ts";
import { checkPiReadiness } from "./doctor.ts";
import { HealthState, startHealthServer } from "./health.ts";
import { PiBackend } from "./pi-backend.ts";
import { SlackAgent } from "./slack.ts";

interface SlackLifecycle {
  start(): Promise<void>;
  stop(): Promise<void>;
}

interface HealthServer {
  readonly port?: number;
  stop(closeActiveConnections?: boolean): void;
}

interface RuntimeBackend extends CancellableAgentBackend {
  snapshot(): QueueSnapshot;
}

interface ApplicationDependencies {
  piReady?: (workspace: string) => Promise<string>;
  createBackend?: (config: Config) => RuntimeBackend;
  createSlackAgent?: (options: {
    config: Config;
    agent: RuntimeBackend;
    health: HealthState;
  }) => SlackLifecycle;
  startHealthServer?: (
    port: number,
    options: Parameters<typeof startHealthServer>[1],
  ) => HealthServer;
}

export interface RunningApplication {
  readonly healthPort: number;
  stop(): Promise<void>;
}

function defaultBackend(config: Config): RuntimeBackend {
  return new QueuedAgentBackend(
    new PiBackend(config.workspace, {
      mode: config.agentMode,
      instructions: config.instructions,
      sessionDir: config.sessionDir,
      maxActiveSessions: config.maxActiveSessions,
      sessionIdleMs: config.sessionIdleMs,
    }),
    config.queueLimits,
  );
}

export async function startApplication(
  config: Config,
  dependencies: ApplicationDependencies = {},
): Promise<RunningApplication> {
  console.log(`SlackDeskBot mode: ${config.agentMode}`);
  if (
    config.queueLimits.maxConcurrentConversations !== config.configuredMaxConcurrentConversations
  ) {
    console.log(
      `Read-write mode limits concurrent conversations to ${config.queueLimits.maxConcurrentConversations} ` +
        `(configured: ${config.configuredMaxConcurrentConversations}) to protect the shared checkout.`,
    );
  }

  await (dependencies.piReady ?? checkPiReadiness)(config.workspace);

  const health = new HealthState();
  const agent = (dependencies.createBackend ?? defaultBackend)(config);
  const slack = (
    dependencies.createSlackAgent ??
    (({ config, agent, health }) =>
      new SlackAgent({
        botToken: config.slackBotToken,
        appToken: config.slackAppToken,
        allowedUserIds: config.allowedUserIds,
        agent,
        health,
      }))
  )({ config, agent, health });

  let healthServer: HealthServer;
  try {
    healthServer = (dependencies.startHealthServer ?? startHealthServer)(config.healthPort, {
      state: health,
      queue: () => agent.snapshot(),
    });
  } catch {
    agent.dispose();
    throw new Error(
      `Health port ${config.healthPort} is unavailable; stop its listener or change SLACK_AGENT_HEALTH_PORT`,
    );
  }

  try {
    await slack.start();
  } catch (error) {
    healthServer.stop(true);
    agent.dispose();
    throw error;
  }

  const healthPort = healthServer.port;
  if (healthPort === undefined) {
    healthServer.stop(true);
    await slack.stop();
    throw new Error("Health server did not report its listening port");
  }

  let stopped = false;
  return {
    healthPort,
    async stop() {
      if (stopped) return;
      stopped = true;
      healthServer.stop(true);
      await slack.stop();
    },
  };
}
