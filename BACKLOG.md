# SlackDeskBot backlog

This backlog captures the remaining safety, setup, developer-experience, and Slack usability gaps found after the initial hardening work. Items are ordered roughly by priority and dependency. Stable IDs should remain unchanged when tasks are refined or completed.

## Working principles

- Keep Slack transport independent from agent backend implementations.
- Preserve read-only mode as the default and do not add shell access.
- Do not broaden filesystem access beyond `SLACK_AGENT_CWD`.
- Prefer small, explicit behavior over a generalized framework.
- Keep prompts, file contents, tokens, and credentials out of logs.
- Add focused tests for every behavior change and keep `task check` and `task test` passing.

## BL-001 — Prevent concurrent writers in one checkout

**Priority:** P0
**Status:** Done

### Context

`PiBackend` enables `edit` and `write` in read-write mode, while `QueuedAgentBackend` permits multiple conversations to run concurrently. Every conversation targets the same `SLACK_AGENT_CWD`, so two Slack threads can edit the same files simultaneously or act from stale repository state.

Relevant code:

- `src/pi-backend.ts` — `toolsForMode` and session creation
- `src/agent.ts` — cross-conversation scheduling and concurrency limits
- `src/index.ts` — configuration wiring
- `src/config.ts` and `.env.example` — mode and concurrency configuration

### Recommended scope

Choose and enforce a single-writer policy for the current shared-checkout design. The simplest acceptable behavior is to limit active conversations to one when read-write mode is enabled, while retaining configured concurrency in read-only mode. If a different design is chosen, it must provide equivalent protection without silently losing edits.

Do not introduce per-conversation worktrees unless the simpler policy proves inadequate.

### Acceptance criteria

- Two conversations cannot execute write-capable agent runs concurrently against one workspace.
- Read-only mode retains cross-conversation concurrency.
- Startup behavior clearly reports the effective concurrency when it differs from configuration.
- Tests cover both modes and prove the scheduling behavior.
- README and `.env.example` explain the read-write concurrency constraint.

### Completion notes

Read-write mode now forces the effective cross-conversation concurrency to one while preserving the configured value in read-only mode. Startup reports when the configured value is overridden. Configuration and scheduling tests cover both modes; `task check` and `task test` pass.

---

## BL-002 — Protect sensitive files inside the workspace

**Priority:** P0
**Status:** Done

### Context

`workspacePolicy` prevents paths outside `SLACK_AGENT_CWD`, but all files inside the workspace remain readable. Common repository files such as `.env`, private keys, credential files, and generated secrets can therefore be returned to Slack by an allowlisted request. The dedicated-checkout warning in the README reduces risk but does not enforce it.

Relevant code:

- `src/workspace-policy.ts` — tool-call path enforcement
- `test/workspace-policy.test.ts` — existing policy coverage
- `README.md` — Security section

### Recommended scope

Add a narrow default deny policy for high-confidence sensitive paths and key formats. Apply it consistently to read and write-capable path tools. Keep the rules understandable and documented; do not attempt broad content classification or silently block ordinary source files.

Consider whether operators need a deliberate override. If added, it must be explicit, narrowly scoped, and safe by default.

### Acceptance criteria

- Default policy blocks access to documented sensitive path patterns inside the workspace.
- Existing workspace-boundary and symlink protections remain intact.
- Blocked access returns a concise explanation without revealing file contents.
- Tests cover relative paths, absolute paths, nested sensitive files, symlinks, and allowed near-matches.
- README documents the protection and its limits, including that model output can still disclose any readable source content.

### Completion notes

The workspace policy now blocks documented high-confidence environment, private-key, and credential paths for every path tool, including relative, absolute, nested, prospective, and symlink-aliased paths. Template and source-file near-matches remain readable. Tests cover the policy matrix, and the README documents that path rules cannot detect secrets in ordinary readable source or model output.

---

## BL-003 — Add discoverable in-Slack help and command handling

**Priority:** P1
**Status:** Done

### Context

Users must know the exact `!status`, `!reset`, and `!cancel` commands from the README. There is no in-Slack help, welcome path, or unknown-command response. A typo such as `!stats` is treated as an ordinary agent prompt.

Relevant code:

- `src/messages.ts` — command parsing
- `src/slack.ts` — command routing
- `src/agent.ts` — command types
- `README.md` — Behavior and command documentation

### Recommended scope

Add `!help` as a transport-level command that does not create an agent session or consume queue/rate-limit capacity. Return concise examples for DMs, channel mentions, attachments, cancellation, status, and reset. Inputs beginning with `!` that are not supported commands should return an unknown-command hint instead of reaching the model.

An App Home can be considered later; it is not required to close this item.

### Acceptance criteria

- `!help` works in DMs and mentioned channel messages without invoking the backend.
- Help explains all supported commands and the channel mention requirement.
- Unknown `!…` commands return a concise error pointing to `!help`.
- Ordinary prompts containing punctuation or embedded exclamation marks remain unaffected.
- Parser and Slack transport tests cover help, unknown commands, case handling, and whitespace.

### Completion notes

`!help` and unknown bang commands are now handled directly by the Slack transport before status reactions, file ingestion, session access, queue admission, or backend invocation. Help covers DMs, channel mentions, files, and every supported command. Parsing and transport tests cover case, whitespace, unknown commands, and ordinary punctuation.

---

## BL-004 — Add a setup and configuration doctor

**Priority:** P1
**Status:** Done

### Context

The documented setup path discovers configuration, Slack token, Pi authentication, workspace, and port failures only when `hum up` starts the service. Slack setup also requires several manual console steps with no verification command.

Relevant files:

- `src/config.ts` — configuration validation
- `src/slack.ts` — Slack authentication
- `src/index.ts` — startup path
- `.env.example`
- `slack-app-manifest.yaml`
- `Taskfile.dist.yaml`
- `README.md` — Slack setup and Local setup

### Recommended scope

Add a non-destructive `task doctor` command. Reuse production configuration parsing where possible, but present concise, actionable diagnostics rather than an uncaught stack trace. It should validate local prerequisites and configuration, run Slack `auth.test`, and verify Pi/model readiness to the extent supported without executing an agent prompt.

Do not print token values, instructions, file contents, or other secrets.

### Acceptance criteria

- `task doctor` checks required environment variables, token prefixes, workspace and session paths, health-port availability, Slack authentication, and local Pi/model authentication readiness where supported.
- Output uses clear pass/fail/warning results and ends with a nonzero exit status on blocking failures.
- Diagnostics identify the setting or setup action to fix without exposing secret values.
- The doctor does not start Socket Mode, create sessions, or mutate the target repository.
- Tests cover representative configuration and Slack authentication failures.
- README lists prerequisite installation, including Mise and Task bootstrap requirements, then uses the doctor as the final setup verification step.

### Completion notes

`task doctor` now performs non-destructive required-setting and token-format checks, production configuration parsing, workspace/session permission validation, health-port binding, Slack `auth.test`, and local Pi model/auth readiness checks. Diagnostics are sanitized, actionable, and return a nonzero status for blocking failures. Focused tests cover valid setup, missing and invalid configuration, occupied ports, Pi readiness, and Slack authentication failure.

---

## BL-005 — Return actionable expected-error messages

**Priority:** P1
**Status:** Done

### Context

Queue capacity, per-user limits, rate limits, runtime timeouts, and queue-wait expiry are expected operating states with distinct error classes. Slack currently presents every non-cancellation failure as `Agent request failed: <raw message>`, which reads like a crash and may expose backend details.

Relevant code:

- `src/agent.ts` — domain error classes
- `src/slack.ts` — error publication
- `test/agent.test.ts` and `test/slack.test.ts`

### Recommended scope

Map known domain errors to concise user-facing messages with a useful next action. Use a generic message plus request identifier for unexpected failures, while retaining detailed errors only in operator logs. Do not couple the queue/backend layer to Slack-specific formatting.

### Acceptance criteria

- Every known admission, rate, timeout, queue-wait, and cancellation outcome has distinct actionable Slack text.
- Unexpected backend exceptions do not expose raw exception messages to Slack.
- Operator logs retain enough sanitized context and a request ID to diagnose unexpected failures.
- Tests verify each error mapping and confirm sensitive exception text is not posted.
- README briefly documents limits and expected recovery behavior for users.

### Completion notes

Slack now maps each queue-admission, requester, rate, runtime-timeout, queue-wait, and cancellation outcome to distinct actionable text. Unexpected failures publish only a request ID and write sanitized request/error-type context to operator logs, never the raw exception. Transport tests cover every mapping, request correlation, and secret-bearing exception suppression.

---

## BL-006 — Support natural follow-ups in bot-owned channel threads

**Priority:** P1
**Status:** Needs design confirmation

### Context

Channel input is received only through `app_mention`, so users must mention the bot on every reply inside a conversation thread. A normal Slack conversational flow would require a mention to start a thread, then accept allowlisted human replies in that bot-owned thread without repeated mentions.

Relevant files:

- `slack-app-manifest.yaml` — subscribed events and scopes
- `src/slack.ts` — channel and DM event routing
- `src/messages.ts` — conversation IDs
- `src/event-deduplicator.ts` — duplicate suppression

### Design constraints

- Do not listen or respond to unrelated channel traffic.
- Establish ownership only from a valid, allowlisted app mention.
- Define restart behavior: persisted sessions alone may not prove that a thread is bot-owned unless ownership is also persisted or safely reconstructed.
- Continue filtering bot messages and duplicate Slack deliveries.
- Document any added Slack scopes and reinstall requirement.

### Acceptance criteria

- An allowlisted mention starts a channel-thread conversation.
- Subsequent allowlisted human replies in that owned thread work without another mention.
- Messages in unrelated threads and channel roots are ignored.
- Unauthorized users, bot messages, edits, and duplicate events cannot invoke the backend.
- Owned-thread behavior remains correct after service restart, or the documented fallback explicitly requires a new mention.
- Manifest, transport, deduplication, and restart tests cover the final design.

---

## BL-007 — Make Slack delivery bounded and observable

**Priority:** P1
**Status:** Done
**Depends on:** BL-005

### Context

The transport splits messages at Slack-safe boundaries, but total output is unbounded. A large response can create many messages, hit Slack rate limits, or fail partway through. Status/reaction failures are best-effort and completion logs do not distinguish successful agent execution from successful Slack delivery.

Relevant code:

- `src/messages.ts` — message splitting
- `src/slack.ts` — status, result, reaction, and error publication
- `src/log.ts` — request outcome schema
- `test/messages.test.ts` and `test/slack.test.ts`

### Recommended scope

Set a documented maximum published response size or chunk count, with a clear truncation marker. Track execution outcome separately from delivery outcome. Handle partial publication deterministically and preserve a request ID for operator correlation. Rely on Slack SDK retry behavior where appropriate rather than building a generalized retry framework.

### Acceptance criteria

- One agent result can publish at most a documented number of characters or Slack messages.
- Truncated output clearly says that it was truncated and how the user can request a narrower response.
- Logs distinguish agent success/failure from Slack delivery success/partial/failure.
- A failed status update still attempts final delivery; a failed final delivery is logged with request context.
- Error handling cannot recursively attempt to publish failures indefinitely.
- Tests cover update fallback, partial multi-chunk failure, total limits, and delivery logging.

### Completion notes

Agent responses now publish at most three Slack-safe messages with a visible truncation marker. Final publication tracks success, partial delivery, and failure independently from agent execution, falls back when status updates fail, logs sanitized request context, and never recursively publishes delivery errors. Focused tests cover truncation, fallback, partial and failed publication, and delivery telemetry.

---

## BL-008 — Improve queue and long-running request feedback

**Priority:** P2
**Status:** Done
**Depends on:** BL-005

### Context

Every admitted request immediately receives `Working…`, even if it is queued behind another request or waiting for a global concurrency slot. Long runs provide no elapsed-time, queue-state, or timeout indication. Tool count is collected only for final logs.

Relevant code:

- `src/agent.ts` — queue state and scheduling
- `src/slack.ts` — request status message
- `src/log.ts` — completion metadata

### Recommended scope

Expose a small backend-neutral lifecycle observer such as queued, started, and tool-use count. Use it to distinguish `Queued…` from `Working…` and optionally update long-running status at a conservative interval. Avoid frequent Slack API writes and do not expose model chain-of-thought or tool arguments.

### Acceptance criteria

- Queued requests are visibly distinguishable from actively running requests.
- Status transitions to working when execution begins.
- Long-running feedback is rate-limited and contains only safe aggregate information.
- Cancellation and timeout leave one unambiguous terminal status.
- Lifecycle behavior is backend-neutral and tested for immediate and queued requests.

### Completion notes

The backend-neutral run observer now reports queue admission and execution start. Slack displays queued and working states, updates long-running work no more than every 30 seconds with elapsed time and aggregate tool use, and publishes one terminal result for cancellation or timeout. Queue and transport tests cover immediate starts, queued transitions, queue expiry, long-running feedback, and terminal timeout behavior.

---

## BL-009 — Report service readiness and useful operational state

**Priority:** P2
**Status:** Done
**Depends on:** BL-007

### Context

The health endpoint reports HTTP-process liveness and uptime. It starts after initial Slack authentication, but does not reflect later Socket Mode disconnection, repeated Slack delivery failures, backend disposal, or queue saturation. Structured logs contain only completed request summaries.

Relevant code:

- `src/health.ts` and `src/healthcheck.ts`
- `src/index.ts`
- `src/slack.ts`
- `src/agent.ts`
- `src/log.ts`
- `hum.yaml`

### Recommended scope

Separate liveness from readiness. Track a small sanitized snapshot: Slack connection state, service start time, backend availability, queue counts, and last successful Slack operation. Keep detailed state local; do not expose user IDs, conversation IDs, paths, tokens, prompts, or file data from HTTP health endpoints.

### Acceptance criteria

- Liveness remains a cheap indication that the process event loop is serving requests.
- Readiness becomes unhealthy or degraded when Slack/backend service is unavailable after startup.
- Hum checks the endpoint appropriate for determining whether requests can be served.
- Queue saturation and last-success timestamps are available in sanitized operator diagnostics or structured logs.
- Connection transitions and health serialization have focused tests.
- README defines what each health state means and the first troubleshooting command to run.

### Completion notes

`/healthz` remains a cheap process liveness check while `/readyz` reports sanitized Slack connection, backend, queue, and delivery state. Hum now checks readiness; three consecutive result-delivery failures mark readiness degraded, while best-effort reaction failures and queue load remain non-fatal. Focused tests cover health serialization, queue snapshots, connection transitions, and delivery degradation.

---

## BL-010 — Provide one reproducible installation and deployment path

**Priority:** P2
**Status:** Done
**Depends on:** BL-004, BL-009

### Context

The current operating model is `hum up` on a machine that remains awake. There is no complete fresh-machine prerequisite list, service-at-login recipe, durable session/secret guidance, backup policy, log retention guidance, or upgrade procedure. Tool versions are mostly `latest`, so setup and CI can change independently of application commits.

Relevant files:

- `README.md`
- `mise.toml`
- `package.json` and `bun.lock`
- `hum.yaml`
- `.github/workflows/ci.yaml`
- `.taskfiles/setup.yaml`

### Recommended scope

Define one supported desktop deployment, preferably using Hum plus the platform service manager appropriate to the intended environment. Pin project tool versions and document an intentional upgrade workflow. Keep alternative deployment systems out of scope until requested.

### Acceptance criteria

- README starts with explicit OS/runtime prerequisites and a working bootstrap sequence from a clean machine.
- One documented deployment starts automatically, restarts on failure, uses durable session storage, and keeps secrets outside version control.
- Logs, shutdown, restart, backup, restore, and upgrade procedures are documented and testable.
- Bun, TypeScript, formatting/check tools, Task, and Hum versions are pinned or otherwise reproducibly constrained.
- CI uses the same pinned toolchain as local development.
- A fresh-install smoke checklist ends with `task doctor`, a healthy service, and a successful Slack DM.

### Completion notes

The supported deployment is now a macOS LaunchAgent that loads an external mode-`0600` environment file and runs the Hum-supervised service at login with durable external session storage. Project tools and development dependencies are pinned, CI consumes the same Mise and Bun locks, and the README documents clean bootstrap, operation, bounded logs, backup, restore, upgrade, rollback, and an end-to-end smoke checklist.

---

## BL-011 — Add startup, manifest, and configuration integration checks

**Priority:** P2
**Status:** Done
**Depends on:** BL-004

### Context

Unit coverage is strong, but CI does not exercise the assembled startup path, Slack authentication failure handling, Hum readiness contract, or manifest/configuration syntax. Drift between the manifest, README, `.env.example`, and runtime requirements can therefore reach users.

Relevant files:

- `.github/workflows/ci.yaml`
- `src/index.ts`
- `src/config.ts`
- `src/health.ts` and `src/healthcheck.ts`
- `slack-app-manifest.yaml`
- `hum.yaml`
- `.env.example`

### Recommended scope

Add focused integration/smoke checks with mocked external Slack calls. Validate configuration documents in CI using their schemas or a small purpose-built check. Do not require real Slack credentials in pull-request CI.

### Acceptance criteria

- CI validates the Slack manifest, Hum configuration, and example environment contract.
- A smoke test assembles the production startup components with mocked Slack authentication and verifies readiness and graceful shutdown.
- Failure tests cover invalid Slack authentication and occupied health port with actionable process-level diagnostics.
- Tests do not create persistent Pi sessions, contact Slack, or require developer credentials.

### Completion notes

Startup composition is injectable and starts health before contacting Slack, producing sanitized actionable diagnostics for invalid Slack authentication and occupied health ports. Integration tests verify readiness, idempotent graceful shutdown, and both failure paths without Slack, credentials, or Pi sessions. CI's check task now validates the Slack manifest, Hum readiness/restart contract, LaunchAgent definition, and example environment contract.

---

## Later considerations

These may be useful after the prioritized items, but are not currently justified as separate implementation work:

- Slack App Home onboarding after `!help` proves insufficient.
- Interactive buttons for cancel/reset after command ergonomics are validated.
- Per-conversation worktrees if single-writer mode becomes a real throughput constraint.
- File upload for generated artifacts.
- Administrative session listing, deletion, and retention controls if more than one operator uses the service.
