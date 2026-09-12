import { describe, expect, test } from "bun:test";
import { type AgentBackend, QueuedAgentBackend } from "../src/agent.ts";

function deferred() {
  let resolve!: (value: string) => void;
  const promise = new Promise<string>((done) => { resolve = done; });
  return { promise, resolve };
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
    const queued = new QueuedAgentBackend(backend);

    const firstRun = queued.run({ conversationId: "thread", prompt: "first" });
    const secondRun = queued.run({ conversationId: "thread", prompt: "second" });
    await Bun.sleep(0);
    expect(calls).toEqual(["first"]);

    first.resolve("done");
    expect(await firstRun).toBe("done");
    expect(await secondRun).toBe("second");
    expect(calls).toEqual(["first", "second"]);
  });

  test("allows different conversations to run concurrently", async () => {
    const calls: string[] = [];
    const backend: AgentBackend = {
      run: async ({ conversationId }) => {
        calls.push(conversationId);
        return conversationId;
      },
      dispose: () => {},
    };
    const queued = new QueuedAgentBackend(backend);

    expect(await Promise.all([
      queued.run({ conversationId: "one", prompt: "a" }),
      queued.run({ conversationId: "two", prompt: "b" }),
    ])).toEqual(["one", "two"]);
    expect(calls).toEqual(["one", "two"]);
  });
});
