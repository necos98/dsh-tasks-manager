// Single responsibility: a `settings` service double for the many tests that
// only need a live namespace value on a fake ctx.
//
// DSH 0.1.7-rc.2 reads a namespace through `describe()` (one descriptor per
// live entry, keyed by the profile entry id); there is no `get(ns)`. Tests that
// previously passed `{ get: () => value }` use `fakeSettings(value)` instead, so
// they exercise the same read path production uses.
import { SETTINGS_NS } from "../../lib/config.js";

/** Entry id the plugin settings namespace is keyed by. */
export const TASKS_NS = SETTINGS_NS;

/**
 * @param value The namespace value the fake host serves (omit for "not served").
 * @param ns Entry id the value is published under.
 * @returns A minimal `settings` service with `get(ns)` and `describe()`.
 */
export function fakeSettings(value, ns = TASKS_NS) {
  return {
    get(query) {
      return query === ns ? value : undefined;
    },
    describe() {
      if (value === undefined) return [];
      return [
        {
          ns,
          value,
          base: value,
          user: value,
          revision: 1,
          applies: "live",
          autoGenerate: true,
          schema: {},
        },
      ];
    },
  };
}

/**
 * Build the fake ctx the web/spawn tests hand to production: a ctx is an
 * object with a `get(name)` lookup (NOT a bare function), so only `settings`
 * resolves and everything else is absent.
 * @param value The namespace value to serve.
 * @returns An object with `get(name)`.
 */
export function fakeCtxGet(value, ns = TASKS_NS) {
  const settings = fakeSettings(value, ns);
  return { get: (key) => (key === "settings" ? settings : undefined) };
}

/**
 * A ctx whose `get("settings")` resolves a service that answers `get(ns)` —
 * the shape `lib/spawn.js` and `lib/web.js` read through (they resolve the
 * service, then the namespace).
 * @param value The namespace value to serve.
 * @returns An object with `get(name)`.
 */
export function fakeModesCtx(value, ns = TASKS_NS) {
  const settings = fakeSettings(value, ns);
  return { get: (key) => (key === "settings" ? settings : undefined) };
}
