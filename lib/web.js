// dsh-tasks-manager — web RPC handlers (pure: no ctx, no DSH imports).
//
// The browser half (lib/client.js) cannot call tool execute paths directly:
// it talks to the host half through the generic Connection RPC channel
// (ctx.connection.rpc.handle, same pattern as dsh-plugin-manager).
// These factories take the runtime explicitly so unit tests drive the channel
// without booting Cordis.
//
// Session routing: the client sends its sessionId; ownership is verified
// BEFORE any mutation (same ownedTask guard as lib/tools.js). Cross-workspace
// ids read as not-found and mutate nothing.
//
// Methods:
//   snapshot { sessionId }            — tasks of the caller's workspace,
//                                       grouped by the client (draft/queued/
//                                       active/closed) + workspace label +
//                                       queue switch state.
//   approve  { sessionId, id }        — USER-ONLY: draft -> queued (+ promote).
//   close    { sessionId, id, outcome } — USER-ONLY: -> done|cancelled|failed.
//   setQueueEnabled { sessionId, enabled } — USER-ONLY: pause/resume the
//                                       project queue (resume promotes head).
//   start    { sessionId, id }        — USER-ONLY: promote exactly this
//                                       queued task (paused or not).
//   move     { sessionId, id, direction } — USER-ONLY: reorder the queued set
//                                       ("up"|"down"), never promotes.
import { TaskError, approve, close, ensureWorkspace, get, list, moveQueued, queueEnabled, resolveTask, setQueueEnabled as applyQueueEnabled, startTask } from "./queue.js";
import { workerCanFinishOf, workerCanMergeOf, workerRulesOf, TASKS_NS } from "./finish-toggle.js";
import { spawnForPromotion, spawnWorker } from "./spawn.js";

function requireSessionId(payload) {
  const sid = payload && payload.sessionId;
  if (typeof sid !== "string" || sid === "") {
    throw new TaskError("no-session", "snapshot needs a string sessionId");
  }
  return sid;
}

function requireId(payload) {
  const id = payload && payload.id;
  if (typeof id !== "number" || !Number.isInteger(id)) {
    throw new TaskError("bad-id", "this call needs an integer task id");
  }
  return id;
}

function requireEnabled(payload) {
  const enabled = payload && payload.enabled;
  if (typeof enabled !== "boolean") {
    throw new TaskError("bad-enabled", "this call needs a boolean enabled");
  }
  return enabled;
}

// Resolve the caller's workspace row (registry -> canonical path -> id).
// Same mapping as lib/tools.js ctxOf, minus the tool exec envelope.
function workspaceCtx(store, sessionId) {
  const reg = store && store.workspaceRegistry;
  if (!reg || typeof reg.list !== "function") {
    throw new TaskError("no-registry", "workspace registry unavailable");
  }
  const items = reg.list();
  const own = Array.isArray(items)
    ? items.find((w) => Array.isArray(w.sessionIds) && w.sessionIds.includes(sessionId))
    : undefined;
  if (!own) throw new TaskError("no-workspace", "calling session belongs to no workspace");
  const db = store.getDb();
  const root = own.path || "";
  const workspaceRowId = ensureWorkspace(db, root === "" ? ("ws:" + own.id) : root);
  return { db, workspaceRowId, workspace: { id: String(own.id), path: own.path || "", title: own.title || "" } };
}

// Guard: resolve the row and verify it belongs to the caller's workspace
// BEFORE any mutation runs. Accepts the global id (back-compat) and the
// visible seq (what the panel displays as #N); cross-workspace numbers read
// as not-found.
function ownedTask(db, workspaceRowId, num) {
  const t = resolveTask(db, workspaceRowId, num);
  if (!t) {
    throw new TaskError("not-found", "no task #" + num + " here");
  }
  return t;
}

function snapshotOf(c, modes) {
  const rows = list(c.db, c.workspaceRowId);
  return { workspace: c.workspace, tasks: rows, queueEnabled: queueEnabled(c.db, c.workspaceRowId), ...modes };
}

export function createWebHandlers(store, hooks) {
  const spawner = hooks && hooks.spawnWorker ? hooks.spawnWorker : spawnWorker;
  const pluginCtx = hooks && hooks.ctx ? hooks.ctx : undefined;
  // Worker spawn after a promotion to active. The queue mutation already
  // committed; a spawn failure must never roll it back — the task stays
  // active and the error rides the payload as spawn. Test doubles inject
  // spawnWorker directly (called with the active row, legacy shape); the
  // real path goes through spawnForPromotion (shared with the tool path).
  async function maybeSpawn(c, out) {
    const promoted = out && out.promoted;
    if (!promoted || !pluginCtx) return undefined;
    if (hooks && hooks.spawnWorker) {
      const active = get(c.db, promoted.id);
      if (!active || active.state !== "active") return undefined;
      try {
        const r = await spawner({ ctx: pluginCtx, db: c.db, workspace: c.workspace, task: active });
        return { sessionId: r.sessionId };
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    }
    return spawnForPromotion({ ctx: pluginCtx, db: c.db, workspace: c.workspace, promoted });
  }
  // Finish/merge modes + user rules for the panel header (manual default,
  // empty rules): read live from the plugin ctx settings; unit-test
  // handlers without ctx read as manual.
  function modes() {
    try {
      const settings = pluginCtx && typeof pluginCtx.get === "function" ? pluginCtx.get("settings") : undefined;
      const value = settings && typeof settings.get === "function" ? settings.get(TASKS_NS) : undefined;
      return { workerCanFinish: workerCanFinishOf(value), workerCanMerge: workerCanMergeOf(value), workerRules: workerRulesOf(value) };
    } catch {
      return { workerCanFinish: false, workerCanMerge: false, workerRules: "" };
    }
  }
  return {
    snapshot(payload) {
      const sid = requireSessionId(payload);
      return snapshotOf(workspaceCtx(store, sid), modes());
    },
    async approve(payload) {
      const sid = requireSessionId(payload);
      const id = requireId(payload);
      const c = workspaceCtx(store, sid);
      // Ownership first: cross-workspace numbers mutate nothing. The mutation
      // itself runs on the internal id (approve takes a row, not a display #N).
      const owned = ownedTask(c.db, c.workspaceRowId, id);
      const out = approve(c.db, owned.id);
      const spawn = await maybeSpawn(c, out);
      const task = get(c.db, owned.id);
      // Re-read: the spawn binds worker_session on the promoted row.
      const promoted = out.promoted ? get(c.db, out.promoted.id) : null;
      return { ...out, task, promoted, workspace: c.workspace, ...modes(), ...(spawn ? { spawn } : {}) };
    },
    async close(payload) {
      const sid = requireSessionId(payload);
      const id = requireId(payload);
      const outcome = payload && payload.outcome;
      const c = workspaceCtx(store, sid);
      const owned = ownedTask(c.db, c.workspaceRowId, id);
      const out = close(c.db, owned.id, outcome);
      const task = get(c.db, owned.id);
      const promoted = out.promoted ? get(c.db, out.promoted.id) : null;
      // A close can promote the next queued task: same spawn policy.
      const spawn = await maybeSpawn(c, { promoted: out.promoted });
      return { ...out, task, promoted, workspace: c.workspace, ...modes(), ...(spawn ? { spawn } : {}) };
    },
    // Pause/resume the project queue. Resuming can promote the FIFO head,
    // which is a promotion like any other: it spawns its worker. Pausing
    // never promotes and never touches a row.
    async setQueueEnabled(payload) {
      const sid = requireSessionId(payload);
      const enabled = requireEnabled(payload);
      const c = workspaceCtx(store, sid);
      const out = applyQueueEnabled(c.db, c.workspaceRowId, enabled);
      const spawn = await maybeSpawn(c, out);
      const promoted = out.promoted ? get(c.db, out.promoted.id) : null;
      return {
        ...out,
        task: promoted,
        promoted,
        workspace: c.workspace,
        queueEnabled: queueEnabled(c.db, c.workspaceRowId),
        ...modes(),
        ...(spawn ? { spawn } : {}),
      };
    },
    // Reorder one queued task (panel ▲/▼). Ownership first, exactly like
    // start: a cross-workspace number reads not-found and mutates nothing.
    // No spawn: a reorder never promotes, so there is no worker to open.
    move(payload) {
      const sid = requireSessionId(payload);
      const id = requireId(payload);
      const direction = payload && payload.direction;
      const c = workspaceCtx(store, sid);
      const owned = ownedTask(c.db, c.workspaceRowId, id);
      const out = moveQueued(c.db, c.workspaceRowId, owned.id, direction);
      return {
        ...out,
        task: get(c.db, owned.id),
        promoted: null,
        workspace: c.workspace,
        queueEnabled: queueEnabled(c.db, c.workspaceRowId),
        ...modes(),
      };
    },
    // Manual start of one chosen queued task (the paused-queue path).
    // Ownership first, exactly like approve: cross-workspace numbers mutate
    // nothing and the mutation runs on the internal id.
    async start(payload) {
      const sid = requireSessionId(payload);
      const id = requireId(payload);
      const c = workspaceCtx(store, sid);
      const owned = ownedTask(c.db, c.workspaceRowId, id);
      const out = startTask(c.db, c.workspaceRowId, owned.id);
      const spawn = await maybeSpawn(c, out);
      const task = get(c.db, owned.id);
      const promoted = out.promoted ? get(c.db, out.promoted.id) : null;
      return {
        ...out,
        task,
        promoted,
        workspace: c.workspace,
        queueEnabled: queueEnabled(c.db, c.workspaceRowId),
        ...modes(),
        ...(spawn ? { spawn } : {}),
      };
    },
  };
}

/** Route one RPC call to the method handlers. Always { ok, value|error }. */
export async function routeWebCall(handlers, endpoint, payload) {
  try {
    switch (endpoint) {
      case "snapshot":
        return { ok: true, value: await handlers.snapshot(payload) };
      case "approve":
        return { ok: true, value: await handlers.approve(payload) };
      case "close":
        return { ok: true, value: await handlers.close(payload) };
      case "setQueueEnabled":
        return { ok: true, value: await handlers.setQueueEnabled(payload) };
      case "start":
        return { ok: true, value: await handlers.start(payload) };
      case "move":
        return { ok: true, value: await handlers.move(payload) };
      default:
        return { ok: false, error: { code: "internal", message: 'unknown tasks-queue method "' + endpoint + '"', details: {} } };
    }
  } catch (error) {
    const code = error instanceof TaskError ? error.code : "internal";
    return { ok: false, error: { code, message: error instanceof Error ? error.message : String(error), details: {} } };
  }
}
