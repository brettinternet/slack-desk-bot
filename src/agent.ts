export interface AgentRequest {
  conversationId: string;
  prompt: string;
}

export type AgentCommand = "reset" | "status" | "cancel";

export interface AgentBackend {
  run(request: AgentRequest): Promise<string | undefined>;
  command(conversationId: string, command: AgentCommand): Promise<string>;
  dispose(): void;
}

export class QueuedAgentBackend implements AgentBackend {
  private readonly tails = new Map<string, Promise<void>>();

  constructor(private readonly backend: AgentBackend) {}

  run(request: AgentRequest): Promise<string | undefined> {
    return this.enqueue(request.conversationId, () => this.backend.run(request));
  }

  command(conversationId: string, command: AgentCommand): Promise<string> {
    if (command === "cancel" || command === "status") {
      return this.backend.command(conversationId, command);
    }
    return this.enqueue(conversationId, () => this.backend.command(conversationId, command));
  }

  dispose(): void {
    this.backend.dispose();
  }

  private async enqueue<T>(conversationId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(conversationId);
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = (previous ?? Promise.resolve()).catch(() => {}).then(() => current);
    this.tails.set(conversationId, tail);

    if (previous) await previous.catch(() => {});
    try {
      return await operation();
    } finally {
      release();
      if (this.tails.get(conversationId) === tail) this.tails.delete(conversationId);
    }
  }
}
