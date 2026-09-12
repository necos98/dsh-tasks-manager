# dsh-tasks-manager

Stupid-synchronous task queue for DSH: one active task per repo, FIFO promotion, manual close.

- Intake files drafts via `enqueue_task(type, title, spec)` — one draft per
  requested task, so "queue task A and task B" files two drafts; the user
  approves (`approve_task`) or discards each.
- The queue promotes the oldest `queued` task to `active` when the slot frees;
  EVERY promotion auto-spawns its worker chat (`taskqueue-worker` preset,
  English prompt) bound via `worker_session` — approving a task, closing
  one from the panel, AND the worker finishing its own task via
  `finish_task` all open the next chat, so an active task never sits in
  limbo with no session. A spawn failure never rolls the promotion back:
  the task stays active and the error rides the result as `spawn` (panel
  card line / tool render suffix), with the lazy `get_my_task` bind as
  manual fallback.
  `close_task(id, outcome)` with `done|cancelled|failed` frees the slot.
  Every number a tool or the panel accepts is the task's VISIBLE number
  (`#N` = this workspace's `seq`, the one printed by `list_tasks`, the panel
  card and the worker chat title); the internal row id is a fallback and
  resolves only when no task of that workspace carries the number.
- The worker reads its task with `get_my_task` (spawn already binds the
  session), works on `task/<seq>-<slug>` (per-workspace visible number) in the user checkout, pushes, reports ready.
- Finish mode (`tasks.workerCanFinish` setting, default `false` = manual):
  when `false`, the worker preset does NOT mount `finish_task` — the model
  never sees it and only the human closes tasks from the panel (which then
  spawns next). When `true` (automatic), the worker closes its own task
  with `finish_task` and the queue advances on its own. Change it in
  Settings → Plugins → Plugin configuration → Tasks card (switch
  "Worker closes its own task"), or directly in `~/.dsh/settings.yaml`
  under `tasks:`. The Tasks panel header shows the live mode; flipping
  the setting mounts/unmounts the tool live.
- Auto-merge (`tasks.workerCanMerge` setting, default `false`): same card,
  switch "Worker merges into base (--no-ff)". When `true`, the worker
  merges its own branch into the base with `git merge --no-ff` (message
  `Merge task #<seq>: <title>`, one task = one merge commit) BEFORE
  closing, after rebase + green suite + fast-forward base check. At ANY
  conflict it aborts (`git merge --abort`), leaves the tree untouched,
  reports the conflicting files, and waits: the task stays open, no
  --theirs/--ours, no hand resolutions, no force on base. When `false`
  the human merges outside and the worker never touches base.
- Per-project queue switch (Tasks panel header, `workspaces.queue_enabled`,
  default ON): OFF pauses the project, so `approve` only moves the draft to
  `queued` — no promotion, no spawn — and closing the active task leaves the
  next one asleep. Each queued card then shows a **Start** button that
  promotes exactly that task (branch assigned with the usual clash suffix)
  and spawns its worker; the switch is per project, so repo-a can stay paused
  while repo-b keeps advancing. Switching back ON promotes the FIFO head when
  the slot is free. Queued cards also carry ▲/▼ to reorder queued tasks
  (move up/down inside the Queued group): the arrows rewrite the queue order
  and never start anything, so the reorder decides which task starts next.
  A queued card also carries **Back to draft**: it pulls the task out of the
  queue (a pure state reset, `queued_at` back to NULL) so the draft becomes
  editable again — approving it a second time re-enters at the end of the
  FIFO, never at its old position, and unqueueing never promotes.
  An active card carries **Back to queue**, which sends the task back to the
  queue without closing it: it frees the slot like a close (so an automatic
  project starts the FIFO head right away) and re-enters at the end of the
  FIFO with its branch KEPT — the next promotion resumes the same branch, so
  commits the previous worker already pushed stay valid — while its worker
  session is cleared and replaced by a fresh worker chat on re-promotion.
  Requeueing touches no git state: no merge, no revert, no branch delete.
- `approve_task`/`close_task` are USER-ONLY (panel buttons): never mounted as model tools.
- Everything is English: tool fields (`type/title/state/outcome`), presets,
  panel, prompts, and specs.

See `design-tasks-simple.md` for the full design (Italian, historical).

## Layout

- `lib/` — plugin code (`index.js` host entry, `intake-tools.js` / `worker-tools.js` scoped entries, `queue.js` queue domain, `tools.js` tool definitions, `config.js` schemastery schemas, `db.js`, `paths.js`, `runtime.js`).
- `presets/taskqueue-intake` — triage-only agent (no file-write tools).
- `presets/taskqueue-worker` — one-task executor (full dev on its branch).

## Config

`enabled` (default false), `order` (default 50 — see note below), `allowCommand` (default true), `section` (default English policy text), `baseBranch` (default `""` = auto from origin/HEAD), `dshHome` (default `""` = `resolveDshHome()`), `syncPresets` (default true).

DSH discovers presets only from fixed roots (never from plugin directories),
so at startup the plugin copies its own `presets/taskqueue-*` compositions
into `<dshHome>/.agent-presets`, always overwriting: the plugin source is the
single authority, hand edits in the installed copy are discarded on next boot.
`syncPresets: false` disables the copy entirely.

`order: 50` places the `tasks:policy` section right after the persona: the queue's USER-ONLY rule (approve/close are never the model) must precede every tool description, otherwise triage/worker prompts read as ordinary tool guidance. Official placements (`TOOL_READ=1100` etc.) sit far below; policy first is deliberate.
