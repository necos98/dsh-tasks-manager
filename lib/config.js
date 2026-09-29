// dsh-tasks-manager — config domain (schemastery schemas + guards).
// No ctx, no DSH imports besides schemastery: unit-testable without booting DSH.
import z from "@deepseek-ai/schemastery";

// English policy section, injected when enabled.
export const DEFAULT_SECTION = [
  "Simple task queue (tasks-manager plugin): the queue tool is the",
  "only authority on draft/queued/active/closed. approve/close are USER-ONLY",
  "(buttons or chat command), never the model. Triage may only file drafts via",
  "enqueue_task and revise drafts via edit_draft. One active task per workspace; queued tasks advance FIFO (approval order) when",
  "the slot frees. Git/test/PR discipline lives in the agent prompt, not in the",
  "tool: the tool never checks the tree, branches, tests, or merges.",
].join("\n");

// Settings namespace shared with the web client, and the id of this plugin's
// Cordis patch row. Since DSH 0.1.7-rc.2 the settings document is addressed by
// the profile entry id (`entry.options.id`) instead of by a namespace the plugin
// registers itself: `settings.describe()` publishes one namespace per live
// entry, keyed by this id, built from the VOLATILE fields of the Config schema
// below. `settings.get(SETTINGS_NS)` reads the same merged view on the host.
export const SETTINGS_NS = "dsh-tasks-manager";

/**
 * The cosmokit volatile-reference protocol (`Symbol.for`, so it is stable
 * across ESM/CJS copies of the shared library and across the isolated
 * `node_modules` layouts a plugin can be installed under). A `.volatile()`
 * Config field resolves to a reference whose value is read through `get()`;
 * ordinary property access on one yields the accessor object, not the value.
 */
const VOLATILE_WRITE = Symbol.for("cosmokit.volatile.write");

/**
 * @param value Any value.
 * @returns Whether it is a cosmokit volatile reference.
 */
export function isVolatileRef(value) {
  return typeof value === "object" && value !== null && VOLATILE_WRITE in value;
}

/**
 * Replace every volatile reference in a resolved Config value with its value,
 * so ordinary property reads work. Without this, a `.volatile()` field reads
 * back as an accessor and every consumer silently sees `undefined`.
 * @param value A resolved Config value (or any nested part of one).
 * @returns The same shape with plain values.
 */
export function toPlain(value) {
  if (isVolatileRef(value)) return toPlain(value.get());
  if (Array.isArray(value)) return value.map(toPlain);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toPlain(v)]));
  }
  return value;
}

/**
 * Read this entry's live settings value from a `settings` service.
 *
 * The value is looked up by the profile entry id. The service is asked through
 * whichever reader it exposes: `get(ns)` (the per-namespace reader the host
 * half and the tests use) or `describe()` (the settings document projection,
 * one descriptor per live entry). Being tolerant of both keeps the read working
 * across the settings service implementations rather than binding to one.
 *
 * Safe on any missing piece — an absent service, a service with neither reader,
 * or a namespace the host does not serve reads as `undefined`.
 * @param settings The `settings` service (or anything, in tests).
 * @param ns Namespace to read; defaults to this plugin's SETTINGS_NS.
 * @returns The plain namespace value, or undefined.
 */
export function settingsValueOf(settings, ns = SETTINGS_NS) {
  try {
    if (!settings) return undefined;
    if (typeof settings.get === "function") return toPlain(settings.get(ns));
    if (typeof settings.describe !== "function") return undefined;
    const descriptor = settings.describe().find((candidate) => candidate.ns === ns);
    return descriptor === undefined ? undefined : toPlain(descriptor.value);
  } catch {
    return undefined;
  }
}

// Plugin config schema (compose-time validation, Standard Schema).
// Cordis calls Config['~standard'].validate(config) at load; defaults fill in.
//
// The six `tasks` settings are `.volatile()`: that is what makes them appear
// as the live settings namespace the web client reads and writes (Settings →
// Tasks). Everything else is deployment configuration and stays OUT of the
// settings form — `section` is the (large) policy text, and the `update*` keys
// are compose-time controls, `updateToken` being a secret that must not be
// exposed to the browser.
export const Config = z.object({
  enabled: z.boolean().default(false),
  order: z.number().default(50),
  allowCommand: z.boolean().default(true),
  section: z.string().default(DEFAULT_SECTION),
  dshHome: z.string().default(""),
  // Manual GitHub updater (Settings → Tasks, lib/updater.js). Deployment
  // config, not a per-user switch: no key lives in the `tasks` namespace.
  // Releases come from RELEASE TAGS only (vX.Y.Z / X.Y.Z), never from a
  // branch head.
  updateRepository: z.string().default("necos98/dsh-tasks-manager"),
  // "" = derive the profile name from the resolved profile directory.
  updateProfile: z.string().default(""),
  updateIncludePrerelease: z.boolean().default(false),
  updateTimeoutMs: z.number().default(180000),
  // "" = locate the profile by walking up to `dsh.profile`.
  updateProfileDir: z.string().default(""),
  // Only for the GitHub API fallback, when `git ls-remote` is unavailable.
  updateToken: z.string().default(""),

  // ---- the live settings namespace (Settings → Tasks) ----
  // Base branch the worker branches from; "" = auto from origin/HEAD.
  baseBranch: z.string().default("").volatile(),
  // Manual vs automatic finish: when false (default) the worker preset does
  // NOT mount finish_task — the model never sees it and only the human
  // closes tasks from the panel. When true the worker closes its own task
  // and the queue auto-advances with a fresh worker spawn.
  workerCanFinish: z.boolean().default(false).volatile(),
  // Git workflow the worker follows for every task of this entry.
  // branch-automerge (default): the worker creates task/<seq>-<slug> from the
  // base branch, pushes, opens exactly one PR and merges it with --no-ff
  // before closing. in-place-local: the worker stays on the CURRENT branch
  // (no new branch, no PR, no merge, no push). in-place-push: same as
  // in-place-local plus one trailing `git push` of the current branch.
  // baseBranch only applies to branch-automerge; the in-place modes ignore it.
  workerGitMode: z.union([z.const("branch-automerge"), z.const("in-place-local"), z.const("in-place-push")]).default("branch-automerge").volatile(),
  // Free-text commit/PR language (e.g. "English", "Italian"). Empty/blank
  // reads as "English" everywhere it is consumed. Default "English" keeps
  // the spawn prompt byte-identical when unset.
  commitLanguage: z.string().default("English").volatile(),
  // Commit/PR verbosity: minimal (one-line commits, short PRs) or extended
  // (subject + body, sectioned PRs). Unknown values read as "extended".
  messageStyle: z.union([z.const("minimal"), z.const("extended")]).default("extended").volatile(),
  // Override the worker's LLM model. Empty string = inherit the global
  // agentDefaultModel selection (the default). Set a provider/model id
  // (e.g. "anthropic/claude-3.5-sonnet") to pin the worker chat to it.
  workerModel: z.string().default("").volatile(),
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
  "updateRepository",
  "updateProfile",
  "updateIncludePrerelease",
  "updateTimeoutMs",
  "updateProfileDir",
  "updateToken",
  "workerCanFinish",
  "workerGitMode",
  "commitLanguage",
  "messageStyle",
  "workerModel",
];

/**
 * The keys of the live settings namespace (the volatile Config fields). Kept
 * next to the schema so consumers and the drift test agree on the surface.
 */
export const SETTINGS_KEYS = [
  "baseBranch",
  "workerCanFinish",
  "workerGitMode",
  "commitLanguage",
  "messageStyle",
  "workerModel",
];

/**
 * Validate and resolve the row's config.
 *
 * `resolveConfig` returns a PLAIN object and is IDEMPOTENT: the Cordis loader
 * already resolves the row config against {@link Config} before `apply()` runs,
 * so a config arriving from the loader carries cosmokit volatile references
 * (not plain strings/booleans) and re-resolving it would throw. An
 * already-resolved config is unwrapped instead of re-validated; a raw config
 * (a test, or a caller passing its own object) is validated and defaulted.
 * @param config Raw (or already schema-resolved) plugin config.
 * @returns A detached plain config with schema defaults applied.
 */
export function resolveConfig(config) {
  const cfg = config ?? {};
  if (typeof cfg !== "object" || Array.isArray(cfg)) {
    throw new Error("TasksConfig needs an object");
  }
  // A schema-resolved section holds a volatile reference under every declared
  // key, so a plain string field reads back as an object. Detect that shape and
  // skip the schema pass instead of feeding references back into it.
  const alreadyResolved = CONFIG_KEYS.some((key) => isVolatileRef(cfg[key]));
  if (!alreadyResolved) {
    for (const key of Object.keys(cfg)) {
      if (!CONFIG_KEYS.includes(key)) {
        throw new Error("TasksConfig: unknown key " + key);
      }
    }
  }
  const resolved = toPlain(alreadyResolved ? cfg : Config(cfg));
  if (typeof resolved.section !== "string" || resolved.section.trim() === "") {
    throw new Error("TasksConfig needs a non-empty string section");
  }
  if (typeof resolved.order !== "number" || !Number.isFinite(resolved.order)) {
    throw new Error("TasksConfig needs a finite number order");
  }
  return resolved;
}
