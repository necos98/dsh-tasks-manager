// dsh-tasks-manager — agent tool definitions (defineTool).
// Eight tools, all workspace-scoped via the calling session:
// enqueue_task (triage), list_tasks, task_detail, search_tasks (read),
// get_my_task + finish_task (worker: read + close own task),
// approve_task + close_task (USER-ONLY callers: buttons/commands, never model).
//
// execute returns a STRUCTURED value validated against output.schema; the
// model sees output.render(args, value). Reads return the row(s); mutations
// return { task, promoted }. Ownership is verified BEFORE any mutation.
import { defineTool } from "@deepseek-ai/dsh-tools";
import { TaskError, approve, claimUnboundActive, close, enqueue, ensureWorkspace, get, list, search } from "./queue.js";

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

function fmt(t) {
  return "#" + t.id + " [" + t.state + "] " + t.title + " (" + t.type + ") branch=" + (t.branch || "-");
}

// Guard: resolve the row and verify it belongs to the caller's workspace
// BEFORE any mutation runs. Cross-workspace ids read as not-found and mutate
// nothing.
function ownedTask(db, workspaceRowId, id) {
  const t = get(db, id);
  if (!t || t.workspace_id !== workspaceRowId) throw new TaskError("not-found", "no task #" + id + " here");
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
  },
};

// Nullable promoted payload ({ id, branch } or null when the slot stays full).
const PROMOTED_SCHEMA = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "integer", required: true },
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
  },
};

function mutationRender(verb) {
  return (_args, value) => [{
    type: "text",
    // value.task is re-read AFTER promotion, so its state is already final
    // (usually active); the verb only records which transition ran.
    text: verb + " " + fmt(value.task) + (value.promoted && value.promoted.id !== value.task.id ? " | promoted #" + value.promoted.id + " -> active (" + value.promoted.branch + ")" : ""),
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
          text: "closed " + fmt(value.task) + (value.promoted ? " | promoted #" + value.promoted.id + " -> active" : ""),
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
        return close(c.db, mine.id, args.outcome);
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
        // Ownership first: cross-workspace approve mutates nothing.
        ownedTask(c.db, c.workspaceRowId, args.id);
        return approve(c.db, args.id);
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
          text: "closed " + fmt(value.task) + (value.promoted ? " | promoted #" + value.promoted.id + " -> active" : ""),
        }],
      },
      execute: async (args, exec) => {
        const c = ctxOf(store, exec);
        ownedTask(c.db, c.workspaceRowId, args.id);
        return close(c.db, args.id, args.outcome);
      },
    }),
  ];
}
