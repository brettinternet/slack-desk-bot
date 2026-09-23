import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { loadConfig } from "../src/config.ts";
import { launchAgentPlist } from "../scripts/install-launch-agent.ts";

async function yaml(path: string): Promise<Record<string, any>> {
  return Bun.YAML.parse(await readFile(path, "utf8")) as Record<string, any>;
}

describe("configuration documents", () => {
  test("CI runs the Seatbelt suite on macOS", async () => {
    const workflow = await yaml(".github/workflows/ci.yaml");
    expect(workflow.jobs?.seatbelt).toMatchObject({
      "runs-on": "macos-latest",
      steps: expect.arrayContaining([{ run: "bun test test/seatbelt.test.ts" }]),
    });
  });

  test("container image is validated and published to GHCR", async () => {
    const workflow = await yaml(".github/workflows/container.yaml");
    expect(workflow.jobs?.image?.permissions).toMatchObject({
      contents: "read",
      packages: "write",
      attestations: "write",
      "id-token": "write",
    });
    const build = workflow.jobs?.image?.steps?.find(
      (step: Record<string, unknown>) => step.uses === "docker/build-push-action@v7",
    );
    expect(build?.with).toMatchObject({
      context: ".",
      push: "${{ github.event_name != 'pull_request' }}",
      provenance: "mode=max",
      sbom: true,
    });
    expect(build?.with?.platforms).toContain("linux/amd64,linux/arm64");

    const dockerfile = await readFile("Dockerfile", "utf8");
    expect(dockerfile).toContain("FROM oven/bun:1.4.2-slim");
    expect(dockerfile).toContain("bun install --frozen-lockfile --production");
    expect(dockerfile).toContain("ca-certificates git gh");
    expect(dockerfile).toContain("USER bun");
    expect(dockerfile).toContain('CMD ["bun", "src/healthcheck.ts"]');
  });

  test("Compose keeps workspace, credentials, and state in separate mounts", async () => {
    const compose = await yaml("compose.yaml");
    const agent = compose.services?.agent;
    expect(agent).toMatchObject({
      image: "${SLACK_DESK_IMAGE:-ghcr.io/brettinternet/slack-desk-bot:main}",
      init: true,
      stop_grace_period: "20s",
      cap_drop: ["ALL"],
      security_opt: ["no-new-privileges:true"],
    });
    expect(agent.environment).toMatchObject({
      SLACK_AGENT_BACKEND: "pi",
      SLACK_AGENT_CWD: "/workspace",
      PI_CODING_AGENT_DIR: "/config/pi-agent",
      SLACK_AGENT_SESSION_DIR: "/var/lib/slack-desk/sessions",
    });
    expect(agent.volumes).toHaveLength(3);
    expect(agent.volumes[1]).not.toHaveProperty("read_only");
  });

  test("Slack manifest enables the required Socket Mode events and scopes", async () => {
    const manifest = await yaml("slack-app-manifest.yaml");
    expect(manifest.features?.app_home).toEqual({
      messages_tab_enabled: true,
      messages_tab_read_only_enabled: false,
    });
    expect(manifest.settings?.socket_mode_enabled).toBe(true);
    expect(manifest.settings?.event_subscriptions?.bot_events).toEqual([
      "app_mention",
      "message.channels",
      "message.groups",
      "message.im",
    ]);
    expect(manifest.oauth_config?.scopes?.bot).toEqual(
      expect.arrayContaining([
        "app_mentions:read",
        "channels:history",
        "chat:write",
        "emoji:read",
        "files:read",
        "groups:history",
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
