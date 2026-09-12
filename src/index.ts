import { QueuedAgentBackend } from "./agent.ts";
import { loadConfig } from "./config.ts";
import { PiBackend } from "./pi-backend.ts";
import { SlackAgent } from "./slack.ts";

const config = loadConfig();
const agent = new SlackAgent({
  botToken: config.slackBotToken,
  appToken: config.slackAppToken,
  agent: new QueuedAgentBackend(new PiBackend(config.workspace, config.instructions)),
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void agent.stop().finally(() => process.exit());
  });
}

await agent.start();
