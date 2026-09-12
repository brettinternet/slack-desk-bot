import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { loadConfig } from "../src/config.ts";
import { launchAgentPlist } from "../scripts/install-launch-agent.ts";

async function yaml(path: string): Promise<Record<string, any>> {
  return Bun.YAML.parse(await readFile(path, "utf8")) as Record<string, any>;
}

describe("configuration documents", () => {
  test("Slack manifest enables the required Socket Mode events and scopes", async () => {
    const manifest = await yaml("slack-app-manifest.yaml");
    expect(manifest.settings?.socket_mode_enabled).toBe(true);
    expect(manifest.settings?.event_subscriptions?.bot_events).toEqual([
      "app_mention",
      "message.im",
    ]);
    expect(manifest.oauth_config?.scopes?.bot).toEqual(
      expect.arrayContaining([
        "app_mentions:read",
        "chat:write",
        "files:read",
        "im:history",
        "reactions:write",
      ]),
    );
  });

  test("Hum uses the production command, readiness probe, and restart policy", async () => {
    const manifest = await yaml("hum.yaml");
    expect(manifest).toMatchObject({
      version: 1,
      processes: {
        agent: {
          argv: ["bun", "run", "start"],
          ready: { exec: ["bun", "src/healthcheck.ts"] },
          restart: "on-failure",
        },
      },
    });
  });

  test("macOS service definition starts Hum at login without embedding secrets", () => {
    const plist = launchAgentPlist(
      "/Users/example/Slack Desk Bot",
      "/Users/example/.local/bin/mise",
      "/Users/example/.config/slack-desk-bot/service.env",
    );
    expect(plist).toContain("<key>RunAtLoad</key><true/>");
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("hum --project");
    expect(plist).toContain("service.env");
    expect(plist).not.toContain("xoxb-");
  });

  test("example environment contains every production requirement and remains loadable", async () => {
    const contents = await readFile(".env.example", "utf8");
    const names = new Set(
      contents
        .split("\n")
        .map((line) => line.match(/^(?:# )?([A-Z][A-Z0-9_]*)=/)?.[1])
        .filter((name): name is string => Boolean(name)),
    );
    const configSource = await readFile("src/config.ts", "utf8");
    const productionNames = new Set(configSource.match(/SLACK_[A-Z0-9_]+/g) ?? []);
    expect([...productionNames].filter((name) => !names.has(name))).toEqual([]);

    for (const required of [
      "SLACK_BOT_TOKEN",
      "SLACK_APP_TOKEN",
      "SLACK_AGENT_CWD",
      "SLACK_ALLOWED_USER_IDS",
    ]) {
      expect(names.has(required)).toBe(true);
    }

    expect(() =>
      loadConfig({
        SLACK_BOT_TOKEN: "xoxb-example",
        SLACK_APP_TOKEN: "xapp-example",
        SLACK_AGENT_CWD: process.cwd(),
        SLACK_ALLOWED_USER_IDS: "U01234567",
      }),
    ).not.toThrow();
  });
});
