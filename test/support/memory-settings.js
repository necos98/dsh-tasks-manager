// Single responsibility: in-memory settings service double for tests.
//
// Production settings is `dsh-settings`' SettingsForms (DSH 0.1.7-rc.2): the
// host reads a live namespace through `describe()` (there is no `get(ns)`),
// looks the namespace up by the profile entry id, and refreshes on the
// `settings/document-updated` event. This double implements exactly that
// surface, so the host code under test takes the production path.
//
// An external edit in a test is `settings.publish({ ns: section })`, which
// re-resolves the namespace and emits the same invalidation the real service
// emits.
import { Service } from "@deepseek-ai/cordis";

/** Namespace this plugin's settings live under (the patch row id). */
export const TASKS_SETTINGS_NS = "dsh-tasks-manager";

export class MemorySettings extends Service {
  /**
   * @param ctx The owning Cordis context.
   * @param config.settingsDefaults Value the plugin's namespace resolves to
   *   before any external edit. Production resolves it from the entry's Config
   *   schema; the double is seeded with the same defaults by bootHost(), so the
   *   tests still assert the resolved namespace rather than `undefined`.
   */
  constructor(ctx, config = {}) {
    super(ctx, "settings");
    this.defaults = config.settingsDefaults;
    this.overrides = {};
    this.writable = true;
    this.documentPath = "(memory)";
  }

  /** Read active plugin schemas and their live values (production shape). */
  describe() {
    const namespaces = { ...(this.defaults ? { [TASKS_SETTINGS_NS]: this.defaults } : {}) };
    for (const [ns, section] of Object.entries(this.overrides)) {
      namespaces[ns] = { ...(namespaces[ns] ?? {}), ...section };
    }
    return Object.entries(namespaces).map(([ns, value]) => ({
      ns,
      autoGenerate: true,
      schema: { type: "object", dict: {} },
      value,
      base: this.defaults,
      user: value,
      applies: "live",
      revision: 1,
    }));
  }

  /** Replace one namespace's user section and emit the invalidation. */
  publish(patch) {
    for (const [ns, section] of Object.entries(patch)) {
      this.overrides[ns] = { ...section };
      this.ctx.emit("settings/document-updated", ns, 1);
    }
  }

  /** Field writes go through the same publish path in this double. */
  async mutate(ns, ops) {
    const next = { ...(this.overrides[ns] ?? this.defaults ?? {}) };
    for (const op of ops) {
      if (op.op === "set") next[op.path[op.path.length - 1]] = op.value;
      else delete next[op.path[op.path.length - 1]];
    }
    this.publish({ [ns]: next });
  }

  async update(ns, patch) {
    this.publish({ [ns]: { ...(this.overrides[ns] ?? this.defaults ?? {}), ...patch } });
  }

  async replace(ns, section) {
    this.publish({ [ns]: { ...section } });
  }
}

export default MemorySettings;
