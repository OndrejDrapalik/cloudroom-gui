Loops run agents and scripts on a schedule, once or on a repeat, locally or in the cloud. Then Review shows what they did, so you can check it in one place.

## What you get

- A Loops panel in the sidebar. Create, edit, pause, resume, and run loops there. Each loop shows its run history.
- Review. One timeline of what your loops did on their own in the last 7 days, newest first, as a List or a Board. A thread the agent archived is Done; one it left open Needs you. Click "Looks good" to clear an item.
- Two schedule types. Use a cron expression with a timezone for repeating work. Use a date, or a delay such as `2h`, for one-shot work.
- Agent mode. Pick the provider, model, reasoning level, and permission mode. Start a new thread, re-prompt an existing thread, or create a new worktree for each run.
- Script mode. Store a bash, sh, node, or python3 script. Each run records stdout, stderr, and the exit code. A script that prints nothing is recorded as a silent tick.

## For agents

Agents get the `automations` skill and the `room-cli loop` command (`room-cli automation` is the same): `create`, `list`, `show`, `update`, `pause`, `resume`, `run`, `runs`, `review`, and `delete`. All commands accept `--json`. Threads that a loop starts cannot create loops.

Scripts run on the machine that hosts the Cloudroom server. Agent runs use the providers you already have installed.
