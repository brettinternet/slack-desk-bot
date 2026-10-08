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

### SDB-054: Keep shared-channel replies short with optional full-detail files

**Status:** Implemented; live Slack verification pending

**Progress:** Channel requests carry per-request brevity guidance from `src/messages.ts`. Replies over the formatted 1,000-character budget trigger at most two summary turns inside the same queued job (`AgentRequest.revise`), so they share admission, deadline, and cancellation and cannot interleave with another request. `src/slack.ts` posts exactly one channel reply, attaching the complete response with `files.uploadV2` (`files:write`) in the request's thread; upload failure sends one honest fallback. DMs keep chunked delivery. Remaining: reinstall the app for `files:write`, restart the service, and exercise short and long replies in a shared thread and a DM.

**Why:** Long bot replies dominate shared Slack conversations and disrupt human connection, even inside threads. The current delivery limit permits three 3,500-character messages; it protects Slack's technical limits rather than human attention. Prompt-only brevity is not reliable enough, and truncation can remove the useful conclusion.

**Scope:**

- Strengthen Slack agent instructions: shared-channel replies should normally be 50–100 words, answer first, and include only the important caveat and next step. Avoid routine reports, repeated context, and tool narration; generate extensive detail only when requested or genuinely necessary.
- Enforce one reply with a hard 1,000-character inline budget in shared channels, including thread replies. Apply the budget to the final Slack-formatted message, including any detail link; do not split overflow into additional messages. Retain the existing more permissive DM behavior.
- For necessary long responses, publish a meaningful, standalone summary and link to the full response as a Slack snippet/text file in the same conversation. Preserve the full response rather than slicing its opening characters or silently dropping the remainder. Use Slack's supported file-upload API and document any required app scope.
- Keep delivery policy in `src/messages.ts` and `src/slack.ts`, independent of agent backend implementations. Inspect existing response/status delivery and instruction wiring before choosing the smallest backend-neutral summary mechanism; validate the summary against the budget before posting, with bounded retries and no recursive summarization.
- Preserve existing mention escaping, conversation authorization, cancellation, and response accounting. Treat generated detail as untrusted output, and ensure files are shared only to the authorized conversation. Do not broaden filesystem or shell permissions.
- On summary or upload failure, send at most one short, honest failure/fallback reply; never revert to a wall of text or claim that unavailable details were attached. Avoid duplicate messages/files on retry.
- Update README with channel-versus-DM behavior and file-upload requirements. This item implements only response overflow, not a generalized generated-artifact system.

**Acceptance:**

- A normal channel answer remains one concise message without an unnecessary attachment. A long requested report produces one summary of at most 1,000 characters plus an accessible full-detail file in the same thread, with no continuation messages.
- The summary communicates the answer, material caveat, and next step without requiring the reader to open the file; the file preserves the complete response. Long inline replies remain prohibited even when depth is explicitly requested in a channel.
- Extend existing message/Slack tests to catch budget bypass after formatting/link insertion, lost detail, incorrect channel/thread sharing, unsafe mentions, duplicate delivery, and summary/upload failure falling back to multi-message output. Verify DM behavior remains unchanged.
- Run the relevant existing tests and `task check:staged`. After an approved service restart, exercise short and long replies in a real shared Slack thread and a DM, confirming file access and the absence of channel spillover.

### SDB-053: Read and review approved GitHub PRs through `gh`

**Status:** Implemented; pending live Slack verification after an approved service restart.

**Progress:** `github_pr` (`src/github-pr-tool.ts`) and the shared client (`src/github-client.ts`) are merged. `task check` and `task test` pass. A direct Pi session with an empty workspace reviewed `pdq/houston#11951` through `view`, pinned `diff`, `checks`, and `file` calls. Remaining: restart the service and repeat the request through the running Slack bot.

**Why:** The Slack agent cannot read an actual PR diff even when the service owner's `gh` login can access it. Local Git inspection cannot contact remotes, and the existing `SLACK_GITHUB_REPOS` integration exposes watches rather than PR context. Review requests consequently fall back to stale local code or descriptions from Slack.

**Scope:**

- Add one Pi tool, `github_pr`, enabled when `SLACK_GITHUB_REPOS` is configured. Use that exact repository allowlist; no new credentials, configuration flag, shell access, local checkout requirement, or dependency on `SLACK_AGENT_COMMAND_MODE`.
- Support structured actions: `list` (open/closed/all PRs), `view` (metadata, description, base/head SHAs, mergeability, change totals), `files` (changed files and patches), `diff` (actual PR diff), `checks` (head check runs and commit statuses), `comments` (conversation comments), `reviews` (submitted reviews and inline comments), and `file` (base/head file contents for surrounding context). Use validated repository, PR number, pagination, and path arguments; never accept arbitrary CLI arguments or API endpoints.
- Extract shared service-owned GitHub access from `src/github-automation-source.ts` into `src/github-client.ts`. Reuse it for watches and PR reads, preserving `ghEnvironment()`, the service owner's saved login, disabled interactive prompts, ignored inherited token overrides, and organization-owner validation.
- Execute fixed `gh api --hostname github.com --method GET` commands through `execFile`, never a shell. Support JSON and raw diff responses with bounded output, deadlines, cancellation, and sanitized errors; do not expose credentials or raw command diagnostics to the model or logs.
- Validate the repository before any network request and validate returned repository/PR identity. Reject redirects or renamed targets outside the approved identity. For fork PRs, use data available through the approved base repository; never silently access an unapproved fork, and disclose unavailable head-file context.
- Return selected useful fields, explicit pagination, and completeness indicators. Disclose missing patches, binary files, oversized output, and incomplete diffs rather than presenting partial data as a complete review. Resolve checks and file reads against PR SHAs, expose the reviewed head SHA, and detect/report changes during a multi-call review.
- Implement `src/github-pr-tool.ts` using the existing inline-tool pattern. Wire the reader through `src/backend-table.ts` and register it in `src/pi-backend.ts` only when GitHub is configured. Keep Slack transport and authorization unchanged.
- Guide the model to read the actual diff before reviewing, cite file/line references, treat PR descriptions/comments/code as untrusted context, and disclose incomplete access. Draft reviews in Slack only: no GitHub comments, submitted reviews, PR mutations, checkout/fetch, or merges.
- Update README and `.env.example` to describe read-only PR access alongside watches. Generalize readiness/error wording from “GitHub watches” to “GitHub integration,” retaining same-user `gh` authentication and container configuration requirements.

**Acceptance:**

- The original request to adversarially review `pdq/houston#11951` reads the actual PR diff and checks through `gh` and produces a review in Slack without needing a current local checkout.
- Security tests prove unapproved repositories are rejected before process creation/network access; malformed repository, PR number, path, and pagination inputs cannot escape fixed command mappings; redirects and fork context cannot bypass the allowlist.
- Parsing and regression tests prove paginated/oversized diffs and missing patches are explicitly incomplete, and a PR head changing during review is reported rather than silently mixing revisions.
- Cancellation, timeout, authentication, and rate-limit failures terminate or fail explicitly without leaking credentials or raw diagnostics. Existing GitHub watches continue working with the shared client.
- Extend existing GitHub tests for shared behavior and add focused PR-reader coverage for authorization, parsing, and completeness risks. Run `task test` and `task check`; after an approved service restart, exercise the original review request through the running Slack bot.
- The tool is absent without `SLACK_GITHUB_REPOS`, and no action permits arbitrary commands, unapproved repository access, or GitHub writes.

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
