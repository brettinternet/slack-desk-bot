import { type CancellableAgentBackend, type QueueSnapshot, QueuedAgentBackend } from "./agent.ts";
import { BACKENDS } from "./backend-table.ts";
import type { Config } from "./config.ts";
import { ConversationCoordinator } from "./conversation-coordinator.ts";
import { checkClaudeReadiness, checkCodexReadiness, checkPiReadiness } from "./doctor.ts";
import { HealthState, startHealthServer } from "./health.ts";
import { LocalControlServer } from "./local-control.ts";
import { type LogWriter, writeStructuredLog } from "./log.ts";
import { SlackAgent } from "./slack.ts";

interface SlackLifecycle {
  start(): Promise<void>;
  stop(): Promise<void>;
  publishOperatorExchange?(conversationId: string, prompt: string, response: string): Promise<void>;
}

interface LocalControlLifecycle {
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
  log?: LogWriter;
  piReady?: (workspace: string) => Promise<string>;
  codexReady?: (config: Config) => Promise<string>;
  claudeReady?: (config: Config) => Promise<string>;
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
  createLocalControl?: (options: {
    socketPath: string;
    coordinator: ConversationCoordinator;
  }) => LocalControlLifecycle;
}

export type ShutdownStage = "health_server" | "local_control" | "slack" | "backend";

export interface RunningApplication {
  readonly healthPort: number;
  stop(onStage?: (stage: ShutdownStage) => void): Promise<void>;
}

function defaultBackend(config: Config): RuntimeBackend {
  return new QueuedAgentBackend(BACKENDS[config.agentBackend].create(config), config.queueLimits);
}

export async function startApplication(
  config: Config,
  dependencies: ApplicationDependencies = {},
): Promise<RunningApplication> {
  const log = dependencies.log ?? writeStructuredLog;
  log({
    event: "startup",
    component: "application",
    outcome: "starting",
    backend: config.agentBackend,
    mode: config.agentMode,
    max_concurrent: config.queueLimits.maxConcurrentConversations,
    configured_max_concurrent: config.configuredMaxConcurrentConversations,
  });

  await BACKENDS[config.agentBackend].checkReady(config, {
    pi: dependencies.piReady ?? checkPiReadiness,
    codex: dependencies.codexReady ?? checkCodexReadiness,
    claude: dependencies.claudeReady ?? checkClaudeReadiness,
  });

  const health = new HealthState();
  const backend = (dependencies.createBackend ?? defaultBackend)(config);
  const agent = new ConversationCoordinator(backend);
  const slack = (
    dependencies.createSlackAgent ??
    (({ config, agent, health }) =>
      new SlackAgent({
        botToken: config.slackBotToken,
        appToken: config.slackAppToken,
        allowedUserIds: config.allowedUserIds,
        operatorUserIds: config.operatorUserIds,
        agent,
        health,
        operatorLog: log,
      }))
  )({ config, agent, health });
  const local = (dependencies.createLocalControl ?? ((options) => new LocalControlServer(options)))(
    {
      socketPath: config.socketPath,
      coordinator: agent,
    },
  );
  const unsubscribeOperator = agent.onOperatorExchange((exchange) =>
    slack.publishOperatorExchange?.(exchange.conversationId, exchange.prompt, exchange.response),
  );
  const disposeRuntime = async (onStage?: (stage: ShutdownStage) => void): Promise<void> => {
    let cleanupError: unknown;
    onStage?.("local_control");
    try {
      await local.stop();
    } catch (error) {
      cleanupError = error;
    }
    onStage?.("slack");
    try {
      await slack.stop();
    } catch (error) {
      cleanupError ??= error;
    }
    unsubscribeOperator();
    health.markBackendDisposed();
    onStage?.("backend");
    agent.dispose();
    if (cleanupError) throw cleanupError;
  };

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
    await local.start();
    await slack.start();
  } catch (error) {
    healthServer.stop(true);
    await disposeRuntime().catch(() => {});
    throw error;
  }

  const healthPort = healthServer.port;
  if (healthPort === undefined) {
    healthServer.stop(true);
    await disposeRuntime();
    throw new Error("Health server did not report its listening port");
  }

  let stopped = false;
  return {
    healthPort,
    async stop(onStage) {
      if (stopped) return;
      stopped = true;
      onStage?.("health_server");
      healthServer.stop(true);
      await disposeRuntime(onStage);
    },
  };
}
