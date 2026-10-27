# Delegation Guide

These are general recommendations for a Delegating Agent. Explicit user
instructions and permissions always take priority.

1. Handle small, immediately verifiable edits directly. Create a task only when
   work is multi-step and can be reviewed independently.
2. For several articles, web pages, or repositories that only need reading and
   synthesis, use `research_start` instead of several independent `create`
   calls. Each shard receives a separate scratch workspace; use `research_wait`
   and collect the aggregate report once.
3. In `create`, send the objective, workspace, necessary context, constraints,
   and acceptance criteria. Do not copy an entire chat or duplicate source.
4. Let the Worker Agent implement and self-test. The Delegating Agent should use
   the server-side `wait` call, read bounded summaries first, and avoid editing
   the same workspace concurrently.
5. Once the task reaches `awaiting_review`, read `--view result` and run
   independent checks. If a check fails, send concrete evidence back to the same
   live session with `rework`.
6. Use task lists to discover work, not to load all history into context. Read
   `history` or `usage` pages only for diagnosis.
7. Request counts and cost are metrics by default, not blockers. Inspect
   `usage.limitState`: `disabled` means no policy is enabled; if a deployer opts
   in, `warning` allows more work and `blocked` refuses only later rework.
8. The Provider tool loop is unlimited by default. If a deployer explicitly sets
   `maxToolRequests`, reaching it returns a typed failure; do not retry it as an
   empty response.
9. Record checks actually performed, then call `accept` and `close`. Deleting
   task records requires a separate local human grant.

Reduced response size means less transport payload, not necessarily fewer model
tokens or lower cost. Compare requests, estimated cost, rework count, and total
latency when evaluating delegation.
