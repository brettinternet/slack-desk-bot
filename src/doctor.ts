import { execFile } from "node:child_process";
import { constants, realpathSync } from "node:fs";
import { access, lstat, readFile, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { createConnection, createServer } from "node:net";
import { dirname, join } from "node:path";
import {
  getAgentDir,
  ModelRuntime,
  readStoredCredential,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type {
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
} from "@earendil-works/pi-ai";
import { WebClient } from "@slack/web-api";
import { codexSandboxProfile, defaultCodexHome } from "./codex-backend.ts";
import { loadConfig, type Config } from "./config.ts";
import { defaultSessionDirectory } from "./pi-backend.ts";

export type DoctorStatus = "pass" | "fail" | "warning";

export interface DoctorDiagnostic {
  status: DoctorStatus;
  check: string;
  message: string;
}

export interface DoctorResult {
  diagnostics: DoctorDiagnostic[];
  ok: boolean;
}

interface DoctorDependencies {
  slackAuth?: (token: string) => Promise<{ user_id?: string }>;
  portAvailable?: (port: number) => Promise<boolean>;
  socketAvailable?: (path: string) => Promise<boolean>;
  piReady?: (workspace: string) => Promise<string>;
  codexReady?: (config: Config) => Promise<string>;
}

const REQUIRED_SETTINGS = [
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
  "SLACK_AGENT_CWD",
  "SLACK_ALLOWED_USER_IDS",
] as const;

function diagnostic(
  diagnostics: DoctorDiagnostic[],
  status: DoctorStatus,
  check: string,
  message: string,
): void {
  diagnostics.push({ status, check, message });
}

async function nearestExistingPath(path: string): Promise<string> {
  let candidate = path;
  while (true) {
    try {
      await stat(candidate);
      return candidate;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      const parent = dirname(candidate);
      if (parent === candidate) throw error;
      candidate = parent;
    }
  }
}

async function checkWorkspace(config: Config): Promise<void> {
  const permissions =
    constants.R_OK | constants.X_OK | (config.agentMode === "read-write" ? constants.W_OK : 0);
  await access(config.workspace, permissions);
}

async function checkSessionPath(config: Config): Promise<void> {
  const sessionPath =
    config.agentBackend === "codex"
      ? (config.codexHome ?? defaultCodexHome(config.workspace))
      : (config.sessionDir ?? defaultSessionDirectory(config.workspace));
  const existing = await nearestExistingPath(sessionPath);
  const metadata = await stat(existing);
  if (!metadata.isDirectory()) throw new Error("an existing path component is not a directory");
  await access(existing, constants.W_OK | constants.X_OK);
}

export async function isLocalSocketAvailable(path: string): Promise<boolean> {
  const parent = await nearestExistingPath(dirname(path));
  await access(parent, constants.W_OK | constants.X_OK);
  try {
    const metadata = await lstat(path);
    if (!metadata.isSocket() || metadata.uid !== process.getuid?.()) return false;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return true;
    throw error;
  }
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    socket.once("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      socket.destroy();
      if (error.code === "ECONNREFUSED" || error.code === "ENOENT") resolve(true);
      else reject(error);
    });
  });
}

export async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE" || error.code === "EACCES") resolve(false);
      else reject(error);
    });
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close((error) => (error ? reject(error) : resolve(true)));
    });
  });
}

class ReadOnlyPiCredentials implements CredentialStore {
  constructor(private readonly authPath: string) {}

  async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted();
    return readStoredCredential(providerId, this.authPath);
  }

  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    options?.signal?.throwIfAborted();
    let contents: string;
    try {
      contents = await readFile(this.authPath, "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw error;
    }
    const stored = JSON.parse(contents) as Record<string, { type?: unknown }>;
    return Object.entries(stored)
      .filter((entry): entry is [string, { type: "api_key" | "oauth" }] =>
        ["api_key", "oauth"].includes(String(entry[1]?.type)),
      )
      .map(([providerId, credential]) => ({ providerId, type: credential.type }));
  }

  async modify(): Promise<Credential | undefined> {
    throw new Error("Doctor credential storage is read-only");
  }

  async delete(): Promise<void> {
    throw new Error("Doctor credential storage is read-only");
  }
}

const executeFile = promisify(execFile);

export async function checkCodexReadiness(config: Config): Promise<string> {
  if (process.platform !== "darwin") {
    throw new Error("Codex requires macOS Seatbelt sandboxing; this platform is unsupported");
  }
  if (config.agentMode !== "read-only") {
    throw new Error("Codex currently supports read-only mode only");
  }
  let executable = config.codexExecutable;
  if (!executable) {
    try {
      executable = (await executeFile("/usr/bin/which", ["codex"])).stdout.trim();
    } catch {
      throw new Error("Codex CLI is not installed or is not on PATH");
    }
  }
  try {
    executable = realpathSync(executable);
    await executeFile(executable, ["--version"], { timeout: 10_000 });
  } catch {
    throw new Error("Codex CLI could not be executed; verify SLACK_CODEX_EXECUTABLE");
  }
  const home = config.codexHome ?? defaultCodexHome(config.workspace);
  try {
    await executeFile(
      executable,
      ["-c", 'cli_auth_credentials_store="keyring"', "login", "status"],
      {
        timeout: 10_000,
        env: { ...process.env, CODEX_HOME: home },
      },
    );
  } catch {
    throw new Error(
      `Codex authentication is missing; run \`CODEX_HOME=${home} codex -c cli_auth_credentials_store=keyring login\``,
    );
  }
  try {
    const profile = codexSandboxProfile(config.workspace, home, executable);
    await executeFile("/usr/bin/sandbox-exec", ["-p", profile, "/usr/bin/true"], {
      timeout: 10_000,
    });
  } catch {
    throw new Error("Codex process confinement is unavailable; macOS Seatbelt must be enabled");
  }
  return "Codex CLI authentication and read-only process confinement are available";
}

export async function checkPiReadiness(workspace: string): Promise<string> {
  const agentDir = getAgentDir();
  const authPath = join(agentDir, "auth.json");
  const settings = SettingsManager.create(workspace, agentDir);
  const settingsErrors = settings.drainErrors();
  if (settingsErrors.length > 0)
    throw new Error("Pi settings could not be read; run `pi` to repair them");

  const runtime = await ModelRuntime.create({
    credentials: new ReadOnlyPiCredentials(authPath),
    modelsPath: join(agentDir, "models.json"),
    refreshOnCreate: false,
  });
  const runtimeError = runtime.getError();
  if (runtimeError) throw new Error("Pi model configuration is invalid; run `pi` to repair it");

  const provider = settings.getDefaultProvider();
  const modelId = settings.getDefaultModel();
  if ((provider && !modelId) || (!provider && modelId)) {
    throw new Error("Pi's default provider/model setting is incomplete; select a model in `pi`");
  }

  if (provider && modelId) {
    if (!runtime.getModel(provider, modelId)) {
      throw new Error("Pi's default model is unavailable; select another model in `pi`");
    }
    const auth = await runtime.checkAuth(provider, { signal: AbortSignal.timeout(10_000) });
    if (!auth)
      throw new Error(`Pi authentication is missing for ${provider}; run \`pi\` and /login`);
    return `Pi model ${provider}/${modelId} has local ${auth.type} authentication`;
  }

  const available = await runtime.getAvailable(undefined, { signal: AbortSignal.timeout(10_000) });
  const model = available[0];
  if (!model) throw new Error("No authenticated Pi model is available; run `pi` and /login");
  return `Pi model ${model.provider}/${model.id} is available`;
}

export async function runDoctor(
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: DoctorDependencies = {},
): Promise<DoctorResult> {
  const diagnostics: DoctorDiagnostic[] = [];
  const missing = REQUIRED_SETTINGS.filter((name) => !environment[name]?.trim());
  for (const name of REQUIRED_SETTINGS) {
    diagnostic(
      diagnostics,
      missing.includes(name) ? "fail" : "pass",
      name,
      missing.includes(name) ? `${name} is required; set it in .env` : `${name} is set`,
    );
  }

  const prefixes = [
    ["SLACK_BOT_TOKEN", "xoxb-"],
    ["SLACK_APP_TOKEN", "xapp-"],
  ] as const;
  for (const [name, prefix] of prefixes) {
    const value = environment[name]?.trim();
    if (!value) continue;
    const valid = value.startsWith(prefix);
    diagnostic(
      diagnostics,
      valid ? "pass" : "fail",
      `${name} format`,
      valid ? `${name} has the expected prefix` : `${name} must start with ${prefix}`,
    );
  }

  if (missing.length > 0) return { diagnostics, ok: false };

  let config: Config;
  try {
    config = loadConfig(environment);
    diagnostic(diagnostics, "pass", "Configuration", "Configuration values are valid");
  } catch (error) {
    diagnostic(
      diagnostics,
      "fail",
      "Configuration",
      error instanceof Error ? error.message : "Configuration could not be loaded",
    );
    return { diagnostics, ok: false };
  }

  try {
    await checkWorkspace(config);
    diagnostic(
      diagnostics,
      "pass",
      "SLACK_AGENT_CWD access",
      `Workspace is accessible in ${config.agentMode} mode`,
    );
  } catch {
    diagnostic(
      diagnostics,
      "fail",
      "SLACK_AGENT_CWD access",
      `SLACK_AGENT_CWD lacks permissions required for ${config.agentMode} mode`,
    );
  }

  try {
    await checkSessionPath(config);
    diagnostic(
      diagnostics,
      "pass",
      "Session storage",
      `${config.agentBackend === "codex" ? "Codex" : "Pi"} session storage is writable`,
    );
  } catch {
    diagnostic(
      diagnostics,
      "fail",
      "Session storage",
      "SLACK_AGENT_SESSION_DIR must be a creatable, writable directory",
    );
  }

  try {
    const available = await (dependencies.portAvailable ?? isPortAvailable)(config.healthPort);
    diagnostic(
      diagnostics,
      available ? "pass" : "fail",
      "Health port",
      available
        ? `Health port ${config.healthPort} is available`
        : `Health port ${config.healthPort} is unavailable; stop its listener or change SLACK_AGENT_HEALTH_PORT`,
    );
  } catch {
    diagnostic(diagnostics, "fail", "Health port", "Health port availability could not be checked");
  }

  try {
    const available = await (dependencies.socketAvailable ?? isLocalSocketAvailable)(
      config.socketPath,
    );
    diagnostic(
      diagnostics,
      available ? "pass" : "fail",
      "Local control socket",
      available
        ? "Local control socket path is available"
        : "Local control socket path is occupied or unsafe",
    );
  } catch {
    diagnostic(
      diagnostics,
      "fail",
      "Local control socket",
      "Local control socket parent must be writable and owner-controlled",
    );
  }

  if (config.slackBotToken.startsWith("xoxb-")) {
    try {
      const authenticate =
        dependencies.slackAuth ??
        ((token: string) => new WebClient(token).auth.test() as Promise<{ user_id?: string }>);
      const authentication = await authenticate(config.slackBotToken);
      if (!authentication.user_id) throw new Error("bot user ID missing");
      diagnostic(diagnostics, "pass", "Slack authentication", "Slack bot authentication succeeded");
    } catch {
      diagnostic(
        diagnostics,
        "fail",
        "Slack authentication",
        "Slack auth.test failed; verify SLACK_BOT_TOKEN and reinstall the app if needed",
      );
    }
  }

  const readinessCheck = config.agentBackend === "codex" ? "Codex readiness" : "Pi readiness";
  try {
    const message =
      config.agentBackend === "codex"
        ? await (dependencies.codexReady ?? checkCodexReadiness)(config)
        : await (dependencies.piReady ?? checkPiReadiness)(config.workspace);
    diagnostic(diagnostics, "pass", readinessCheck, message);
  } catch (error) {
    diagnostic(
      diagnostics,
      "fail",
      readinessCheck,
      error instanceof Error ? error.message : `${readinessCheck} could not be checked`,
    );
  }

  return { diagnostics, ok: diagnostics.every(({ status }) => status !== "fail") };
}
