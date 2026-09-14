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

## Later considerations

These may be useful later, but are not currently justified as separate implementation work:

- Slack App Home onboarding after `!help` proves insufficient.
- Interactive buttons for cancel/reset after command ergonomics are validated.
- Per-conversation worktrees if single-writer mode becomes a real throughput constraint.
- File upload for generated artifacts.
- Administrative session listing, deletion, and retention controls if more than one operator uses the service.
- Content-based secret detection in tool output (currently path-based only).
- Streaming partial responses to the status message for long-running turns.
