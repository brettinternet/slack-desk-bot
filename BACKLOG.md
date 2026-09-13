# SlackDeskBot backlog

This backlog captures remaining safety, setup, developer-experience, and Slack usability work. Items are ordered roughly by priority and dependency. Stable IDs should remain unchanged when tasks are refined or completed.

## Working principles

- Keep Slack transport independent from agent backend implementations.
- Preserve read-only mode as the default and do not add shell access.
- Do not broaden filesystem access beyond `SLACK_AGENT_CWD`.
- Prefer small, explicit behavior over a generalized framework.
- Keep prompts, file contents, tokens, and credentials out of logs.
- Add focused tests for every behavior change and keep `task check` and `task test` passing.

## Completed items

### SDB-025: Add a local operator connection to live conversations

**Why:** A Slack user can continue a persisted agent conversation, but the desktop operator cannot safely inspect or participate in that live conversation from a terminal. Starting `pi --session <file>` is not an attach mechanism: Pi session JSONL files are designed for one owning process, a second process would not share in-memory state or queueing, and concurrent writes could corrupt or fork history. Stopping the service and resuming a file is useful only for recovery.

**User experience:** Keep SlackDeskBot as the sole owner of agent sessions and expose a local terminal client that joins through the running service:

```text
$ slack-desk sessions
SESSION   CONVERSATION             STATE   LAST ACTIVE
f82ab719  C0123:1726000000.000100  idle    2m

$ slack-desk attach f82ab719
Attached to C0123:1726000000.000100
user> Can you inspect the failing build?
agent> I found...
operator> Check whether this started after the config change.
agent> ...
```

The attached client can watch new turns, submit an operator turn, show status, and cancel an active request. Slack and local operator turns use the existing per-conversation queue. Operator prompts and resulting agent replies are also posted to the originating Slack thread, clearly attributed, so Slack retains a complete visible conversation. Disconnecting a client never stops the session or request.

**Architecture:**

- Add a local Unix domain socket owned by the SlackDeskBot process. The service remains the only process that opens mutable session files or calls an `AgentBackend`.
- Put a small conversation coordinator above the transport adapters. Slack and the local socket submit the same backend-neutral request/command shape through `QueuedAgentBackend`; do not add Slack or terminal concepts to `AgentBackend`.
- Publish bounded lifecycle events (`queued`, `started`, `tool-use`, final response, failure, cancellation) to attached local clients. Do not expose model deltas until streaming is separately justified.
- Add only the backend capabilities required by the client: list known conversations/sessions with safe summary metadata, resolve a displayed session ID to its canonical conversation ID, run/status/cancel, and subscribe to live events.
- Keep Slack delivery in the Slack adapter. The coordinator should emit an attributed operator turn/result for Slack to publish rather than accepting a Slack client dependency.
- Use a versioned, newline-delimited JSON protocol with request IDs and explicit message types. Bound frame size, attached clients, subscriptions, and pending requests; a slow or disconnected client must not block Slack delivery or agent execution.
- Start with a standalone `slack-desk` CLI. A later user-level Pi extension may provide `/desk sessions`, `/desk attach`, `/desk send`, and `/desk cancel` by speaking the same socket protocol. It must proxy to the service rather than open the Slack session file. Normal prompts in the desktop Pi session remain distinct unless an explicit `/desk send` command is used.

**Security and operations:**

- Default the socket below the user's application-support directory, create its parent and socket with owner-only permissions, reject non-owner peers where macOS exposes peer credentials, and remove only a verified stale socket owned by this service.
- The socket is local-only and has no TCP fallback. Do not put tokens, prompts, file contents, session file paths, or Slack user names in discovery output or logs.
- Treat the local client as an operator identity. It may participate only in existing conversations and may cancel any active request, but it must not bypass tool mode, workspace policy, queue limits, or backend disposal.
- Add readiness/doctor checks for socket path validity and collision. Shutdown stops accepting clients, closes them, then disposes the backend exactly once.

**Backend portability:** The socket protocol is a conversation control plane, not a Pi protocol. It should work with future Claude Code, Codex, or other `AgentBackend` adapters if they implement persistent conversation lookup, request/response execution, status, and cancellation. The socket does not itself provide those adapters and cannot attach to another product's native TUI; subprocess/RPC lifecycle, event translation, persistence, and cancellation remain backend-specific. Keep optional capabilities explicit so a backend can report unsupported status or session listing without leaking transport-specific behavior.

**Herdr:** Herdr is not required for session ownership, IPC, queueing, or the first CLI. It may later launch the attach client in a visible pane or associate a conversation with an isolated workspace/worktree, but the socket protocol and service must work without Herdr. Do not make Herdr a runtime dependency.

**Done:**

- Integration test: a Slack turn followed by a local operator turn reaches the same fake backend conversation in order, and both results are delivered to the correct subscribers/Slack thread.
- Integration tests cover list/attach, status, operator cancellation, reconnect after client disconnect, malformed and oversized frames, unauthorized socket access where testable, backpressure, startup collision, and clean shutdown.
- A real smoke test demonstrates Slack and `slack-desk attach` alternating turns against one Pi SDK session without a second process opening its JSONL file.
- README documents the terminal workflow, security boundary, recovery-only offline resume procedure, and why concurrent `pi --session` access is unsupported.

### SDB-026: Add a Codex CLI backend

**Depends on:** SDB-025, so local operator session discovery and control are backend-neutral before another session implementation is introduced.

**Why:** Codex CLI provides non-interactive JSONL execution, resumable thread IDs, and an explicit sandbox mode, making it a strong second implementation of `AgentBackend` and a useful portability test for the conversation control plane.

**Scope:**

- Add an explicit backend setting with Pi remaining the default. Backend selection, readiness checks, authentication diagnostics, and session storage must not leak into the Slack transport or local operator protocol.
- Run Codex non-interactively in `SLACK_AGENT_CWD`, parse structured events into tool-use and final-response events, and persist the mapping from canonical conversation IDs to Codex thread IDs.
- Resume the exact thread for subsequent Slack or local operator turns. Implement conversation lookup, reset, status where metadata is available, cancellation, process cleanup, and restoration after service restart.
- Start with read-only mode. Use Codex's native sandbox plus an independently verified process boundary that prevents reads outside `SLACK_AGENT_CWD`, writes, unrestricted shell access, and access to blocked credential paths. Do not claim parity based on prompt instructions alone.
- Do not enable read-write mode until it can preserve the existing workspace/path policy and single-writer guarantee without granting broader filesystem or shell permissions. Report the mode as unsupported if those guarantees cannot be enforced.
- Inline text attachments. Support images only if Codex accepts them without weakening the current in-memory file guarantee; otherwise return a clear backend capability error.

**Done:**

- Focused adapter tests cover new and resumed threads, JSONL parsing, tool-use notification, final response and provider errors, cancellation, reset, restart restoration, malformed output, nonzero exit, timeout, and disposal.
- Security tests demonstrate read confinement and blocked writes/credential paths using the actual Codex process boundary, not only mocked command arguments.
- Integration and smoke tests show Slack and `slack-desk attach` alternating turns in one Codex thread.
- Doctor and README document installation, authentication, supported modes and attachments, session behavior, and security differences from Pi.

### SDB-027: Add a Claude Code CLI backend

**Depends on:** SDB-025. Reuse backend-neutral conversation control behavior proven by the Codex adapter, but keep Claude-specific process and event handling in its own adapter rather than introducing a generalized CLI framework prematurely.

**Why:** Claude Code supports headless execution, structured streaming output, explicit session IDs and resume, and granular tool controls. It provides a second external backend with different permission and session semantics.

**Scope:**

- Add Claude Code to the explicit backend setting, readiness checks, and doctor output without coupling Slack or the local operator protocol to Claude concepts.
- Run `claude` in print mode with structured streaming output, capture the assigned session ID, and persist its mapping to the canonical conversation ID. Resume only that session for later turns.
- Translate structured assistant and tool events into the existing observer lifecycle. Implement conversation lookup, reset, available status metadata, cancellation, subprocess cleanup, and restoration after service restart.
- Disable Bash and every unneeded tool. Map read-only and read-write modes to the smallest Claude tool allowlist, and enforce `SLACK_AGENT_CWD` plus blocked credential paths with CLI-native policy/hooks and an independently verified sandbox boundary. Prompt instructions are not a security control.
- Preserve the single-writer limit in read-write mode. If Claude Code cannot enforce equivalent path and tool restrictions for a mode, fail readiness rather than silently broadening access.
- Inline text attachments. Support images only through an interface that preserves the current in-memory file guarantee; otherwise return a clear backend capability error.

**Done:**

- Focused adapter tests cover session creation/resume, stream parsing, tool-use notification, final response and provider errors, cancellation, reset, restart restoration, malformed output, nonzero exit, timeout, and disposal.
- Security tests demonstrate that Bash, out-of-workspace reads/writes, and blocked credential paths are denied by the effective runtime policy.
- Integration and smoke tests show Slack and `slack-desk attach` alternating turns in one Claude Code session.
- Doctor and README document installation, authentication, supported modes and attachments, session behavior, and security differences from Pi and Codex.

## Later considerations

These may be useful later, but are not currently justified as separate implementation work:

- Slack App Home onboarding after `!help` proves insufficient.
- Interactive buttons for cancel/reset after command ergonomics are validated.
- Per-conversation worktrees if single-writer mode becomes a real throughput constraint.
- File upload for generated artifacts.
- Administrative session listing, deletion, and retention controls if more than one operator uses the service.
- Content-based secret detection in tool output (currently path-based only).
- Streaming partial responses to the status message for long-running turns.
