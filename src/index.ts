import { QueuedAgentBackend } from "./agent.ts";
import { loadConfig } from "./config.ts";
import { PiBackend } from "./pi-backend.ts";
import { SlackAgent } from "./slack.ts";

const config = loadConfig();
console.log(`Slack agent mode: ${config.agentMode}`);
const agent = new SlackAgent({
  botToken: config.slackBotToken,
  appToken: config.slackAppToken,
  allowedUserIds: config.allowedUserIds,
  agent: new QueuedAgentBackend(
    new PiBackend(config.workspace, config.agentMode, config.sessionIdleMs),
    config.queueLimits,
  ),
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void agent.stop().finally(() => process.exit());
  });
}

await agent.start();
