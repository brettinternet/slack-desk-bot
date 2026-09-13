import {
  type AgentAdmission,
  type AgentCommand,
  type AgentRequest,
  type AgentRunObserver,
  type CancellableAgentBackend,
  type ConversationSummary,
  type QueueSnapshot,
} from "./agent.ts";
import { LOCAL_OPERATOR_ID } from "./local-protocol.ts";

export type ConversationEventType =
  "queued" | "started" | "tool-use" | "response" | "failure" | "cancellation";

export type ConversationRequesterKind = "slack" | "operator";

export interface ConversationEvent {
  type: ConversationEventType;
  conversationId: string;
  requesterKind?: ConversationRequesterKind;
  promptExcerpt?: string;
  response?: string;
  error?: string;
}

export interface OperatorExchange {
  conversationId: string;
  prompt: string;
  response: string;
}

type EventListener = (event: ConversationEvent) => void;
type OperatorListener = (exchange: OperatorExchange) => Promise<void> | void;

export class ConversationCoordinator implements CancellableAgentBackend {
  private readonly subscribers = new Map<string, Set<EventListener>>();
  private readonly operatorListeners = new Set<OperatorListener>();

  constructor(private readonly backend: CancellableAgentBackend & { snapshot(): QueueSnapshot }) {}

  admit(requesterId: string): AgentAdmission {
    if (!this.backend.admit) throw new Error("Agent backend does not support admission");
    return this.backend.admit(requesterId);
  }

  hasConversation(conversationId: string): Promise<boolean> {
    return this.backend.hasConversation?.(conversationId) ?? Promise.resolve(false);
  }

  async listConversations(): Promise<ConversationSummary[]> {
    if (!this.backend.listConversations) {
      throw new Error("Agent backend does not support conversation listing");
    }
    return this.backend.listConversations();
  }

  run(
    request: AgentRequest,
    observer?: AgentRunObserver,
    admission?: AgentAdmission,
  ): Promise<string> {
    const lifecycle = this.observer(request, observer);
    const result = admission
      ? this.backend.run(request, lifecycle, admission)
      : this.backend.run(request, lifecycle);
    return this.publishResult(request.conversationId, result);
  }

  handleCommand(
    conversationId: string,
    requesterId: string,
    command: AgentCommand,
    observer?: AgentRunObserver,
    admission?: AgentAdmission,
  ): Promise<string> {
    const lifecycle = this.observer(
      { conversationId, requesterId, prompt: `!${command}` },
      observer,
    );
    const result = admission
      ? this.backend.handleCommand(conversationId, requesterId, command, lifecycle, admission)
      : this.backend.handleCommand(conversationId, requesterId, command, lifecycle);
    return this.publishResult(conversationId, result);
  }

  async runOperator(conversationId: string, prompt: string): Promise<string> {
    if (!(await this.hasConversation(conversationId))) {
      throw new Error("Conversation does not exist");
    }
    try {
      const response = await this.run({
        conversationId,
        requesterId: LOCAL_OPERATOR_ID,
        prompt,
      });
      await this.publishOperatorExchange({ conversationId, prompt, response });
      return response;
    } catch (error) {
      await this.publishOperatorExchange({
        conversationId,
        prompt,
        response: "The local operator request failed.",
      });
      throw error;
    }
  }

  cancelOperator(conversationId: string): boolean {
    const cancelled = this.backend.cancelActive(conversationId, LOCAL_OPERATOR_ID, true);
    if (cancelled) this.emit({ type: "cancellation", conversationId });
    return cancelled;
  }

  cancelActive(conversationId: string, requesterId: string, cancelAnyRequester?: boolean): boolean {
    const cancelled = this.backend.cancelActive(conversationId, requesterId, cancelAnyRequester);
    if (cancelled) this.emit({ type: "cancellation", conversationId });
    return cancelled;
  }

  subscribe(conversationId: string, listener: EventListener): () => void {
    const listeners = this.subscribers.get(conversationId) ?? new Set<EventListener>();
    listeners.add(listener);
    this.subscribers.set(conversationId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.subscribers.delete(conversationId);
    };
  }

  onOperatorExchange(listener: OperatorListener): () => void {
    this.operatorListeners.add(listener);
    return () => this.operatorListeners.delete(listener);
  }

  snapshot(): QueueSnapshot {
    return this.backend.snapshot();
  }

  dispose(): void {
    this.subscribers.clear();
    this.operatorListeners.clear();
    this.backend.dispose();
  }

  private async publishOperatorExchange(exchange: OperatorExchange): Promise<void> {
    await Promise.allSettled([...this.operatorListeners].map((listener) => listener(exchange)));
  }

  private observer(
    request: Pick<AgentRequest, "conversationId" | "requesterId" | "prompt">,
    downstream?: AgentRunObserver,
  ): AgentRunObserver {
    const { conversationId } = request;
    const lifecycleDetails = {
      requesterKind: requesterKind(request.requesterId),
      promptExcerpt: boundedPromptExcerpt(request.prompt),
    };
    return {
      onQueued: () => {
        downstream?.onQueued?.();
        this.emit({ type: "queued", conversationId, ...lifecycleDetails });
      },
      onStarted: () => {
        downstream?.onStarted?.();
        this.emit({ type: "started", conversationId, ...lifecycleDetails });
      },
      onToolUse: () => {
        downstream?.onToolUse();
        this.emit({ type: "tool-use", conversationId });
      },
    };
  }

  private async publishResult(conversationId: string, result: Promise<string>): Promise<string> {
    try {
      const response = await result;
      this.emit({ type: "response", conversationId, response: boundedEventText(response) });
      return response;
    } catch (error) {
      this.emit({
        type: "failure",
        conversationId,
        error: error instanceof Error ? error.message : "Agent request failed",
      });
      throw error;
    }
  }

  private emit(event: ConversationEvent): void {
    for (const listener of this.subscribers.get(event.conversationId) ?? []) {
      try {
        listener(event);
      } catch {}
    }
  }
}

function requesterKind(requesterId: string): ConversationRequesterKind {
  return requesterId === LOCAL_OPERATOR_ID ? "operator" : "slack";
}

function boundedPromptExcerpt(prompt: string): string {
  const maxCharacters = 200;
  const singleLine = prompt.replace(/\s+/g, " ").trim();
  return singleLine.length <= maxCharacters
    ? singleLine
    : `${singleLine.slice(0, maxCharacters - 1)}…`;
}

function boundedEventText(text: string): string {
  const maxCharacters = 16_000;
  return text.length <= maxCharacters
    ? text
    : `${text.slice(0, maxCharacters)}\n\n[Local event truncated]`;
}
