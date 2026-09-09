// dsh-tasks-manager — scoped tool subsets for agent presets.
// The host entry (lib/index.js) registers the full set for USER-ONLY callers
// (buttons/commands). Each preset mounts only its subset as a row:
//   intake: dsh-tasks-manager/intake-tools -> enqueue/list/detail/search
//   worker: dsh-tasks-manager/worker-tools  -> get_my_task/finish_task/list/detail
// approve/close are never model-visible: no preset mounts them.
// finish_task is worker-only: close OWN active task (done|failed).
import { resolveConfig, NS } from "./config.js";
import { createFinishGate, workerCanFinishOf } from "./finish-toggle.js";
import { createRuntime } from "./runtime.js";
import { spawnForPromotion } from "./spawn.js";
import { makeToolDefinitions } from "./tools.js";

export const INTAKE_TOOLS = ["enqueue_task", "list_tasks", "task_detail", "search_tasks"];
export const WORKER_TOOLS = ["get_my_task", "finish_task", "list_tasks", "task_detail"];

export function applyScopedTools(ctx, config, names) {
  const resolved = resolveConfig(config);
  const runtime = createRuntime(resolved);
  // Same promotion spawner as the host entry (lib/index.js): the worker
  // preset resolves finish_task to THIS scoped registration (not the host
  // one), so without hooks the promoted task would sit in limbo with no
  // chat. The ctx is captured and read lazily at call time (agents service
  // resolves up the context tree); without it the spawn fails closed with
  // the error attached, never rolling back the promotion.
  runtime.spawnHooks = {
    spawnForPromotion: ({ db, workspace, promoted }) =>
      spawnForPromotion({ ctx, db, workspace, promoted }),
  };
  // finish_task visibility follows tasks.workerCanFinish (default false =
  // manual: the model never sees it, only the human closes from the panel).
  // Registration-time read + live resync: the tools + settings injects may
  // arrive in either order, so link() runs from both and wires once ready.
  const link = { toolsApi: null, settings: null, gate: null };
  const namesWanted = names.filter((n) => n !== "finish_task");
  const wantsFinish = names.includes("finish_task");
  function linkNow() {
    if (link.gate || !link.toolsApi || !link.settings) return;
    const api = link.toolsApi;
    const settings = link.settings;
    const all = makeToolDefinitions(runtime).filter((d) => namesWanted.includes(d.name) || (wantsFinish && d.name === "finish_task"));
    link.gate = createFinishGate({
      all,
      register: (d) => api.register(d),
      initiallyEnabled: wantsFinish && workerCanFinishOf(safeGet(settings)),
      onChange: wantsFinish
        ? (cb) => ctx.on("settings/updated", (ns, next) => { if (ns === NS) cb(workerCanFinishOf(next)); })
        : undefined,
    });
    ctx.effect(() => () => { link.gate.dispose(); link.gate = null; }, "dsh-tasks-manager: finishGate");
  }
  function safeGet(settings) {
    try { return settings.get(NS); } catch { return undefined; }
  }
  ctx.effect(() => () => { runtime.closeDb(); }, "dsh-tasks-manager: closeDb");
  ctx.inject(["workspaceRegistry"], (registryCtx) => {
    const registry = registryCtx.get("workspaceRegistry");
    if (registry) runtime.workspaceRegistry = registry;
  });
  ctx.inject(["tools"], (toolsCtx) => {
    link.toolsApi = toolsCtx.tools;
    linkNow();
  });
  ctx.inject(["settings"], (settingsCtx) => {
    link.settings = settingsCtx.settings;
    linkNow();
  });
}
