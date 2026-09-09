// Single responsibility: boot a REAL minimal DSH host and mount the plugin.
// Real services: Cordis Context, SystemPrompt, ToolRuntime, CommandRuntime,
// SettingsProvider (MemorySettings backend). Only seams stubbed:
// workspaceRegistry (FakeRegistry) and the SQLite dir (fresh tmp per boot).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import ToolRuntime from "@deepseek-ai/dsh-tools";
import { CommandRuntime } from "@deepseek-ai/dsh-commands";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import * as plugin from "../../lib/index.js";
import { FakeRegistry } from "./fake-registry.js";
import { MemorySettings } from "./memory-settings.js";

export async function bootHost({ config = {}, workspaces, pluginOverride } = {}) {
  const underTest = pluginOverride ?? plugin;
  const dshHome = mkdtempSync(join(tmpdir(), "dsh-tasks-it-"));
  const ctx = new Context();
  await ctx.plugin(SystemPrompt, {});
  await ctx.plugin(class extends ToolRuntime {}, {});
  await ctx.plugin(CommandRuntime, {});
  await ctx.plugin(MemorySettings, {});
  const registry = await ctx.plugin(FakeRegistry, workspaces === undefined ? {} : { workspaces });
  await ctx.plugin(underTest, {
    enabled: true,
    order: 50,
    allowCommand: true,
    baseBranch: "",
    dshHome,
    ...config,
  });
  return {
    ctx,
    registry,
    dshHome,
    async dispose() {
      await ctx.fiber.dispose();
      rmSync(dshHome, { recursive: true, force: true });
    },
  };
}
