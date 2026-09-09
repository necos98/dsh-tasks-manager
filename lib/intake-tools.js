// dsh-tasks-manager/intake-tools — scoped plugin entry for the intake preset.
// Mounts only enqueue_task, list_tasks, task_detail, search_tasks
// (triage reads + drafts + history search).
// @module dsh-tasks-manager-intake-tools
import { Config } from "./config.js";
import { INTAKE_TOOLS, applyScopedTools } from "./scoped.js";

export const name = "dsh-tasks-manager-intake-tools";
export const inject = [];
export { Config };

export function apply(ctx, config) {
  applyScopedTools(ctx, config, INTAKE_TOOLS);
}
