import { chmod, mkdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const LABEL = "com.slackdeskbot.agent";

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function shell(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function launchAgentPlist(
  repository: string,
  mise: string,
  environmentFile: string,
): string {
  const command =
    `set -a; source ${shell(environmentFile)}; set +a; ` +
    `exec ${shell(mise)} exec -- hum --project ${shell(repository)} up`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>/bin/zsh</string><string>-lc</string><string>${xml(command)}</string></array>
  <key>WorkingDirectory</key><string>${xml(repository)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
</dict>
</plist>
`;
}

async function launchctl(...arguments_: string[]): Promise<number> {
  return Bun.spawn(["launchctl", ...arguments_], { stdout: "inherit", stderr: "inherit" }).exited;
}

export async function installLaunchAgent(): Promise<string> {
  if (process.platform !== "darwin")
    throw new Error("The supported service deployment requires macOS");
  const mise = Bun.which("mise");
  if (!mise) throw new Error("Mise is not installed or is not on PATH");

  const repository = await realpath(process.cwd());
  const environmentFile = join(homedir(), ".config", "slack-desk-bot", "service.env");
  if (!(await Bun.file(environmentFile).exists())) {
    throw new Error(`Create ${environmentFile} from .env.example before installing the service`);
  }
  if ((await stat(environmentFile)).mode & 0o077) {
    throw new Error(`Protect service credentials first: chmod 600 ${environmentFile}`);
  }

  const agentsDirectory = join(homedir(), "Library", "LaunchAgents");
  const plist = join(agentsDirectory, `${LABEL}.plist`);
  await mkdir(agentsDirectory, { recursive: true });
  await Bun.write(plist, launchAgentPlist(repository, mise, environmentFile));
  await chmod(plist, 0o600);

  const domain = `gui/${process.getuid?.()}`;
  await launchctl("bootout", domain, plist);
  if ((await launchctl("bootstrap", domain, plist)) !== 0) {
    throw new Error(`launchctl could not load ${plist}`);
  }
  if ((await launchctl("kickstart", "-k", `${domain}/${LABEL}`)) !== 0) {
    throw new Error(`launchctl could not start ${LABEL}`);
  }
  return plist;
}

if (import.meta.main) {
  try {
    console.log(`Installed and started ${await installLaunchAgent()}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Service installation failed");
    process.exitCode = 1;
  }
}
