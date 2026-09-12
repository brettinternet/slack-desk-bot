import { describe, expect, test } from "bun:test";
import {
  AgentCancelledError,
  AgentTimeoutError,
  type AgentBackend,
  ConversationQueueFullError,
  GlobalQueueFullError,
  type QueueLimits,
  QueuedAgentBackend,
  QueueWaitTimeoutError,
  RateLimitError,
  RequesterLimitError,
} from "../src/agent.ts";

function deferred<T = string>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function limits(overrides: Partial<QueueLimits> = {}): QueueLimits {
  return {
    timeoutMs: 10_000,
    queueWaitMs: 10_000,
    maxQueuedPerConversation: 2,
    maxConcurrentConversations: 3,
    maxGlobalQueue: 20,
    maxPendingPerRequester: 10,
    rateLimitBurst: 20,
    rateLimitRefillMs: 60_000,
    ...overrides,
  };
}

function request(conversationId: string, prompt: string, requesterId = "user") {
  return { conversationId, requesterId, prompt };
}

describe("QueuedAgentBackend", () => {
  test("serializes requests in one conversation", async () => {
    const first = deferred();
    const calls: string[] = [];
    const backend: AgentBackend = {
      run: async ({ prompt }) => {
        calls.push(prompt);
        if (prompt === "first") return first.promise;
        return prompt;
      },
      dispose: () => {},
    };
    const queued = new QueuedAgentBackend(backend, limits());

    const firstRun = queued.run(request("thread", "first"));
    const secondRun = queued.run(request("thread", "second"));
    await Bun.sleep(0);
    expect(calls).toEqual(["first"]);

    first.resolve("done");
    expect(await firstRun).toBe("done");
    expect(await secondRun).toBe("second");
    expect(calls).toEqual(["first", "second"]);
    queued.dispose();
  });

  test("limits concurrent conversations", async () => {
    const releases = [deferred(), deferred(), deferred()];
    const calls: string[] = [];
    const backend: AgentBackend = {
      run: async ({ conversationId }) => {
        calls.push(conversationId);
        return releases[Number(conversationId) - 1].promise;
      },
      dispose: () => {},
    };
    const queued = new QueuedAgentBackend(backend, limits({ maxConcurrentConversations: 2 }));

    const runs = ["1", "2", "3"].map((id) => queued.run(request(id, id, id)));
    await Bun.sleep(0);
    expect(calls).toEqual(["1", "2"]);

    releases[0].resolve("one");
    await runs[0];
    await Bun.sleep(0);
    expect(calls).toEqual(["1", "2", "3"]);

    releases[1].resolve("two");
    releases[2].resolve("three");
    await Promise.all(runs);
    queued.dispose();
  });

  test("schedules busy conversations fairly", async () => {
    const first = deferred();
    const second = deferred();
    const calls: string[] = [];
    const backend: AgentBackend = {
      run: async ({ prompt }) => {
        calls.push(prompt);
        if (prompt === "a1") return first.promise;
        if (prompt === "b1") return second.promise;
        return prompt;
      },
      dispose: () => {},
    };
    const queued = new QueuedAgentBackend(backend, limits({ maxConcurrentConversations: 1 }));

    const a1 = queued.run(request("a", "a1", "a"));
    const a2 = queued.run(request("a", "a2", "a"));
    const b1 = queued.run(request("b", "b1", "b"));
    first.resolve("a1");
    await a1;
    await Bun.sleep(0);
    expect(calls).toEqual(["a1", "b1"]);

    second.resolve("b1");
    await Promise.all([a2, b1]);
    expect(calls).toEqual(["a1", "b1", "a2"]);
    queued.dispose();
  });

  test("rejects requests beyond conversation and global queue limits", async () => {
    const active = deferred();
    const backend: AgentBackend = {
      run: async ({ conversationId }) =>
        conversationId === "active" ? active.promise : conversationId,
      dispose: () => {},
    };
    const queued = new QueuedAgentBackend(
      backend,
      limits({
        maxConcurrentConversations: 1,
        maxQueuedPerConversation: 1,
        maxGlobalQueue: 2,
      }),
    );

    const first = queued.run(request("active", "first", "a"));
    const sameConversation = queued.run(request("active", "second", "b"));
    await expect(queued.run(request("active", "third", "c"))).rejects.toBeInstanceOf(
      ConversationQueueFullError,
    );
    const otherConversation = queued.run(request("other", "first", "d"));
    await expect(queued.run(request("third", "first", "e"))).rejects.toBeInstanceOf(
      GlobalQueueFullError,
    );

    active.resolve("done");
    await Promise.all([first, sameConversation, otherConversation]);
    queued.dispose();
  });

  test("limits pending requests and request rate per requester", async () => {
    const active = deferred();
    const backend: AgentBackend = {
      run: async ({ prompt }) => (prompt === "hold" ? active.promise : prompt),
      dispose: () => {},
    };
    const pendingLimited = new QueuedAgentBackend(backend, limits({ maxPendingPerRequester: 1 }));
    const first = pendingLimited.run(request("one", "hold"));
    await expect(pendingLimited.run(request("two", "next"))).rejects.toBeInstanceOf(
      RequesterLimitError,
    );
    active.resolve("done");
    await first;
    pendingLimited.dispose();

    const rateLimited = new QueuedAgentBackend(
      { run: async ({ prompt }) => prompt, dispose: () => {} },
      limits({ rateLimitBurst: 2 }),
    );
    await rateLimited.run(request("one", "one"));
    await rateLimited.run(request("two", "two"));
    await expect(rateLimited.run(request("three", "three"))).rejects.toBeInstanceOf(RateLimitError);
    rateLimited.dispose();
  });

  test("times out and aborts an active request", async () => {
    let receivedSignal: AbortSignal | undefined;
    const backend: AgentBackend = {
      run: ({ signal }) => {
        receivedSignal = signal;
        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
      dispose: () => {},
    };
    const queued = new QueuedAgentBackend(backend, limits({ timeoutMs: 10 }));

    await expect(queued.run(request("thread", "slow"))).rejects.toBeInstanceOf(AgentTimeoutError);
    await Bun.sleep(20);
    expect(receivedSignal?.aborted).toBe(true);
    queued.dispose();
  });

  test("keeps a concurrency slot until a timed-out backend settles", async () => {
    const blocked = deferred();
    const calls: string[] = [];
    const backend: AgentBackend = {
      run: async ({ prompt }) => {
        calls.push(prompt);
        return prompt === "slow" ? blocked.promise : prompt;
      },
      dispose: () => {},
    };
    const queued = new QueuedAgentBackend(
      backend,
      limits({ timeoutMs: 10, maxConcurrentConversations: 1 }),
    );

    const slow = queued.run(request("slow", "slow", "a"));
    const next = queued.run(request("next", "next", "b"));
    await expect(slow).rejects.toBeInstanceOf(AgentTimeoutError);
    await Bun.sleep(20);
    expect(calls).toEqual(["slow"]);

    blocked.resolve("late");
    await next;
    expect(calls).toEqual(["slow", "next"]);
    queued.dispose();
  });

  test("cancels an active request without removing queued work", async () => {
    const active = deferred();
    const backend: AgentBackend = {
      run: async ({ prompt }) => (prompt === "active" ? active.promise : prompt),
      dispose: () => {},
    };
    const queued = new QueuedAgentBackend(backend, limits());

    const first = queued.run(request("thread", "active"));
    const second = queued.run(request("thread", "queued", "other"));
    expect(queued.cancelActive("thread", "other")).toBe(false);
    expect(queued.cancelActive("thread", "user")).toBe(true);
    expect(queued.cancelActive("thread", "user")).toBe(false);
    await expect(first).rejects.toBeInstanceOf(AgentCancelledError);

    active.resolve("stopped");
    expect(await second).toBe("queued");
    queued.dispose();
  });

  test("expires stale queued requests", async () => {
    const active = deferred();
    const backend: AgentBackend = {
      run: async ({ prompt }) => (prompt === "active" ? active.promise : prompt),
      dispose: () => {},
    };
    const queued = new QueuedAgentBackend(backend, limits({ queueWaitMs: 10 }));

    const first = queued.run(request("thread", "active", "one"));
    const stale = queued.run(request("thread", "stale", "two"));
    await expect(stale).rejects.toBeInstanceOf(QueueWaitTimeoutError);
    await Bun.sleep(20);

    active.resolve("done");
    await first;
    queued.dispose();
  });
});
