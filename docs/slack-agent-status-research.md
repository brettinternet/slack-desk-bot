# Slack thread activity indicator

## Decision

Today the bot posts nothing until the answer is ready. `createRequestStatus()` only counts tool use, and `deliverRequest()` posts after execution (`src/slack.ts`). Commit `90a010f` removed the old "Queued…/Working…" reply.

Ordinary bots get no typing signal from Slack. The native option is an agent-session status:

```ts
agents.sessions.setStatus({ channel_id, thread_ts: rootTs, status: "processing" }); // shows "Working…"
agents.sessions.setStatus({ channel_id, thread_ts: rootTs, status: "active" }); // clears it
```

This shows Slack's "Working…" state. There's no typing animation and no custom text, and the app must be declared an agent. [Sessions][sessions] · [Set status][set-status]

| Option                      | Cost                                     | Gets you             |
| --------------------------- | ---------------------------------------- | -------------------- |
| Agent session (pilot first) | New manifest view, scope, and UI changes | Native "Working…"    |
| Temporary `:eyes:` reaction | None (`reactions:write` already granted) | Acknowledgement only |
| Status reply                | An extra message                         | Text progress        |

**Recommendation:** pilot agent sessions on a separate app. Use `:eyes:` if an acknowledgement is enough.

## Impact of enabling agents

| Area          | Impact                                                                                                                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Manifest      | Add `agent_view` (requires `agent_description`) and `assistant:write`. `setStatus` uses `chat:write` and needs channel membership. [Manifest][manifest]                                                |
| Discovery     | The app appears in agent navigation, so it's more visible than `SLACK_ALLOWED_USER_IDS` implies. [Announcement][announcement] · [Display][display]                                                     |
| Channels      | Every channel member sees the session status and title and can edit the title. Keep prompts out of titles.                                                                                             |
| DMs           | Status needs a root `thread_ts`, but the bot replies to DMs unthreaded. Start with channel threads only. [Developing][developing]                                                                      |
| State         | Replying doesn't clear `processing`. Set `active` on every exit path; otherwise it times out after 1h. Concurrent turns in a thread must not clear each other. Status failures must not block answers. |
| Stop button   | Only appears with an `agent_session_stopped` subscription, which then requires real cancellation. Optional.                                                                                            |
| Guests        | Guests can't use agents. Test this if allowlisted guests rely on the bot. [Work with agents][work-with-agents]                                                                                         |
| Reversibility | `assistant_view → agent_view` is irreversible. Removing `agent_view` alone is unverified, so test on a separate app. [Migration][migration]                                                            |
| Cost          | No separate charge found, but plan availability is unverified.                                                                                                                                         |

## Pilot (not implemented)

1. Configure a separate app as an agent and keep the Messages tab and events. Check scopes, approval, and navigation.
2. In channel threads, set `processing` on admission and `active` in cleanup. Treat both calls as best-effort.
3. Test fast and slow runs, backend and delivery failures, cancellation, two queued turns, restarts, unauthorized users, and DMs. Nothing should stay `processing`.
4. Decide separately on DM threads and the stop event, then update the production app and document reauthorization.

[sessions]: https://docs.slack.dev/ai/agent-sessions/
[set-status]: https://docs.slack.dev/reference/methods/agents.sessions.setStatus/
[manifest]: https://docs.slack.dev/reference/app-manifest/
[announcement]: https://docs.slack.dev/changelog/2026/06/30/agent-messages-tab/
[display]: https://slack.com/help/articles/33077521383059-Display-AI-agents-and-assistants-in-Slack
[developing]: https://docs.slack.dev/ai/developing-agents/
[migration]: https://docs.slack.dev/ai/migrating-to-agent-messaging/
[work-with-agents]: https://slack.com/help/articles/33076000248851-Work-with-AI-agents-in-Slack
