// dsh-tasks-manager — config domain (schemastery schemas + guards).
// No ctx, no DSH imports besides schemastery: unit-testable without booting DSH.
import z from "@deepseek-ai/schemastery";

// English policy section, injected when enabled.
export const DEFAULT_SECTION = [
  "Simple task queue (tasks-manager plugin): the queue tool is the",
  "only authority on draft/queued/active/closed. approve/close are USER-ONLY",
  "(buttons or chat command), never the model. Triage may only file drafts via",
  "enqueue_task. One active task per workspace; queued tasks advance FIFO when",
  "the slot frees. Git/test/PR discipline lives in the agent prompt, not in the",
  "tool: the tool never checks the tree, branches, tests, or merges.",
].join("\n");

// Plugin config schema (compose-time validation, Standard Schema).
// Cordis calls Config['~standard'].validate(config) at load; defaults fill in
export const Config = z.object({
  enabled: z.boolean().default(false),
  order: z.number().default(50),
  allowCommand: z.boolean().default(true),
  section: z.string().default(DEFAULT_SECTION),
  baseBranch: z.string().default(""),
  dshHome: z.string().default(""),
  // Copy presets/taskqueue-* into <dshHome>/.agent-presets at startup
  // (created once, refreshed only while still pristine — lib/presets-sync.js).
  syncPresets: z.boolean().default(true),
});

// Accepted config keys, for the unknown-key guard.
// (schemastery passes unknown keys through, so the guard stays explicit.)
export const CONFIG_KEYS = [
  "enabled",
  "order",
  "allowCommand",
  "section",
  "baseBranch",
  "dshHome",
  "syncPresets",
];

// Settings namespace shared with the web client.
export const NS = "tasks";

export function settingsNamespace(value) {
  if (!/^[a-z][a-z0-9-]*$/.test(value)) {
    throw new TypeError(
      'settings namespace "' + value + '" must match /^[a-z][a-z0-9-]*$/'
    );
  }
  return value;
}

export function resolveConfig(config) {
  const cfg = config ?? {};
  for (const key of Object.keys(cfg)) {
    if (!CONFIG_KEYS.includes(key)) {
      throw new Error("TasksConfig: unknown key " + key);
    }
  }
  // Compose-time schema validation (types + defaults).
  const resolved = Config(cfg);
  if (typeof resolved.section !== "string" || resolved.section.trim() === "") {
    throw new Error("TasksConfig needs a non-empty string section");
  }
  if (typeof resolved.order !== "number" || !Number.isFinite(resolved.order)) {
    throw new Error("TasksConfig needs a finite number order");
  }
  return resolved;
}

// Settings schema for the web client half (schemastery, like every caller does).
export const tasksSchema = z.object({
  baseBranch: z.string().default(""),
  // Manual vs automatic finish: when false (default) the worker preset does
  // NOT mount finish_task — the model never sees it and only the human
  // closes tasks from the panel. When true the worker closes its own task
  // and the queue auto-advances with a fresh worker spawn.
  workerCanFinish: z.boolean().default(false),
  // Auto-merge: when true the worker merges its own branch into the base
  // with --no-ff BEFORE closing (PR must exist, suite green). Any conflict
  // aborts the merge: the worker reports it and waits for the human, the
  // task stays open. Default false: the human merges outside, the worker
  // never touches the base branch.
  workerCanMerge: z.boolean().default(false),
  // Free-text user rules, appended VERBATIM to the worker's first message
  // (never to the system prompt). Multiline, no interpretation; default ""
  // keeps the spawn prompt byte-identical when unset.
  workerRules: z.string().default(""),
});
