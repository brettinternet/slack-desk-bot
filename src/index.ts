import { QueuedAgentBackend } from "./agent.ts";
import { loadConfig } from "./config.ts";
import { HealthState, startHealthServer } from "./health.ts";
import { PiBackend } from "./pi-backend.ts";
import { SlackAgent } from "./slack.ts";

const config = loadConfig();
console.log(`SlackDeskBot mode: ${config.agentMode}`);
if (config.queueLimits.maxConcurrentConversations !== config.configuredMaxConcurrentConversations) {
  console.log(
    `Read-write mode limits concurrent conversations to ${config.queueLimits.maxConcurrentConversations} ` +
      `(configured: ${config.configuredMaxConcurrentConversations}) to protect the shared checkout.`,
  );
}
const health = new HealthState();
const queuedAgent = new QueuedAgentBackend(
  new PiBackend(config.workspace, {
    mode: config.agentMode,
    instructions: config.instructions,
    sessionDir: config.sessionDir,
    maxActiveSessions: config.maxActiveSessions,
    sessionIdleMs: config.sessionIdleMs,
  }),
  config.queueLimits,
);
const agent = new SlackAgent({
  botToken: config.slackBotToken,
  appToken: config.slackAppToken,
  allowedUserIds: config.allowedUserIds,
  agent: queuedAgent,
  health,
});

let healthServer: ReturnType<typeof startHealthServer> | undefined;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    healthServer?.stop(true);
    void agent.stop().finally(() => process.exit());
  });
}

await agent.start();
healthServer = startHealthServer(config.healthPort, {
  state: health,
  queue: () => queuedAgent.snapshot(),
});
