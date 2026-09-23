import {
  type CancellableAgentBackend,
  type ConversationInspector,
  type DirectMessage,
  type DirectMessageReceipt,
  type QueueSnapshot,
  QueuedAgentBackend,
} from "./agent.ts";
import { BACKENDS } from "./backend-table.ts";
import type { DmAuditConversationsPage, DmAuditMessagesPage, DmAuditQuery } from "./dm-audit.ts";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { Config } from "./config.ts";
import { ConversationCoordinator } from "./conversation-coordinator.ts";
import { checkClaudeReadiness, checkCodexReadiness, checkPiReadiness } from "./doctor.ts";
import { HealthState, startHealthServer } from "./health.ts";
import { LocalControlServer } from "./local-control.ts";
import { loadSlackUsers, type SlackDirectoryUser } from "./git-slack-identities.ts";
import { findPeople, type PersonMatch } from "./people-lookup.ts";
import { type LogWriter, writeStructuredLog } from "./log.ts";
import { SlackAgent } from "./slack.ts";
import { ScheduleService } from "./schedules.ts";

interface SlackLifecycle extends Partial<ConversationInspector> {
  start(): Promise<void>;
  stop(): Promise<void>;
  publishOperatorExchange?(conversationId: string, prompt: string, response: string): Promise<void>;
  sendDirectMessage?(message: DirectMessage, requesterId?: string): Promise<DirectMessageReceipt>;
  listDmAuditConversations?(cursor?: string): Promise<DmAuditConversationsPage>;
  auditDmMessages?(query: DmAuditQuery): Promise<DmAuditMessagesPage>;
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
  loadUsers?: () => Promise<SlackDirectoryUser[]>;
  piReady?: (workspace: string) => Promise<string>;
  codexReady?: (config: Config) => Promise<string>;
  claudeReady?: (config: Config) => Promise<string>;
  createBackend?: (config: Config) => RuntimeBackend;
  createSlackAgent?: (options: {
    config: Config;
    agent: RuntimeBackend;
    health: HealthState;
    schedules: ScheduleService;
  }) => SlackLifecycle;
  startHealthServer?: (
    port: number,
    options: Parameters<typeof startHealthServer>[1],
  ) => HealthServer;
  createLocalControl?: (options: {
    socketPath: string;
    coordinator: ConversationCoordinator;
    inspector?: ConversationInspector;
    sendDirectMessage?: (message: DirectMessage) => Promise<DirectMessageReceipt>;
    listDmAuditConversations?: (cursor?: string) => Promise<DmAuditConversationsPage>;
    auditDmMessages?: (query: DmAuditQuery) => Promise<DmAuditMessagesPage>;
    findPeople?: (query: string) => Promise<PersonMatch[]>;
    schedules: ScheduleService;
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

export function scheduleStorePath(
  socketPath: string,
  environment: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
): string {
  // XDG_RUNTIME_DIR is often tmpfs; keep schedules outside it across reboots.
  const runtimeDir = environment.XDG_RUNTIME_DIR?.trim();
  return platform !== "darwin" && runtimeDir && socketPath === join(runtimeDir, "control.sock")
    ? join(homedir(), ".local", "state", "slack-desk-bot", "schedules.json")
    : join(dirname(socketPath), "schedules.json");
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
  let slack: SlackLifecycle;
  const schedulePath = scheduleStorePath(config.socketPath);
  const schedules = new ScheduleService(schedulePath, (message, creatorId) => {
    if (!slack.sendDirectMessage) throw new Error("Direct messages are unavailable");
    return slack.sendDirectMessage(message, creatorId);
  });
  slack = (
    dependencies.createSlackAgent ??
    (({ config, agent, health, schedules }) =>
      new SlackAgent({
        schedules,
        botToken: config.slackBotToken,
        appToken: config.slackAppToken,
        allowedUserIds: config.allowedUserIds,
        operatorUserIds: config.operatorUserIds,
        agent,
        health,
        operatorLog: log,
        denialStatePath: join(dirname(config.socketPath), "slack-denials.json"),
        catchUp: { statePath: join(dirname(config.socketPath), "slack-catch-up.json") },
      }))
  )({ config, agent, health, schedules });
  let directory:
    { loadedAt: number; users: Awaited<ReturnType<typeof loadSlackUsers>> } | undefined;
  let pendingDirectory: ReturnType<typeof loadSlackUsers> | undefined;
  const lookup = async (query: string): Promise<PersonMatch[]> => {
    if (!directory || Date.now() - directory.loadedAt > 300_000) {
      const users = await (pendingDirectory ??= (
        dependencies.loadUsers ?? (() => loadSlackUsers(config.slackBotToken))
      )().finally(() => {
        pendingDirectory = undefined;
      }));
      directory = { loadedAt: Date.now(), users };
    }
    return findPeople(query, directory.users, config.workspace);
  };
  const local = (dependencies.createLocalControl ?? ((options) => new LocalControlServer(options)))(
    {
      socketPath: config.socketPath,
      coordinator: agent,
      schedules,
      findPeople: lookup,
      ...(slack.inspectConversation
        ? { inspector: { inspectConversation: slack.inspectConversation.bind(slack) } }
        : {}),
      ...(slack.sendDirectMessage
        ? { sendDirectMessage: (message: DirectMessage) => slack.sendDirectMessage!(message) }
        : {}),
      ...(slack.listDmAuditConversations && slack.auditDmMessages
        ? {
            listDmAuditConversations: slack.listDmAuditConversations.bind(slack),
            auditDmMessages: slack.auditDmMessages.bind(slack),
          }
        : {}),
    },
  );
  const unsubscribeOperator = agent.onOperatorExchange((exchange) =>
    slack.publishOperatorExchange?.(exchange.conversationId, exchange.prompt, exchange.response),
  );
  const disposeRuntime = async (onStage?: (stage: ShutdownStage) => void): Promise<void> => {
    let cleanupError: unknown;
    let failedStage: ShutdownStage | undefined;
    onStage?.("local_control");
    try {
      await local.stop();
    } catch (error) {
      cleanupError = error;
      failedStage = "local_control";
    }
    await schedules.stop();
    onStage?.("slack");
    try {
      await slack.stop();
    } catch (error) {
      if (cleanupError === undefined) {
        cleanupError = error;
        failedStage = "slack";
      }
    }
    unsubscribeOperator();
    health.markBackendDisposed();
    onStage?.("backend");
    agent.dispose();
    if (cleanupError) {
      // Cleanup is best effort, so later stages still run; report the stage
      // that actually failed rather than the last one attempted.
      if (failedStage) onStage?.(failedStage);
      throw cleanupError;
    }
  };

  let healthServer: HealthServer;
  try {
    healthServer = (dependencies.startHealthServer ?? startHealthServer)(config.healthPort, {
      host: config.healthHost,
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
    schedules.start();
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
