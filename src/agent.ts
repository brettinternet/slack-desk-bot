export type ImageMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

export type AgentAttachment =
  | {
      kind: "text";
      name: string;
      mediaType: string;
      text: string;
    }
  | {
      kind: "image";
      name: string;
      mediaType: ImageMediaType;
      data: string;
    };

export interface AgentRequest {
  conversationId: string;
  requesterId: string;
  prompt: string;
  attachments?: readonly AgentAttachment[];
  signal?: AbortSignal;
}

export type AgentCommand = "reset" | "status" | "cancel";
export type SessionCommand = Exclude<AgentCommand, "cancel">;

export interface AgentRunObserver {
  onQueued?(): void;
  onStarted?(): void;
  onToolUse(): void;
}

export interface AgentBackend {
  run(request: AgentRequest, observer?: AgentRunObserver): Promise<string>;
  sessionCommand?(conversationId: string, command: SessionCommand): Promise<string>;
  dispose(): void;
}

export interface CancellableAgentBackend extends AgentBackend {
  cancelActive(conversationId: string, requesterId: string): boolean;
  handleCommand(
    conversationId: string,
    requesterId: string,
    command: AgentCommand,
    observer?: AgentRunObserver,
  ): Promise<string>;
}

export interface QueueLimits {
  timeoutMs: number;
  queueWaitMs: number;
  maxQueuedPerConversation: number;
  maxConcurrentConversations: number;
  maxGlobalQueue: number;
  maxPendingPerRequester: number;
  rateLimitBurst: number;
  rateLimitRefillMs: number;
}

export class ConversationQueueFullError extends Error {
  constructor() {
    super("This conversation already has too many queued requests");
  }
}

export class GlobalQueueFullError extends Error {
  constructor() {
    super("The agent is busy and its request queue is full");
  }
}

export class RequesterLimitError extends Error {
  constructor() {
    super("You already have too many active or queued requests");
  }
}

export class RateLimitError extends Error {
  constructor() {
    super("You are sending requests too quickly; wait a moment and try again");
  }
}

export class AgentTimeoutError extends Error {
  constructor() {
    super("The agent request exceeded its runtime limit");
  }
}

export class AgentCancelledError extends Error {
  constructor() {
    super("The agent request was cancelled");
  }
}

export class QueueWaitTimeoutError extends Error {
  constructor() {
    super("The agent request waited too long in the queue");
  }
}

interface Job {
  request: AgentRequest;
  operation: (signal: AbortSignal) => Promise<string>;
  controller: AbortController;
  resolve: (value: string) => void;
  reject: (reason: unknown) => void;
  queueTimer?: ReturnType<typeof setTimeout>;
  completed: boolean;
  observer?: AgentRunObserver;
}

interface ConversationState {
  active?: Job;
  queue: Job[];
  ready: boolean;
}

interface RateBucket {
  tokens: number;
  updatedAt: number;
}

export class QueuedAgentBackend implements CancellableAgentBackend {
  private readonly conversations = new Map<string, ConversationState>();
  private readonly readyConversations: string[] = [];
  private readonly pendingByRequester = new Map<string, number>();
  private readonly rateBuckets = new Map<string, RateBucket>();
  private activeConversationCount = 0;
  private totalQueuedCount = 0;
  private disposed = false;

  constructor(
    private readonly backend: AgentBackend,
    private readonly limits: QueueLimits,
  ) {}

  run(request: AgentRequest, observer?: AgentRunObserver): Promise<string> {
    return this.enqueue(
      request,
      (signal) => this.backend.run({ ...request, signal }, observer),
      observer,
    );
  }

  handleCommand(
    conversationId: string,
    requesterId: string,
    command: AgentCommand,
    observer?: AgentRunObserver,
  ): Promise<string> {
    if (command === "cancel") {
      try {
        observer?.onStarted?.();
      } catch {}
      return Promise.resolve(
        this.cancelActive(conversationId, requesterId)
          ? "Cancelled the active request."
          : "There is no active request to cancel.",
      );
    }
    const sessionCommand = this.backend.sessionCommand;
    if (!sessionCommand) return Promise.reject(new Error("Agent backend does not manage sessions"));
    if (command === "status") {
      try {
        observer?.onStarted?.();
      } catch {}
      return sessionCommand.call(this.backend, conversationId, command);
    }

    const request = { conversationId, requesterId, prompt: `!${command}` };
    return this.enqueue(
      request,
      () => sessionCommand.call(this.backend, conversationId, command),
      observer,
    );
  }

  cancelActive(conversationId: string, requesterId: string): boolean {
    const job = this.conversations.get(conversationId)?.active;
    if (!job || job.request.requesterId !== requesterId || job.controller.signal.aborted)
      return false;

    const error = new AgentCancelledError();
    job.controller.abort(error);
    this.completeJob(job, undefined, error);
    return true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    const error = new Error("Agent backend is disposed");
    for (const state of this.conversations.values()) {
      if (state.active && !state.active.controller.signal.aborted) {
        state.active.controller.abort(error);
        this.completeJob(state.active, undefined, error);
      }
      for (const job of state.queue) {
        if (job.queueTimer) clearTimeout(job.queueTimer);
        this.totalQueuedCount--;
        this.decrementPending(job.request.requesterId);
        this.completeJob(job, undefined, error);
      }
      state.queue = [];
    }
    this.backend.dispose();
  }

  private enqueue(
    request: AgentRequest,
    operation: (signal: AbortSignal) => Promise<string>,
    observer?: AgentRunObserver,
  ): Promise<string> {
    if (this.disposed) return Promise.reject(new Error("Agent backend is disposed"));

    const state = this.conversations.get(request.conversationId);
    if ((state?.queue.length ?? 0) >= this.limits.maxQueuedPerConversation) {
      return Promise.reject(new ConversationQueueFullError());
    }

    const canStartImmediately =
      !state?.active &&
      (state?.queue.length ?? 0) === 0 &&
      this.activeConversationCount < this.limits.maxConcurrentConversations;
    if (!canStartImmediately && this.totalQueuedCount >= this.limits.maxGlobalQueue) {
      return Promise.reject(new GlobalQueueFullError());
    }

    const pending = this.pendingByRequester.get(request.requesterId) ?? 0;
    if (pending >= this.limits.maxPendingPerRequester) {
      return Promise.reject(new RequesterLimitError());
    }
    if (!this.consumeRateLimit(request.requesterId)) {
      return Promise.reject(new RateLimitError());
    }

    const conversation = state ?? { queue: [], ready: false };
    if (!state) this.conversations.set(request.conversationId, conversation);

    const result = new Promise<string>((resolve, reject) => {
      const job: Job = {
        request,
        operation,
        controller: new AbortController(),
        resolve,
        reject,
        completed: false,
        observer,
      };
      job.queueTimer = setTimeout(
        () => this.expireQueuedJob(request.conversationId, job),
        this.limits.queueWaitMs,
      );
      conversation.queue.push(job);
    });

    this.totalQueuedCount++;
    this.pendingByRequester.set(request.requesterId, pending + 1);
    try {
      observer?.onQueued?.();
    } catch {}
    this.markReady(request.conversationId, conversation);
    this.pump();
    return result;
  }

  private consumeRateLimit(requesterId: string): boolean {
    const now = Date.now();
    const existing = this.rateBuckets.get(requesterId);
    const elapsed = existing ? now - existing.updatedAt : 0;
    const tokens = Math.min(
      this.limits.rateLimitBurst,
      (existing?.tokens ?? this.limits.rateLimitBurst) + elapsed / this.limits.rateLimitRefillMs,
    );
    if (tokens < 1) {
      this.rateBuckets.set(requesterId, { tokens, updatedAt: now });
      return false;
    }
    this.rateBuckets.set(requesterId, { tokens: tokens - 1, updatedAt: now });
    return true;
  }

  private markReady(conversationId: string, state: ConversationState): void {
    if (state.active || state.ready || state.queue.length === 0) return;
    state.ready = true;
    this.readyConversations.push(conversationId);
  }

  private pump(): void {
    while (
      !this.disposed &&
      this.activeConversationCount < this.limits.maxConcurrentConversations &&
      this.readyConversations.length > 0
    ) {
      const conversationId = this.readyConversations.shift()!;
      const state = this.conversations.get(conversationId);
      if (!state) continue;
      state.ready = false;
      if (state.active || state.queue.length === 0) continue;

      const job = state.queue.shift()!;
      if (job.queueTimer) clearTimeout(job.queueTimer);
      this.totalQueuedCount--;
      state.active = job;
      this.activeConversationCount++;
      void this.execute(conversationId, state, job);
    }
  }

  private async execute(conversationId: string, state: ConversationState, job: Job): Promise<void> {
    try {
      job.observer?.onStarted?.();
    } catch {}
    const runtimeTimer = setTimeout(() => {
      const error = new AgentTimeoutError();
      job.controller.abort(error);
      this.completeJob(job, undefined, error);
    }, this.limits.timeoutMs);

    try {
      const value = await job.operation(job.controller.signal);
      if (job.controller.signal.aborted) {
        this.completeJob(job, undefined, job.controller.signal.reason);
      } else {
        this.completeJob(job, value);
      }
    } catch (error) {
      this.completeJob(
        job,
        undefined,
        job.controller.signal.aborted ? job.controller.signal.reason : error,
      );
    } finally {
      clearTimeout(runtimeTimer);
      this.decrementPending(job.request.requesterId);
      state.active = undefined;
      this.activeConversationCount--;

      if (state.queue.length > 0) {
        this.markReady(conversationId, state);
      } else {
        this.conversations.delete(conversationId);
      }
      this.pump();
    }
  }

  private expireQueuedJob(conversationId: string, job: Job): void {
    const state = this.conversations.get(conversationId);
    if (!state) return;
    const index = state.queue.indexOf(job);
    if (index < 0) return;

    state.queue.splice(index, 1);
    this.totalQueuedCount--;
    this.decrementPending(job.request.requesterId);
    this.completeJob(job, undefined, new QueueWaitTimeoutError());
    if (!state.active && state.queue.length === 0) this.conversations.delete(conversationId);
  }

  private completeJob(job: Job, value?: string, error?: unknown): void {
    if (job.completed) return;
    job.completed = true;
    if (error === undefined) job.resolve(value ?? "");
    else job.reject(error);
  }

  private decrementPending(requesterId: string): void {
    const remaining = (this.pendingByRequester.get(requesterId) ?? 1) - 1;
    if (remaining <= 0) this.pendingByRequester.delete(requesterId);
    else this.pendingByRequester.set(requesterId, remaining);
  }
}
