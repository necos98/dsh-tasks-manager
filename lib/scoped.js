// dsh-tasks-manager — scoped tool subsets for agent presets.
// The host entry (lib/index.js) registers the full set for USER-ONLY callers
// (buttons/commands). Each preset mounts only its subset as a row:
//   intake: dsh-tasks-manager/intake-tools -> enqueue/list/detail/search
//   worker: dsh-tasks-manager/worker-tools  -> get_my_task/finish_task/list/detail
// approve/close are never model-visible: no preset mounts them.
// finish_task is worker-only: close OWN active task (done|failed).
import { resolveConfig } from "./config.js";
import { createRuntime } from "./runtime.js";
import { makeToolDefinitions } from "./tools.js";

export const INTAKE_TOOLS = ["enqueue_task", "list_tasks", "task_detail", "search_tasks"];
export const WORKER_TOOLS = ["get_my_task", "finish_task", "list_tasks", "task_detail"];

export function applyScopedTools(ctx, config, names) {
  const resolved = resolveConfig(config);
  const runtime = createRuntime(resolved);
  ctx.effect(() => () => { runtime.closeDb(); }, "dsh-tasks-manager: closeDb");
  ctx.inject(["workspaceRegistry"], (registryCtx) => {
    const registry = registryCtx.get("workspaceRegistry");
    if (registry) runtime.workspaceRegistry = registry;
  });
  ctx.inject(["tools"], (toolsCtx) => {
    for (const definition of makeToolDefinitions(runtime)) {
      if (names.includes(definition.name)) toolsCtx.tools.register(definition);
    }
  });
}
