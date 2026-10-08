# SlackDeskBot backlog

This backlog captures remaining safety, setup, developer-experience, and Slack usability work. Items are ordered roughly by priority and dependency. Stable IDs should remain unchanged when tasks are refined or completed.

## Working principles

- Keep Slack transport independent from agent backend implementations.
- Preserve read-only mode as the default; command execution must be explicit, independently confined, and unable to inherit service credentials.
- Do not broaden filesystem access beyond `SLACK_AGENT_CWD`.
- Prefer small, explicit behavior over a generalized framework.
- Keep prompts, file contents, tokens, and credentials out of logs.
- Add focused tests for every behavior change and keep `task check` and `task test` passing.

## Open items

### SDB-050: Run approved project tasks in a command sandbox

**Status:** Draft

**Depends on:** SDB-049 brokered inspection commands.

**Why:** Fixed Git and host-inspection operations answer questions but cannot run the repository's own checks. The agent should be able to validate work through operator-approved project entrypoints without receiving a general shell, arbitrary executable selection, or access to service credentials.

**Scope:**

- Add an explicit configuration allowlist of project task names, initially supporting exact Task targets such as `check`, `test`, and `lint`; do not accept free-form arguments, environment assignments, shell operators, or executable paths.
- Execute each target in a separate macOS Seatbelt child process with no inherited service environment, no backend/session home access, no network by default, a dedicated temporary `HOME`/`TMPDIR`, bounded output, a deadline, and cancellation that terminates the process tree.
- In read-only mode, deny workspace writes and document that tasks requiring build artifacts or caches may fail. In read-write mode, permit non-sensitive workspace writes while continuing to deny `.git`, credentials, keys, and out-of-workspace paths.
- Treat project task definitions and everything they launch as untrusted code. The process sandbox, not command spelling or prompt instructions, is the security boundary.
- Start with Pi. Add backend parity only where the same effective policy can be independently enforced; unsupported combinations must fail readiness rather than silently broaden access.

**Acceptance:**

- Configuration and doctor output show the effective approved targets and reject malformed, duplicate, or unsupported entries.
- Integration tests demonstrate an approved target succeeding and an unapproved target being rejected before process creation.
- macOS security tests prove that task code cannot read service/backend credentials, sensitive workspace paths, or outside files; cannot use the network; and cannot write the workspace in read-only mode.
- Timeout, cancellation, output-flood, symlink, subprocess, and attempted environment-leak tests pass, and logs contain no command output or secrets.
- README explains the trust model, read-only limitations, and how to enable the smallest useful target set.

### SDB-051: Offer an explicitly enabled arbitrary shell in stronger isolation

**Status:** Draft

**Depends on:** SDB-050, including its command runner, lifecycle limits, credential isolation, and macOS security tests.

**Why:** Some diagnosis and maintenance cannot be anticipated as fixed operations or Task targets. Arbitrary shell access is useful, but Seatbelt around the long-lived backend process is insufficient because that process must read model credentials and currently has broad network, process, sysctl, and Mach permissions.

**Scope:**

- Add a separate, opt-in command mode for arbitrary shell execution. Keep it off by default and distinct from `SLACK_AGENT_MODE`; enabling file edits must not implicitly enable a shell.
- Launch every shell request through a short-lived broker-owned sandbox that cannot read any Pi, Codex, Claude, SlackDeskBot, shell-profile, keychain, SSH, cloud, package-manager, or service-environment credentials.
- Use a fixed shell executable with a minimal environment and working directory. Deny network and host-control interfaces by default; enumerate only the Mach services, sysctls, devices, executable roots, and temporary paths proven necessary.
- Allow `.git` data reads needed for inspection but deny `.git` writes. Continue blocking sensitive workspace paths. Read-write mode may permit other workspace writes with the existing single-writer guarantee and an explicit warning that arbitrary commands can delete or corrupt workspace files.
- Bound wall time, captured output, subprocess count where enforceable, open files, CPU, memory, and temporary storage. Cancellation and service shutdown must kill the complete process tree.
- Determine whether operator-only authorization or per-request Slack approval is required before implementation. Do not rely on prompt instructions or a denylist of dangerous command text.
- Evaluate a disposable VM boundary using Apple's Virtualization framework or Lima. If Seatbelt cannot reliably constrain IPC, denial-of-service, and host side effects, ship the VM design instead of claiming host-shell safety.

**Acceptance:**

- A written threat model identifies protected assets, allowed effects, residual host-kernel/availability risks, and the reason the selected isolation boundary is sufficient.
- Adversarial macOS tests cover credential reads, `.git` writes, out-of-workspace paths, symlinks, network access, process inspection/signaling, Mach/launchd/AppleScript host control, fork/output bombs, timeouts, and cancellation.
- The model can run normal pipelines and local developer commands within the documented boundary, while every tested escape and host-control attempt fails independently of backend-native policy.
- Doctor fails closed when the required sandbox is unavailable. README labels arbitrary shell as high trust and documents recovery expectations for workspace damage.

### SDB-052: Reject abusive, repetitive, and unjustifiably expensive requests

**Status:** Draft

**Why:** An allowed Slack user can still monopolize capacity by nagging after a refusal, repeating near-identical prompts, posting obvious spam, or asking the agent to perform excessive tool calls or open-ended deep research without a legitimate operator-approved need. Queue limits reduce concurrency but do not prevent expensive individual turns or repeated abuse.

**Scope:**

- Add a transport-level abuse gate before attachment downloads, backend admission, or session invocation. Keep it independent of backend implementations.
- Detect exact and conservatively normalized duplicate prompts per user and conversation. Escalate repeated attempts from a clear refusal to a cooldown, then silently drop or react with `x` so rejection traffic cannot itself be amplified.
- Reject narrowly defined obvious spam, including empty/noise payloads and excessive links, mentions, repetition, or requested fan-out. Favor deterministic, explainable rules over broad semantic moderation or an extra model call.
- Treat requests for exhaustive, open-ended, or unusually deep research, large source counts, repeated searching, or excessive tool use as high-budget work. Reject high-budget requests from ordinary allowed users before backend invocation; permit them only for configured operators or another explicit operator authorization mechanism.
- Enforce per-turn tool-call, research-call, wall-time, and output budgets after admission. Abort a turn that exceeds its budget rather than relying on prompt instructions or backend cooperation. Use stricter defaults for ordinary users and bounded elevated limits for operators.
- Add temporary cooldowns and operator-managed permanent blocks keyed by Slack user ID. Blocked users must be rejected before file ingestion and must not consume backend, queue, or session resources.
- Keep `!cancel` available during cooldowns and blocks. Keep `!status` available unless doing so creates an amplification path; operator actions are exempt from ordinary-user restrictions.
- Deduplicate user-facing rejection messages by user, conversation, and reason. Record only bounded metadata and reason codes such as `duplicate`, `spam`, `high_budget`, `tool_budget`, `cooldown`, and `blocked`; never log prompt or file contents.
- Document the limits and operator controls without publishing thresholds or matching details that would make evasion easier.

**Acceptance:**

- Tests prove blocked, cooldown, duplicate, obvious-spam, and unauthorized high-budget requests are rejected before attachment download, backend admission, session creation, or tool execution.
- Tests cover repeated refusal evasion, prompt normalization boundaries, excessive link/mention/repetition payloads, explicit requests for large tool or source fan-out, and false-positive boundaries for normal detailed engineering questions.
- Per-turn budget tests prove tool-heavy and research-heavy runs are cancelled at the configured limit across every supported backend, with queue and requester accounting released correctly.
- Repeated rejected messages produce at most one Slack reply per dedupe window; subsequent attempts use no backend capacity and bounded Slack API traffic.
- Operators can inspect reason-coded abuse events, apply and remove temporary or permanent user blocks, and explicitly authorize bounded high-budget work.
- README documents ordinary versus elevated request budgets, cooldown/block behavior, operator authorization, and the fact that “seriousness” is established by authorization rather than subjective model classification.

## Later considerations

These may be useful later, but are not currently justified as separate implementation work:

- Slack App Home onboarding after `!help` proves insufficient.
- Interactive buttons for cancel/reset after command ergonomics are validated.
- Per-conversation worktrees if single-writer mode becomes a real throughput constraint.
- File upload for generated artifacts.
- Administrative session listing, deletion, and retention controls if more than one operator uses the service.
- Content-based secret detection in tool output (currently path-based only).
- Streaming partial responses to the status message for long-running turns.
