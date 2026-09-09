// dsh-tasks-manager — host node (Cordis wiring only).
// Registers: the /tasks command, the English system-prompt section,
// the settings namespace, and the six queue tools. Domain logic lives
// in lib/*.js so it is unit-testable without booting DSH.
// @module dsh-tasks-manager
import { Config, resolveConfig, settingsNamespace, tasksSchema, NS } from "./config.js";
import { createRuntime } from "./runtime.js";
import { makeToolDefinitions } from "./tools.js";
import { createWebHandlers, routeWebCall } from "./web.js";
import { createFinishGate, workerCanFinishOf } from "./finish-toggle.js";
import { spawnForPromotion } from "./spawn.js";
import { resolveDshHome } from "./paths.js";
import { pluginPresetsRoot, syncPluginPresets, userPresetRoot } from "./presets-sync.js";

export const name = "dsh-tasks-manager";
export const inject = ["systemPrompt"];
// Compose-time config schema (resolved by the Cordis loader before apply).
export { Config };

/** RPC channel the browser half calls (connection.rpc.call). */
export const WEB_CHANNEL = "/tasks-queue";

function policyText(state) { return function () { return state.enabled ? state.section : ""; }; }

export function apply(ctx, config) {
  const resolved = resolveConfig(config);
  const state = { enabled: resolved.enabled, section: resolved.section };
  const runtime = createRuntime(resolved);

  // DSH never discovers presets inside third-party plugin directories, so on
  // startup this plugin copies its own presets/taskqueue-* compositions into
  // the user root (<dshHome>/.agent-presets), ALWAYS overwriting: the plugin
  // source is the single authority. Best-effort: a failed copy row warns, it
  // never blocks boot.
  if (resolved.syncPresets) {
    try {
      const home = resolved.dshHome !== "" ? resolved.dshHome : resolveDshHome();
      const outcomes = syncPluginPresets({
        sourceRoot: pluginPresetsRoot(),
        userRoot: userPresetRoot(home),
      });
      for (const o of outcomes) {
        if (o.status === "failed") ctx.logger?.warn("dsh-tasks-manager: preset " + o.id + " not synced: " + o.error);
      }
    } catch (err) {
      ctx.logger?.warn("dsh-tasks-manager: preset sync skipped: " + (err && err.message ? err.message : String(err)));
    }
  }

  // DB closes with the plugin, no log noise (official lifecycle pattern).
  ctx.effect(() => () => { runtime.closeDb(); }, "dsh-tasks-manager: closeDb");

  ctx.inject(["workspaceRegistry"], (registryCtx) => {
    const registry = registryCtx.get("workspaceRegistry");
    if (registry) runtime.workspaceRegistry = registry;
  });

  ctx.systemPrompt.section({ name: "tasks:policy", order: resolved.order, text: policyText(state) });

  ctx.inject(["settings"], (settingsCtx) => {
    settingsCtx.settings.register(settingsNamespace(NS), tasksSchema);
  });

  if (resolved.allowCommand) {
    ctx.inject(["commands"], (commandCtx) => {
      commandCtx.commands.register({ name: "tasks", description: "Task queue: list drafts/queued/active for this workspace", input: { hint: "[list]" }, handler: async () => ({ kind: "success", text: "use the Tasks panel or list_tasks tool" }) });
    });
  }

  // Web RPC channel for the browser half (snapshot/approve/close).
  // Same pattern as dsh-plugin-manager: rpc.handle REQUIRES the options
  // object ({ authority: "loopback" }); without it the route never exists.
  ctx.inject(["connection"], (connectionCtx) => {
    const handlers = createWebHandlers(runtime, { ctx });
    connectionCtx.connection.rpc.handle(
      WEB_CHANNEL,
      async (endpoint, payload) => routeWebCall(handlers, endpoint, payload),
      { authority: "loopback" },
    );
  });

  // tools.register returns the exact disposer; direct registration, no
  // redundant ctx.effect wrapper (official dsh-tool-fs pattern).
  // The host entry wires the real promotion spawner into the tool path:
  // finish_task (worker close) and approve/close (chat command) open the
  // next worker chat on promotion, so no active task ever sits in limbo
  // with no session bound. finish_task visibility follows
  // tasks.workerCanFinish (default false = manual): same gate as the
  // scoped worker entry, resynced live on settings/updated.
  const hostLink = { toolsApi: null, settings: null, gate: null };
  function hostLinkNow() {
    if (hostLink.gate || !hostLink.toolsApi || !hostLink.settings) return;
    hostLink.gate = createFinishGate({
      all: makeToolDefinitions(runtime),
      register: (d) => hostLink.toolsApi.register(d),
      initiallyEnabled: workerCanFinishOf(safeSettingsGet(hostLink.settings)),
      onChange: (cb) => ctx.on("settings/updated", (ns, next) => { if (ns === NS) cb(workerCanFinishOf(next)); }),
    });
    ctx.effect(() => () => { hostLink.gate.dispose(); hostLink.gate = null; }, "dsh-tasks-manager: finishGate");
  }
  function safeSettingsGet(settings) {
    try { return settings.get(NS); } catch { return undefined; }
  }
  ctx.inject(["tools"], (toolsCtx) => {
    runtime.spawnHooks = {
      spawnForPromotion: ({ db, workspace, promoted }) =>
        spawnForPromotion({ ctx, db, workspace, promoted }),
    };
    hostLink.toolsApi = toolsCtx.tools;
    hostLinkNow();
  });
  ctx.inject(["settings"], (settingsCtx) => {
    hostLink.settings = settingsCtx.settings;
    hostLinkNow();
  });
}

export { resolveConfig, settingsNamespace, tasksSchema, NS };
