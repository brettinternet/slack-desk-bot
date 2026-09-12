# SlackDeskBot backlog

This backlog captures remaining safety, setup, developer-experience, and Slack usability work. Items are ordered roughly by priority and dependency. Stable IDs should remain unchanged when tasks are refined or completed.

## Working principles

- Keep Slack transport independent from agent backend implementations.
- Preserve read-only mode as the default and do not add shell access.
- Do not broaden filesystem access beyond `SLACK_AGENT_CWD`.
- Prefer small, explicit behavior over a generalized framework.
- Keep prompts, file contents, tokens, and credentials out of logs.
- Add focused tests for every behavior change and keep `task check` and `task test` passing.

## Active items

### SDB-024: Add `!cancel` for another user's request (operator override)

**Why:** `cancelActive` only cancels the requester's own job. In a shared channel thread another allowlisted user cannot stop a runaway or mistaken request; the operator must restart the service.

**Scope:**

- Add an optional `SLACK_OPERATOR_USER_IDS` subset of the allowlist whose `!cancel` cancels any active job in the conversation.
- Report who cancelled in the reply and log.

**Done:** Queue tests for owner vs. operator vs. ordinary user cancellation; README updated.

## Later considerations

These may be useful later, but are not currently justified as separate implementation work:

- Slack App Home onboarding after `!help` proves insufficient.
- Interactive buttons for cancel/reset after command ergonomics are validated.
- Per-conversation worktrees if single-writer mode becomes a real throughput constraint.
- File upload for generated artifacts.
- Administrative session listing, deletion, and retention controls if more than one operator uses the service.
- Content-based secret detection in tool output (currently path-based only).
- Streaming partial responses to the status message for long-running turns.
