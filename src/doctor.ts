import { execFile } from "node:child_process";
import { constants, realpathSync } from "node:fs";
import { access, lstat, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { createConnection, createServer } from "node:net";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
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
import { codexProcessEnvironment, codexSandboxProfile, defaultCodexHome } from "./codex-backend.ts";
import {
  claudeProcessEnvironment,
  claudeSandboxProfile,
  defaultClaudeHome,
} from "./claude-backend.ts";
import { loadConfig, type Config } from "./config.ts";
import { isConversationStoreCorrupt } from "./conversation-store.ts";
import { defaultSessionDirectory, PI_RESOURCE_POLICY_DESCRIPTION } from "./pi-backend.ts";

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
  claudeReady?: (config: Config) => Promise<string>;
  homeDirectory?: string;
  agentDirectory?: string;
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

async function canonicalPotentialPath(path: string): Promise<string> {
  const absolute = resolve(path);
  const existing = await nearestExistingPath(absolute);
  return resolve(realpathSync(existing), relative(existing, absolute));
}

async function workspaceContains(workspace: string, protectedPath: string): Promise<boolean> {
  const nested = relative(
    await canonicalPotentialPath(workspace),
    await canonicalPotentialPath(protectedPath),
  );
  return nested === "" || (!nested.startsWith("..") && !isAbsolute(nested));
}

async function workspaceCredentialOverlap(
  config: Config,
  homeDirectory = homedir(),
  agentDirectory = getAgentDir(),
): Promise<string | undefined> {
  const protectedPaths: Array<[string, string]> = [
    ["the user home directory", homeDirectory],
    ["the Pi agent directory", agentDirectory],
    ["the Codex credential directory", join(homeDirectory, ".codex")],
    ["the Claude credential directory", join(homeDirectory, ".claude")],
    ["the default Pi agent directory", join(homeDirectory, ".pi", "agent")],
    ["the macOS keychain directory", join(homeDirectory, "Library", "Keychains")],
    ["SLACK_AGENT_SESSION_DIR", config.sessionDir ?? defaultSessionDirectory(config.workspace)],
    ["SLACK_CODEX_HOME", config.codexHome ?? defaultCodexHome(config.workspace)],
    ["SLACK_CLAUDE_HOME", config.claudeHome ?? defaultClaudeHome(config.workspace)],
    ["the local control socket directory", dirname(config.socketPath)],
    [
      "the service environment file",
      join(homeDirectory, ".config", "slack-desk-bot", "service.env"),
    ],
  ];
  for (const [label, path] of protectedPaths) {
    if (await workspaceContains(config.workspace, path)) return label;
  }
  return undefined;
}

const BACKEND_LABELS: Record<Config["agentBackend"], string> = {
  pi: "Pi",
  codex: "Codex",
  claude: "Claude",
};

const SESSION_PATH_SETTINGS: Record<Config["agentBackend"], string> = {
  pi: "SLACK_AGENT_SESSION_DIR",
  codex: "SLACK_CODEX_HOME",
  claude: "SLACK_CLAUDE_HOME",
};

function backendSessionPath(config: Config): string {
  return config.agentBackend === "codex"
    ? (config.codexHome ?? defaultCodexHome(config.workspace))
    : config.agentBackend === "claude"
      ? (config.claudeHome ?? defaultClaudeHome(config.workspace))
      : (config.sessionDir ?? defaultSessionDirectory(config.workspace));
}

/** Only the external CLI backends keep a conversation mapping store. */
function backendStorePath(config: Config): string | undefined {
  return config.agentBackend === "pi"
    ? undefined
    : join(backendSessionPath(config), "conversations.json");
}

async function checkSessionPath(config: Config): Promise<void> {
  const sessionPath = backendSessionPath(config);
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

interface CliReadinessDependencies {
  executeFile?: typeof executeFile;
  platform?: NodeJS.Platform;
}

/**
 * `sandbox-exec -p` truncates long profiles, so readiness checks the same way
 * the backends run: from a profile file inside the backend-owned home.
 */
async function writeProfile(home: string, profile: string): Promise<string> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const path = join(home, "readiness.sb");
  await writeFile(path, profile, { mode: 0o600 });
  return path;
}

export async function checkCodexReadiness(
  config: Config,
  dependencies: CliReadinessDependencies = {},
): Promise<string> {
  const run = dependencies.executeFile ?? executeFile;
  if ((dependencies.platform ?? process.platform) !== "darwin") {
    throw new Error("Codex requires macOS Seatbelt sandboxing; this platform is unsupported");
  }
  if (config.agentMode !== "read-only") {
    throw new Error("Codex currently supports read-only mode only");
  }
  const home = config.codexHome ?? defaultCodexHome(config.workspace);
  await mkdir(join(home, "tmp"), { recursive: true, mode: 0o700 });
  const environment = codexProcessEnvironment(home);
  let executable = config.codexExecutable;
  if (!executable) {
    try {
      executable = (await run("/usr/bin/which", ["codex"], { env: environment })).stdout.trim();
    } catch {
      throw new Error("Codex CLI is not installed or is not on PATH");
    }
  }
  try {
    executable = realpathSync(executable);
    await run(executable, ["--version"], { timeout: 10_000, env: environment });
  } catch {
    throw new Error("Codex CLI could not be executed; verify SLACK_CODEX_EXECUTABLE");
  }
  try {
    await run(executable, ["login", "status"], { timeout: 10_000, env: environment });
  } catch {
    throw new Error(`Codex authentication is missing; run \`CODEX_HOME=${home} codex login\``);
  }
  try {
    const profile = codexSandboxProfile(config.workspace, home, executable);
    await run(
      "/usr/bin/sandbox-exec",
      ["-f", await writeProfile(home, profile), executable, "--version"],
      { timeout: 20_000, cwd: config.workspace, env: environment },
    );
  } catch {
    throw new Error("Codex process confinement is unavailable; macOS Seatbelt must be enabled");
  }
  return "Codex CLI authentication and read-only process confinement are available";
}

export async function checkClaudeReadiness(
  config: Config,
  dependencies: CliReadinessDependencies = {},
): Promise<string> {
  const run = dependencies.executeFile ?? executeFile;
  if ((dependencies.platform ?? process.platform) !== "darwin") {
    throw new Error("Claude Code requires macOS Seatbelt sandboxing; this platform is unsupported");
  }
  const home = config.claudeHome ?? defaultClaudeHome(config.workspace);
  await mkdir(join(home, "tmp"), { recursive: true, mode: 0o700 });
  const environment = claudeProcessEnvironment(home);
  let executable = config.claudeExecutable;
  if (!executable) {
    try {
      executable = (await run("/usr/bin/which", ["claude"], { env: environment })).stdout.trim();
    } catch {
      throw new Error("Claude Code CLI is not installed or is not on PATH");
    }
  }
  try {
    executable = realpathSync(executable);
    await run(executable, ["--version"], { timeout: 10_000, env: environment });
  } catch {
    throw new Error("Claude Code CLI could not be executed; verify SLACK_CLAUDE_EXECUTABLE");
  }
  try {
    await run(executable, ["auth", "status"], { timeout: 10_000, env: environment });
  } catch {
    throw new Error(
      `Claude Code authentication is missing; run \`CLAUDE_CONFIG_DIR=${home} claude auth login\``,
    );
  }
  try {
    const profile = claudeSandboxProfile(config.workspace, home, executable, config.agentMode);
    await run(
      "/usr/bin/sandbox-exec",
      ["-f", await writeProfile(home, profile), executable, "--version"],
      { timeout: 20_000, cwd: config.workspace, env: environment },
    );
  } catch {
    throw new Error("Claude process confinement is unavailable; macOS Seatbelt must be enabled");
  }
  return `Claude Code authentication and ${config.agentMode} process confinement are available`;
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
    const overlap = await workspaceCredentialOverlap(
      config,
      dependencies.homeDirectory,
      dependencies.agentDirectory,
    );
    diagnostic(
      diagnostics,
      overlap ? "fail" : "pass",
      "Workspace credential isolation",
      overlap
        ? `SLACK_AGENT_CWD contains ${overlap}; choose a workspace that cannot expose service credentials`
        : "Workspace does not contain service credential or state paths",
    );
  } catch {
    diagnostic(
      diagnostics,
      "fail",
      "Workspace credential isolation",
      "Workspace credential overlap could not be checked",
    );
  }

  try {
    await checkSessionPath(config);
    diagnostic(
      diagnostics,
      "pass",
      "Session storage",
      `${BACKEND_LABELS[config.agentBackend]} session storage is writable`,
    );
  } catch {
    diagnostic(
      diagnostics,
      "fail",
      "Session storage",
      `${SESSION_PATH_SETTINGS[config.agentBackend]} must be a creatable, writable directory`,
    );
  }

  const storePath = backendStorePath(config);
  if (storePath && isConversationStoreCorrupt(storePath)) {
    diagnostic(
      diagnostics,
      "fail",
      "Session storage",
      `${BACKEND_LABELS[config.agentBackend]} conversation store at ${storePath} is unreadable; restore it from backup or let the service quarantine it and start fresh`,
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

  if (config.agentBackend === "pi") {
    diagnostic(
      diagnostics,
      "pass",
      "Pi resources",
      `Agent directory: ${getAgentDir()}. ${PI_RESOURCE_POLICY_DESCRIPTION}`,
    );
  }

  const readinessCheck =
    config.agentBackend === "codex"
      ? "Codex readiness"
      : config.agentBackend === "claude"
        ? "Claude readiness"
        : "Pi readiness";
  try {
    const message =
      config.agentBackend === "codex"
        ? await (dependencies.codexReady ?? checkCodexReadiness)(config)
        : config.agentBackend === "claude"
          ? await (dependencies.claudeReady ?? checkClaudeReadiness)(config)
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
