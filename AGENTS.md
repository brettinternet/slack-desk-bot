@AGENTS.local.md

# Agents

## Tooling

- Install the project toolchain and hooks with `task init`.
- Use project `task` targets instead of reconstructing commands.
- Use `mise exec <tool> -- <command>` when a project-managed tool is not already on `PATH`.
- Use the smallest verification loop that covers the change.
- Before committing, stage intended files and run `task check:staged`.
- Run `task check` for cross-project changes, before a release, or when explicitly requested.

## Git and GitHub

- Create agent branches as worktrees under `.worktrees/`.
- Use `gh` for GitHub operations.
- Do not push or open a pull request without explicit instruction.

## Scope

- Keep the Slack transport independent from agent backend implementations.
- Do not broaden filesystem or shell permissions without an explicit requirement.
