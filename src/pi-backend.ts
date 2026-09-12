import {
  type AgentSession,
  createAgentSession,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { AgentBackend, AgentRequest } from "./agent.ts";

const TOOLS = ["read", "grep", "find", "ls", "edit", "write"];

export class PiBackend implements AgentBackend {
  private readonly sessions = new Map<string, Promise<AgentSession>>();

  constructor(private readonly workspace: string) {}

  async run({ conversationId, prompt }: AgentRequest): Promise<string> {
    const session = await this.sessionFor(conversationId);
    const output: string[] = [];
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        output.push(event.assistantMessageEvent.delta);
      }
    });

    try {
      await session.prompt(prompt);
      return output.join("").trim();
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

    const created = createAgentSession({
      cwd: this.workspace,
      sessionManager: SessionManager.inMemory(this.workspace),
      tools: TOOLS,
    }).then(({ session }) => session);
    this.sessions.set(conversationId, created);
    created.catch(() => this.sessions.delete(conversationId));
    return created;
  }
}
