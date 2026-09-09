// dsh-tasks-manager — agent tool definitions (defineTool).
// Nine tools, all workspace-scoped via the calling session:
// enqueue_task + edit_draft (triage), list_tasks, task_detail, search_tasks (read),
// get_my_task + finish_task (worker: read + close own task),
// approve_task + close_task (USER-ONLY callers: buttons/commands, never model).
//
// execute returns a STRUCTURED value validated against output.schema; the
// model sees output.render(args, value). Reads return the row(s); mutations
// return { task, promoted }. Ownership is verified BEFORE any mutation.
import { defineTool } from "@deepseek-ai/dsh-tools";
import { TaskError, approve, claimUnboundActive, close, editDraft, enqueue, ensureWorkspace, list, resolveTask, search } from "./queue.js";

function sessionIdOf(exec) {
  try { const h = exec && exec.agent && exec.agent.session && exec.agent.session.header; if (h && typeof h.id === "string" && h.id !== "") return h.id; } catch {}
  return undefined;
}

function workspaceOf(store, exec) {
  const reg = store && store.workspaceRegistry;
  const sid = sessionIdOf(exec);
  if (!reg || typeof reg.list !== "function") throw new TaskError("no-registry", "workspace registry unavailable");
  if (!sid) throw new TaskError("no-session", "this call carries no session id");
  const items = reg.list();
  const own = Array.isArray(items) ? items.find((w) => Array.isArray(w.sessionIds) && w.sessionIds.includes(sid)) : undefined;
  if (!own) throw new TaskError("no-workspace", "calling session belongs to no workspace");
  return { id: String(own.id), root: own.path || "" };
}

function ctxOf(store, exec) {
  const ws = workspaceOf(store, exec);
  const db = store.getDb();
  const workspaceRowId = ensureWorkspace(db, ws.root === "" ? ("ws:" + ws.id) : ws.root);
  return { db, ws, workspaceRowId };
}

// Canonical workspace identity for the spawn path (same mapping as ctxOf,
// minus the tool exec envelope: spawnWorker needs { id, path }).
function spawnWorkspaceOf(store, exec) {
  const ws = workspaceOf(store, exec);
  return { id: String(ws.id), path: ws.root || "" };
}

// Post-mutation spawn hook, injected per entry point:
// - host (lib/index.js): passes the plugin ctx so promotions open a chat;
// - tests / scoped worker preset: no hook, pure queue behavior.
function spawnHookOf(store) {
  const hooks = store && store.spawnHooks;
  if (hooks && typeof hooks.spawnForPromotion === "function") return hooks.spawnForPromotion;
  if (typeof store.spawnForPromotion === "function") return store.spawnForPromotion;
  return undefined;
}

// Run the promotion spawn AFTER the queue mutation commits. A spawn failure
// never rolls the promotion back: the task stays active and the error rides
// the mutation value as `spawn` so the render can surface it.
async function withPromotionSpawn(store, exec, c, out) {
  if (!out || !out.promoted) return out;
  const hook = spawnHookOf(store);
  if (!hook) return out;
  const spawn = await hook({
    exec,
    db: c.db,
    workspace: spawnWorkspaceOf(store, exec),
    promoted: out.promoted,
  });
  return spawn === undefined ? out : { ...out, spawn };
}

// Visible number: the per-workspace seq (what the panel shows as #N).
// The global id stays the internal row identity but never surfaces here.
// num() tolerates id-only shapes (e.g. hand-built payloads in tests).
function num(t) { return t.seq ?? t.id; }

function fmt(t) {
  return "#" + num(t) + " [" + t.state + "] " + t.title + " (" + t.type + ") branch=" + (t.branch || "-");
}

// Guard: resolve the row and verify it belongs to the caller's workspace
// BEFORE any mutation runs. Accepts the global id (back-compat) and the
// visible seq (what fmt/panel display); cross-workspace numbers read as
// not-found and mutate nothing.
function ownedTask(db, workspaceRowId, n) {
  const t = resolveTask(db, workspaceRowId, n);
  if (!t) throw new TaskError("not-found", "no task #" + n + " here");
  return t;
}

const STR = { type: "string" };
const INT = { type: "integer" };

// Nullable free-text column: null (never set) and string both validate.
const NULLSTR = { oneOf: [{ type: "string" }, { type: "null" }] };
const TASK_STATE = { type: "string", enum: ["draft", "queued", "active", "done", "cancelled", "failed"] };

const TASK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "integer", required: true },
    workspace_id: { type: "integer", required: true },
    seq: { type: "integer", required: true },
    type: { type: "string", enum: ["feature", "bug", "refactor", "chore"], required: true },
    title: { type: "string", required: true },
    slug: { type: "string", required: true },
    spec: STR,
    branch: STR,
    state: TASK_STATE,
    worker_session: NULLSTR,
    created_at: STR,
    updated_at: STR,
    closed_at: NULLSTR,
    close_reason: NULLSTR,
    queued_at: NULLSTR,
  },
};

// Spawn outcome attached to a mutation when the entry point spawned a worker
// for the promoted task ({ sessionId } ok, { error } failed, null/undefined
// when no promotion or no spawner). Optional: old values without it validate.
const SPAWN_SCHEMA = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      properties: {
        sessionId: { type: "string" },
        error: { type: "string" },
      },
    },
    { type: "null" },
  ],
};

// Nullable promoted payload ({ id, branch } or null when the slot stays full).
const PROMOTED_SCHEMA = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "integer", required: true },
        seq: { type: "integer" },
        branch: { type: "string", required: true },
      },
    },
    { type: "null" },
  ],
};

const MUTATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    task: { ...TASK_SCHEMA, required: true },
    promoted: { ...PROMOTED_SCHEMA, required: true },
    spawn: SPAWN_SCHEMA,
  },
};

function spawnSuffix(value) {
  const spawn = value && value.spawn;
  if (spawn && typeof spawn.sessionId === "string") return " | worker " + spawn.sessionId;
  if (spawn && typeof spawn.error === "string") return " | worker spawn failed: " + spawn.error;
  return "";
}

function mutationRender(verb) {
  return (_args, value) => [{
    type: "text",
    // value.task is re-read AFTER promotion, so its state is already final
    // (usually active); the verb only records which transition ran.
    text: verb + " " + fmt(value.task) + (value.promoted && value.promoted.id !== value.task.id ? " | promoted #" + num(value.promoted) + " -> active (" + value.promoted.branch + ")" : "") + spawnSuffix(value),
  }];
}

export function makeToolDefinitions(store) {
  return [
    defineTool({
      name: "enqueue_task",
      description: "File a task draft (triage only). Never advances the queue.",
      parameters: {
        type: { type: "string", enum: ["feature", "bug", "refactor", "chore"], required: true },
        title: { ...STR, required: true },
        spec: STR,
      },
      output: {
        schema: TASK_SCHEMA,
        render: (_args, value) => [{ type: "text", text: "draft " + fmt(value) }],
      },
      execute: async (args, exec) => {
        const c = ctxOf(store, exec);
        return enqueue(c.db, c.workspaceRowId, args);
      },
    }),
    defineTool({
      name: "edit_draft",
      description: "Revise an existing DRAFT task (title/spec/type). Only drafts can be edited; never queued/active/closed tasks.",
      parameters: {
        id: { ...INT, required: true },
        title: STR,
        spec: STR,
        type: { type: "string", enum: ["feature", "bug", "refactor", "chore"] },
      },
      output: {
        schema: TASK_SCHEMA,
        render: (_args, value) => [{ type: "text", text: "edited " + fmt(value) }],
      },
      execute: async (args, exec) => {
        const c = ctxOf(store, exec);
        // Ownership first, same as approve/close: cross-workspace numbers
        // mutate nothing; the mutation runs on the internal id.
        const owned = ownedTask(c.db, c.workspaceRowId, args.id);
        return editDraft(c.db, owned.id, args);
      },
    }),
    defineTool({
      name: "list_tasks",
      description: "List tasks of this workspace, optionally filtered by state.",
      parameters: { state: TASK_STATE },
      output: {
        schema: { type: "array", items: TASK_SCHEMA },
        render: (_args, value) => [{ type: "text", text: value.length === 0 ? "no tasks" : value.map(fmt).join("\n") }],
      },
      execute: async (args, exec) => {
        const c = ctxOf(store, exec);
        return list(c.db, c.workspaceRowId, args.state);
      },
    }),
    defineTool({
      name: "task_detail",
      description: "Show one task of this workspace by id.",
      parameters: { id: { ...INT, required: true } },
      output: {
        schema: TASK_SCHEMA,
        render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }],
      },
      execute: async (args, exec) => {
        const c = ctxOf(store, exec);
        return ownedTask(c.db, c.workspaceRowId, args.id);
      },
    }),
    defineTool({
      name: "search_tasks",
      description: "Search this workspace's task history by text (title+spec), optionally filtered by state. Triage: use before filing a draft to cite related tasks instead of duplicating them.",
      parameters: {
        query: { ...STR, required: true },
        state: TASK_STATE,
        limit: INT,
      },
      output: {
        schema: { type: "array", items: TASK_SCHEMA },
        render: (_args, value) => [{ type: "text", text: value.length === 0 ? "no matches" : value.map(fmt).join("\n") }],
      },
      execute: async (args, exec) => {
        const c = ctxOf(store, exec);
        return search(c.db, c.workspaceRowId, args.query, args.state, args.limit);
      },
    }),
    defineTool({
      name: "get_my_task",
      description: "Worker: show the active task of this workspace, binding your session on first read. The system opens one chat per active task; this tool never claims across workspaces.",
      parameters: {},
      output: {
        schema: TASK_SCHEMA,
        render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }],
      },
      execute: async (_args, exec) => {
        const c = ctxOf(store, exec);
        const sid = sessionIdOf(exec);
        if (!sid) throw new TaskError("no-session", "this call carries no session id");
        const rows = list(c.db, c.workspaceRowId, "active");
        const mine = rows.find((t) => t.worker_session === sid);
        if (mine) return mine;
        const free = rows.find((t) => t.worker_session == null);
        // Lazy bind: first worker read on an unbound active task wins (CAS).
        if (free) return claimUnboundActive(c.db, free.id, sid);
        throw new TaskError("not-bound", "no active task bound to this session");
      },
    }),
    defineTool({
      name: "finish_task",
      description: "Worker: close YOUR OWN active task with done (work complete, you decide) or failed (stuck with no way forward). Only the task bound to your session; nothing else. For failed, first ask the user with ask_user_question and proceed only on confirmation.",
      parameters: {
        outcome: { type: "string", enum: ["done", "failed"], required: true },
      },
      output: {
        schema: MUTATION_SCHEMA,
        render: (_args, value) => [{
          type: "text",
          text: "closed " + fmt(value.task) + (value.promoted ? " | promoted #" + num(value.promoted) + " -> active" : "") + spawnSuffix(value),
        }],
      },
      execute: async (args, exec) => {
        const c = ctxOf(store, exec);
        const sid = sessionIdOf(exec);
        if (!sid) throw new TaskError("no-session", "this call carries no session id");
        // Own task only: the active row bound to THIS session. No id param —
        // the worker cannot touch queued tasks or other sessions' work.
        const rows = list(c.db, c.workspaceRowId, "active");
        const mine = rows.find((t) => t.worker_session === sid);
        if (!mine) throw new TaskError("not-bound", "no active task bound to this session");
        // The close may promote the next queued task: the new active task
        // needs its worker chat, or it sits in limbo with no session bound.
        const out = close(c.db, mine.id, args.outcome);
        return withPromotionSpawn(store, exec, c, out);
      },
    }),
    defineTool({
      name: "approve_task",
      description: "USER-ONLY: draft -> queued (always), then FIFO promote if slot free. Never the model.",
      parameters: { id: { ...INT, required: true } },
      output: {
        schema: MUTATION_SCHEMA,
        render: mutationRender("queued"),
      },
      execute: async (args, exec) => {
        const c = ctxOf(store, exec);
        // Ownership first: cross-workspace numbers mutate nothing. The
        // mutation itself runs on the internal id (approve/close take rows,
        // not display numbers).
        const owned = ownedTask(c.db, c.workspaceRowId, args.id);
        const out = approve(c.db, owned.id);
        return withPromotionSpawn(store, exec, c, out);
      },
    }),
    defineTool({
      name: "close_task",
      description: "USER-ONLY: close a task with done|cancelled|failed. Frees the slot, FIFO advances. Never the model.",
      parameters: {
        id: { ...INT, required: true },
        outcome: { type: "string", enum: ["done", "cancelled", "failed"], required: true },
      },
      output: {
        schema: MUTATION_SCHEMA,
        render: (_args, value) => [{
          type: "text",
          text: "closed " + fmt(value.task) + (value.promoted ? " | promoted #" + num(value.promoted) + " -> active" : ""),
        }],
      },
      execute: async (args, exec) => {
        const c = ctxOf(store, exec);
        const owned = ownedTask(c.db, c.workspaceRowId, args.id);
        const out = close(c.db, owned.id, args.outcome);
        return withPromotionSpawn(store, exec, c, out);
      },
    }),
  ];
}
