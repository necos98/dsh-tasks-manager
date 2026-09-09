# dsh-tasks-manager

Stupid-synchronous task queue for DSH: one active task per repo, FIFO promotion, manual close.

- Intake files drafts via `enqueue_task(type, title, spec)` — one draft per
  requested task, so "queue task A and task B" files two drafts; the user
  approves (`approve_task`) or discards each.
- The queue promotes the oldest `queued` task to `active` when the slot frees;
  approving (or closing) a task auto-spawns its worker chat
  (`taskqueue-worker` preset, English prompt) bound via `worker_session`.
  `close_task(id, outcome)` with `done|cancelled|failed` frees the slot.
- The worker reads its task with `get_my_task` (spawn already binds the
  session), works on `task/<seq>-<slug>` (per-workspace visible number) in the user checkout, pushes, reports ready.
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
