import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { AgentBackend, AgentRequest } from "./agent.ts";
import { workspacePolicy } from "./workspace-policy.ts";

const TOOLS = ["read", "grep", "find", "ls", "edit", "write"];

export function createResponseCollector() {
  const output: string[] = [];
  let currentMessage: string[] | undefined;

  return {
    handle(event: AgentSessionEvent): void {
      if (event.type === "message_start" && event.message.role === "assistant") {
        currentMessage = [];
      } else if (
        event.type === "message_update"
        && event.assistantMessageEvent.type === "text_delta"
      ) {
        currentMessage?.push(event.assistantMessageEvent.delta);
      } else if (event.type === "message_end" && event.message.role === "assistant") {
        if (event.message.stopReason !== "error" && currentMessage?.length) {
          output.push(currentMessage.join(""));
        }
        currentMessage = undefined;
      }
    },
    text(): string {
      return output.join("\n\n").trim();
    },
  };
}

export class PiBackend implements AgentBackend {
  private readonly sessions = new Map<string, Promise<AgentSession>>();

  constructor(private readonly workspace: string) {}

  async run({ conversationId, prompt }: AgentRequest): Promise<string> {
    const session = await this.sessionFor(conversationId);
    const collector = createResponseCollector();
    const unsubscribe = session.subscribe(collector.handle);

    try {
      await session.prompt(prompt);
      return collector.text();
    } finally {
      unsubscribe();
    }
  }

  dispose(): void {
    for (const session of this.sessions.values()) {
      void session.then((value) => value.dispose());
    }
    this.sessions.clear();
  }

  private sessionFor(conversationId: string): Promise<AgentSession> {
    const existing = this.sessions.get(conversationId);
    if (existing) return existing;

    const created = this.createSession();
    this.sessions.set(conversationId, created);
    created.catch(() => this.sessions.delete(conversationId));
    return created;
  }

  private async createSession(): Promise<AgentSession> {
    const resourceLoader = new DefaultResourceLoader({
      cwd: this.workspace,
      agentDir: getAgentDir(),
      extensionFactories: [workspacePolicy(this.workspace)],
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd: this.workspace,
      resourceLoader,
      sessionManager: SessionManager.inMemory(this.workspace),
      tools: TOOLS,
    });
    return session;
  }
}
