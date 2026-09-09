// dsh-tasks-manager/worker-tools — scoped plugin entry for the worker preset.
// Mounts only get_my_task, finish_task, list_tasks, task_detail
// (worker reads + close of its OWN active task).
// @module dsh-tasks-manager-worker-tools
import { Config } from "./config.js";
import { WORKER_TOOLS, applyScopedTools } from "./scoped.js";

export const name = "dsh-tasks-manager-worker-tools";
export const inject = [];
export { Config };

export function apply(ctx, config) {
  applyScopedTools(ctx, config, WORKER_TOOLS);
}
