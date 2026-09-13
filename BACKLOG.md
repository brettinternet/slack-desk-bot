# SlackDeskBot backlog

This backlog captures remaining safety, setup, developer-experience, and Slack usability work. Items are ordered roughly by priority and dependency. Stable IDs should remain unchanged when tasks are refined or completed.

## Working principles

- Keep Slack transport independent from agent backend implementations.
- Preserve read-only mode as the default and do not add shell access.
- Do not broaden filesystem access beyond `SLACK_AGENT_CWD`.
- Prefer small, explicit behavior over a generalized framework.
- Keep prompts, file contents, tokens, and credentials out of logs.
- Add focused tests for every behavior change and keep `task check` and `task test` passing.

## Open items

Findings from the September 2025 audit, grouped by theme and ordered by priority within each group.

### Robustness

#### SDB-036: Bound shutdown time

**Why:** `index.ts` waits on `application.stop()` with no deadline. A hung Slack disconnect or backend disposal prevents exit until launchd force-kills the process, delaying restarts.

**Scope:** Race `stop()` against a fixed deadline (for example 15 s), log which stage timed out, and exit nonzero.

**Done:** A test with a stalling dependency shows the process exits within the deadline.

### Code design

#### SDB-037: Extract shared CLI backend plumbing

**Why:** `codex-backend.ts` and `claude-backend.ts` still duplicate the sandboxed spawn with SIGTERM-then-SIGKILL cancellation, JSONL line handling with parse-error abort, executable discovery, prompt preparation with `<slack-file>` inlining, and the `reset`/`status` text. SDB-048 already extracted the Seatbelt profile (`seatbelt.ts`), the mapping store (`conversation-store.ts`), and stdin/stderr handling (`cli-process.ts`), so roughly 120 lines remain copied.

**Scope:** Introduce a `runSandboxedJsonl` helper that returns the exit result and streams parsed events to a per-backend callback. Keep event interpretation, arguments, and profile construction in each adapter. Move `<slack-file>` inlining to one function shared with `preparePiPrompt`. This resolves the "premature framework" caveat from SDB-027 now that two consumers exist.

**Done:** Adapter files shrink to argument construction and event translation; existing tests pass unchanged.

#### SDB-038: Replace backend-kind ternaries with a backend table

**Why:** `application.ts` and `doctor.ts` branch on `config.agentBackend` in five places with nested ternaries (factory, readiness check, session path, storage label, readiness label). Adding a backend requires editing all five.

**Scope:** Define one record per backend kind with `create`, `checkReady`, `sessionHome`, and `label`, and index it from both modules. This is a lookup table, not a plugin system.

**Done:** Adding a backend touches `config.ts` and one table entry; tests still cover each path.

#### SDB-039: Pass an inbound message object through the Slack handler

**Why:** `respondWithinLimit`, `respond`, and `respondAdmitted` thread eight positional parameters through three layers, and `respondAdmitted` is about 200 lines mixing status updates, file ingestion, command dispatch, delivery, reactions, and logging.

**Scope:** Introduce an `InboundSlackMessage` value (`requestId`, `channel`, `messageTs`, `threadTs`, `requesterId`, `prompt`, `files`) and split `respondAdmitted` into status-message management, execution, and delivery. Behavior must not change.

**Done:** `slack.test.ts` passes unchanged; no method exceeds roughly 60 lines.

#### SDB-041: Index Pi sessions instead of scanning the session directory

**Why:** `PiBackend.findSession` and `listConversations` call `SessionManager.list`, which reads every session file header in the directory. `hasConversation` runs on each unowned channel-thread message (with only a 60 s negative cache), and `!reset` archives grow the directory indefinitely, so lookup cost grows with history.

**Scope:** Persist a conversation-to-session-file mapping alongside the session directory (reuse the store from SDB-037), consult it first, and fall back to a scan only when the mapping is missing so existing deployments migrate on first run.

**Done:** Tests show lookup without a directory scan after the first run and successful migration from a directory with no mapping.

### Ergonomics and ease of use

#### SDB-042: Tell users when a request is dropped at capacity

**Why:** `respondWithinLimit` silently drops messages once eight Slack responses are active. The user sees no reaction or reply, which looks like the bot is down.

**Scope:** Post one deduplicated capacity reply per conversation (reuse `EventDeduplicator`) and add an `x` reaction. Consider whether the limit should be derived from queue limits rather than a separate constant.

**Done:** Test asserts a reply and reaction on the ninth concurrent request and no duplicate reply on the tenth.

#### SDB-043: Pass instructions as system prompts for Codex and Claude

**Why:** For CLI backends, `SLACK_AGENT_INSTRUCTIONS` is prepended to every user prompt. It is weaker than a system prompt, repeats in history on every turn, and inflates context and cost. Pi uses `appendSystemPrompt`.

**Scope:** Use `--append-system-prompt` for Claude and `-c developer_instructions=…` (or the equivalent supported config key) for Codex, verified against the installed CLI versions. Fall back to prompt prefixing only if the flag is unavailable and say so in doctor.

**Done:** Tests assert the instruction appears in the CLI arguments and not in stdin.

#### SDB-044: Show Slack prompts in attached terminal sessions

**Why:** The README example shows `user>` lines, but `started` and `queued` events carry no prompt, so an attached operator sees `agent> Working…` followed by a response with no idea what was asked.

**Scope:** Include a bounded prompt excerpt and requester kind (`slack` or `operator`, never a Slack user name) in `queued`/`started` events and print it as `user>` or `operator>` in the CLI. Add a `--socket` flag to `slack-desk`, and print the full conversation ID rather than a 28-character truncation.

**Done:** Local control test asserts the event shape; CLI has at least one test for frame parsing and formatting.

#### SDB-045: Consistent structured operator logging

**Why:** Only `agent_request_completed` is structured JSON; startup, denials, capacity drops, operator errors, and delivery failures use `console.log`/`console.warn` strings, and Bolt logs at INFO in its own format. `hum logs agent` output is therefore hard to filter.

**Scope:** Extend `log.ts` with a small set of event types (`startup`, `unauthorized`, `capacity_drop`, `operator_error`, `shutdown`) and route the existing ad-hoc calls through it. Keep prompts, tokens, and file contents out, as today.

**Done:** Every non-Bolt log line is a single JSON object with `event` and `timestamp`.

#### SDB-047: Run Seatbelt tests on a macOS CI runner

**Why:** The Codex and Claude sandbox tests are `skipIf(process.platform !== "darwin")` and CI runs on Ubuntu, so the security boundary that SDB-026/027 required to be proven by a real process is never verified in CI.

**Scope:** Add a `macos-latest` job that runs only the Seatbelt-tagged tests (they need `sandbox-exec` but not the Codex or Claude binaries for profile-only checks). Keep the Ubuntu job as the primary gate.

**Done:** CI shows the Seatbelt tests executing on macOS.

## Completed items

### SDB-032: Single source of truth for sensitive path patterns

**Resolution:** Added one data-only sensitive path table with small formatters for the Pi policy predicate, shared Seatbelt regex, and Claude permission globs. Claude now denies the previously omitted credential files, private-key formats, Docker credentials, and gcloud credentials. Environment variants, including templates, are consistently blocked by every backend.

**Verified:** Shared fixtures assert identical structured, Seatbelt-regex, and Claude-glob verdicts for every sensitive rule and representative near-matches. Focused workspace-policy, real Seatbelt, and Claude backend tests pass, along with `task check`.

### SDB-031: Warn when the workspace or environment exposes service credentials

**Resolution:** Doctor now rejects workspaces that contain or equal the user home, Pi agent directory, default credential directories, macOS keychains, configured session/backend homes, local socket directory, or service environment file. Pi, Seatbelt, and Claude permission checks also block `auth.json`, `.codex`, `.claude`, `.pi/agent`, and `Library/Keychains`. Codex and Claude readiness use the same explicit minimal environments as their runtime processes, including executable discovery and authentication checks.

**Verified:** Doctor tests cover every overlap class, including a credential directory used as the workspace root, and assert every CLI readiness child receives no `SLACK_*` variables. Focused policy and real Seatbelt tests cover the added sensitive paths; `task test` and `task check` pass.

### SDB-030: Isolate the Pi service from desktop user-level extensions

**Why:** Pi sessions previously shared trusted user-level extensions, skills, and prompt templates with desktop Pi, allowing a registered custom tool to bypass the built-in tool selection.

**Resolution:** Pi continues to read settings, models, and credentials from the normal agent directory, but `DefaultResourceLoader` now disables discovered extensions, skills, and prompt templates. The inline workspace policy enforces the mode-specific tool allowlist at every `tool_call`, including custom tools. Doctor reports the effective Pi agent directory and resource policy, and README documents that desktop authentication remains shared without loading desktop executable resources.

**Verified:** A fake user-level extension that registers a tool is not loaded while the inline policy remains active; focused tests cover unknown-tool blocking and doctor output. `task test` and `task check` pass.

### SDB-048: Fix external CLI backend sandbox, auth, and robustness defects

**Why:** Neither CLI backend could execute a single request. Both generated Seatbelt profiles denied path metadata outside their allowlists, and `codex` and `claude` both canonicalize their own home, executable, and workspace during startup, so every run failed before reaching the model. Existing tests passed because they exercised the profiles with `/bin/sh` rather than the real binaries. Codex additionally selected a `keyring` credential store that reports "Not logged in", readiness used `sandbox-exec -p` (which truncates long profiles) so it never tested the real boundary, Claude's stderr was discarded, and a corrupt mapping store threw from the backend constructor and would restart-loop under launchd.

**Resolution:** Consolidated both near-duplicate profiles into `src/seatbelt.ts`, denying `file-read-data` instead of `file-read*` so metadata resolution still works, and granting Claude its fixed `/tmp/claude-<uid>` and `/tmp/cc-socks` runtime directories. Codex uses the default credential store and its own `HOME`, and stores state under Application Support like the other backends. Readiness now writes a profile file and launches the real executable. Added `src/cli-process.ts` for bounded stderr capture and stdin `EPIPE` handling, and `src/conversation-store.ts`, which quarantines an unreadable store and starts empty while doctor reports it. Untrusted agent output and operator prompts are escaped and split before posting to Slack. Replaced the dead `getPeerCredentials` probe (unimplemented in both Node and Bun) with the filesystem boundary it actually relies on, and bound the socket under a restrictive umask. Shared local protocol types now live in `src/local-protocol.ts`, guarding CLI frame parsing, and `slack-desk` accepts `--socket`.

**Verified:** `test/seatbelt.test.ts` starts the real `codex` and `claude` binaries under the generated profile and asserts the metadata/content split; both regression tests fail against the previous profile. Live runs confirmed a new and resumed thread for each backend, shell-escape attempts blocked (`auth.json`, out-of-workspace reads, writes, `.env`), Claude tool denials, and `slack-desk sessions` over a real socket. Closed **SDB-033** as obsolete: making the Codex profile allowlist-based "like Claude's" is the exact shape proven unable to launch either CLI.

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

- Default the socket below the user's application-support directory, create its parent and socket with owner-only permissions, and remove only a verified stale socket owned by this service. (Peer-credential rejection proved impossible: neither Node nor Bun exposes `SO_PEERCRED`/`getpeereid`, so owner-only directory and file modes are the boundary. See SDB-048.)
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
