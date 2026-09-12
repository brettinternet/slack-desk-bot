export interface AgentRequest {
  conversationId: string;
  prompt: string;
}

export interface AgentBackend {
  run(request: AgentRequest): Promise<string>;
  dispose(): void;
}

export class QueuedAgentBackend implements AgentBackend {
  private readonly tails = new Map<string, Promise<void>>();

  constructor(private readonly backend: AgentBackend) {}

  async run(request: AgentRequest): Promise<string> {
    const previous = this.tails.get(request.conversationId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => {}).then(() => current);
    this.tails.set(request.conversationId, tail);

    await previous.catch(() => {});
    try {
      return await this.backend.run(request);
    } finally {
      release();
      if (this.tails.get(request.conversationId) === tail)
        this.tails.delete(request.conversationId);
    }
  }

  dispose(): void {
    this.backend.dispose();
  }
}
