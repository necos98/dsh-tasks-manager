// dsh-tasks-manager — finish_task visibility gate (pure: no ctx, no DSH imports).
//
// Setting `tasks.workerCanFinish` (default false) decides whether the worker
// model may close its own task:
//   true  (automatic) — the worker preset mounts finish_task; the worker
//           closes with done|failed, the queue advances and spawns next.
//   false (manual)    — finish_task is NOT registered in the worker layer,
//           so the model never sees it (UNKNOWN_TOOL on direct call); only
//           the human closes from the panel, which then spawns next.
//
// The gate is registration-based (dispose + re-register), not a guard:
// a guard would leave the tool visible in the model schemas. The caller
// owns the tools API + settings subscription; this module owns the state
// machine (mounted iff enabled) so host and scoped entries share it.
export const FINISH_TOOL = "finish_task";
export const TASKS_NS = "tasks";

/** Read the finish toggle from a resolved settings value (safe on undefined). */
export function workerCanFinishOf(value) {
  return !!(value && value.workerCanFinish === true);
}

/** Read the auto-merge toggle from a resolved settings value (safe on undefined). */
export function workerCanMergeOf(value) {
  return !!(value && value.workerCanMerge === true);
}

/**
 * Read the user-defined worker rules from a resolved settings value.
 * Verbatim free text (multiline); safe on missing/undefined/non-string -> "".
 * The spawn prompt appends it as its own labelled section, never into the
 * system-prompt policy text.
 */
export function workerRulesOf(value) {
  return typeof (value && value.workerRules) === "string" ? value.workerRules : "";
}

/**
 * Keep finish_task registration in sync with the setting.
 * @param defs.all - full definition list (from makeToolDefinitions).
 * @param defs.register - (definition) => disposer.
 * @param gate.initiallyEnabled - workerCanFinishOf(settings.get(NS)) at wiring time.
 * @param gate.onChange - subscribe((enabled) => void) => unsubscribe.
 * @returns { sync } — call with the latest enabled flag; unsubscribes via returned disposer.
 */
export function createFinishGate({ all, register, initiallyEnabled, onChange }) {
  const rest = all.filter((d) => d.name !== FINISH_TOOL);
  const finish = all.find((d) => d.name === FINISH_TOOL);
  for (const d of rest) register(d);
  let disposeFinish = null;
  const sync = (enabled) => {
    if (enabled && !disposeFinish && finish) disposeFinish = register(finish);
    else if (!enabled && disposeFinish) { disposeFinish(); disposeFinish = null; }
  };
  sync(!!initiallyEnabled);
  let unsubscribe = null;
  if (typeof onChange === "function") {
    unsubscribe = onChange((enabled) => sync(!!enabled)) || null;
  }
  return {
    sync,
    dispose() {
      if (disposeFinish) { disposeFinish(); disposeFinish = null; }
      if (typeof unsubscribe === "function") { unsubscribe(); unsubscribe = null; }
    },
  };
}
