import { App, LogLevel } from "@slack/bolt";
import type { AgentBackend } from "./agent.ts";
import {
  conversationId,
  isSupportedDirectMessage,
  parseAgentCommand,
  splitSlackMessage,
  stripBotMention,
} from "./messages.ts";

interface SlackAgentOptions {
  botToken: string;
  appToken: string;
  agent: AgentBackend;
}

export class SlackAgent {
  private readonly app: App;
  private botUserId = "";

  constructor(private readonly options: SlackAgentOptions) {
    this.app = new App({
      token: options.botToken,
      appToken: options.appToken,
      socketMode: true,
      logLevel: LogLevel.INFO,
    });

    this.app.event("app_mention", async ({ event, client }) => {
      if (!event.user || event.bot_id) return;
      const prompt = stripBotMention(event.text, this.botUserId);
      await this.respond(client, event.channel, event.ts, event.thread_ts ?? event.ts, prompt);
    });

    this.app.event("message", async ({ event, client }) => {
      if (
        event.channel_type !== "im" ||
        !isSupportedDirectMessage(event.subtype) ||
        !("user" in event) ||
        !event.user
      )
        return;
      const text = "text" in event ? (event.text ?? "") : "";
      await this.respond(client, event.channel, event.ts, undefined, text);
    });
  }

  async start(): Promise<void> {
    const authentication = await this.app.client.auth.test({ token: this.options.botToken });
    if (!authentication.user_id) throw new Error("Slack auth.test did not return a bot user ID");
    this.botUserId = authentication.user_id;
    await this.app.start();
    console.log("Slack agent connected");
  }

  async stop(): Promise<void> {
    this.options.agent.dispose();
    await this.app.stop();
  }

  private async respond(
    client: App["client"],
    channel: string,
    messageTs: string,
    threadTs: string | undefined,
    prompt: string,
  ): Promise<void> {
    if (!prompt) return;

    await client.reactions.add({ channel, timestamp: messageTs, name: "eyes" }).catch(() => {});
    try {
      const id = conversationId(channel, threadTs);
      const command = parseAgentCommand(prompt);
      const output = command
        ? await this.options.agent.command(id, command)
        : await this.options.agent.run({ conversationId: id, prompt });
      if (output === undefined) return;
      for (const text of splitSlackMessage(output)) {
        await client.chat.postMessage({ channel, thread_ts: threadTs, text });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Agent request failed", error);
      await client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: `Agent request failed: ${message}`,
      });
    }
  }
}
