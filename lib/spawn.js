// dsh-tasks-manager — worker spawn (host wiring, no pure domain).
//
// When a promotion moves a task to active, the queue alone cannot start any
// work: SOMETHING must open the worker chat. This module does it: it creates
// a session on the taskqueue-worker preset in the task's workspace, binds
// worker_session immediately (no lazy race), titles it, and sends the initial
// prompt so the worker starts on its own in background.
//
// Why host-direct (agents.create + agent.followup) instead of the subagents
// tool: approve/close are USER-ONLY entry points (panel RPC, chat command),
// never a model turn — there is no parent Agent to delegate from. The plugin
// owns the lifecycle from the approval moment.
//
// Failure policy: spawn runs async AFTER the queue mutation commits. If the
// spawn fails, the task stays active (the promotion is the truth) and the
// error is logged + returned in the RPC payload as spawnError; the user can
// open a worker chat manually and get_my_task still binds it.
import { bindSession, get } from "./queue.js";
import { workerCanFinishOf, workerCanMergeOf, workerModelOf, workerRulesOf, TASKS_NS } from "./finish-toggle.js";

/** Agent preset the worker chat runs on (synced by presets-sync.js). */
export const WORKER_PRESET = "taskqueue-worker";

/**
 * Read the finish/merge modes from the plugin ctx settings (safe on any
 * missing piece: unknown means manual). The worker cannot read settings
 * itself, so the spawn message must TELL it the modes — otherwise it
 * guesses (usually "no merge") and the toggle looks broken.
 */
export function modesOfCtx(ctx) {
  try {
    const settings = ctx && typeof ctx.get === "function" ? ctx.get("settings") : undefined;
    const value = settings && typeof settings.get === "function" ? settings.get(TASKS_NS) : undefined;
    return { workerCanFinish: workerCanFinishOf(value), workerCanMerge: workerCanMergeOf(value), workerRules: workerRulesOf(value), workerModel: workerModelOf(value) };
  } catch {
    return { workerCanFinish: false, workerCanMerge: false, workerRules: "", workerModel: "" };
  }
}

/** Initial prompt sent to the fresh worker so it starts on its own. */
export function workerPrompt(task, modes) {
  // Visible per-workspace number (seq) in prose; the branch line carries the
  // exact git branch either way.
  const num = task.seq ?? task.id;
  const canMerge = !!(modes && modes.workerCanMerge === true);
  const canFinish = !!(modes && modes.workerCanFinish === true);
  // User-defined rules: verbatim, own labelled section AFTER the mode lines
  // and BEFORE the startup liturgy. Empty/blank -> no section, so the prompt
  // stays byte-identical to the no-rules shape.
  const rawRules = modes && typeof modes.workerRules === "string" ? modes.workerRules : "";
  const rules = rawRules.trim() === "" ? "" : rawRules;
  const lines = [
    "You are the worker for task #" + num + " (" + task.title + ").",
    "Queue modes for this task: auto-merge is " + (canMerge ? "ON" : "OFF") + "; self-finish is " + (canFinish ? "ON" : "OFF") + ".",
    canMerge
      ? "Auto-merge is ON: merge your branch into the base with --no-ff per the ## Auto-merge section BEFORE closing; any conflict aborts the merge and you report it and wait."
      : "Auto-merge is OFF: NEVER touch the base branch — open the PR and let the human merge outside.",
    canFinish
      ? "Self-finish is ON: close your task with finish_task when done."
      : "Self-finish is OFF: do NOT close anything — report ready/merged and wait for the human to close the task from the panel.",
  ];
  if (rules !== "") {
    lines.push(
      "Additional user-defined rules (follow them, they do not override the queue modes above):",
      rules
    );
  }
  lines.push(
    "Read it with get_my_task, then follow your startup liturgy:",
    "work on branch " + (task.branch || ("task/" + num + "-" + task.slug)) + " in this checkout, run the suite if one exists, push, and report ready.",
  );
  return lines.join("\n");
}

/**
 * Shared post-promotion step: open the worker chat for the promoted task.
 * The queue mutation already committed; a spawn failure must never roll it
 * back — the task stays active and the error is returned as { error } so
 * the caller can surface it (RPC payload or tool render) without losing
 * the promotion. Re-reads the promoted row and no-ops when it is missing
 * or no longer active (stale promotion).
 * @param deps.ctx - plugin ctx (needs agents, sessions, workspaceRegistry...).
 * @param deps.db - SQLite handle.
 * @param deps.workspace - { id, path } of the owning workspace.
 * @param deps.promoted - the { id } promotion payload from queue approve/close.
 * @returns { sessionId } on success, { error } on spawn failure, undefined when nothing to spawn.
 */
export async function spawnForPromotion({ ctx, db, workspace, promoted }) {
  if (!promoted || typeof promoted.id !== "number") return undefined;
  const active = get(db, promoted.id);
  if (!active || active.state !== "active") return undefined;
  try {
    const r = await spawnWorker({ ctx, db, workspace, task: active });
    return { sessionId: r.sessionId };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Spawn the worker chat for an active task.
 * @param deps.ctx - plugin ctx (needs agents, sessions, workspaceRegistry...).
 * @param deps.db - SQLite handle.
 * @param deps.workspace - { id, path } of the owning workspace.
 * @param deps.task - the freshly promoted active row.
 * @returns { sessionId } — throws on spawn failure (caller logs, keeps task).
 */
export async function spawnWorker({ ctx, db, workspace, task }) {
  const agents = ctx.get("agents");
  if (!agents) throw new Error("tasks: agents service unavailable (cannot spawn worker)");
  const registry = ctx.get("workspaceRegistry");
  const presets = ctx.get("agentPresets");

  // Session identity: caller-supplied, so the chat is an ordinary session.
  const sessionId = "session-" + randomId();
  const cwd = workspace.path || undefined;

  // Meta: workspace location + starting preset (recorded in the header).
  // composeAgent honors meta.agentPreset on create through the api-session
  // path; when creating direct, mount the preset in setup instead.
  let agentPreset = WORKER_PRESET;
  try {
    if (presets && typeof presets.resolve === "function") {
      agentPreset = (await presets.resolve(WORKER_PRESET)).id;
    }
  } catch {
    agentPreset = WORKER_PRESET;
  }

  const handle = await agents.create({
    // provider/model come from the deployment default (same as the
    // api-session create path): without them {{model}} has no value and the
    // worker's first assembly throws. agentPreset rides meta + setup mount.
    sessionId,
    agentOptions: defaultRoute(ctx),
    meta: { ...(cwd ? { cwd } : {}), agentPreset },
    setup: async (agentCtx) => {
      if (presets && typeof presets.mount === "function") {
        await presets.mount(agentCtx, agentPreset);
      }
    },
  });

  try {
    // Attach the session to the workspace so it shows under the right group.
    if (registry && typeof registry.get === "function") {
      const ws = registry.get(workspace.id);
      if (ws && typeof ws.attachSession === "function") {
        await ws.attachSession(sessionId);
      }
    }
  } catch {
    // Attachment is cosmetic; the chat still works without it.
  }

  try {
    const titles = ctx.get("sessionTitle");
    if (titles && typeof titles.rename === "function") {
      titles.rename(handle.agent.session, "task #" + (task.seq ?? task.id) + " " + task.title);
    }
  } catch {
    // Title is cosmetic.
  }

  // Bind BEFORE the first prompt: the worker's get_my_task finds its own
  // session already bound (no lazy race with a second reader).
  bindSession(db, task.id, sessionId);

  // Initial prompt through the official session prompt path (createUserMessage
  // + admitPromptContent + followup). NEVER construct the inbox message by
  // hand: a hand-built { role, content, source } without createMessage's
  // brandString(randomUUID()) id persists an id-less user/message that reads
  // fine live but fails load-time validation after restart ("session event
  // at seq N lacks an identified message") and corrupts the chat history.
  await sendWorkerPrompt(ctx, handle.agent, sessionId, workerPrompt(task, modesOfCtx(ctx)));

  return { sessionId };
}

/**
 * Send the worker's initial prompt as an identified message + followup.
 * Uses createUserMessage (brandString(randomUUID()) id) directly on the live
 * agent handle from agents.create — no remote wrapper, no caller signal.
 * (The ctx.sessionController.prompt remote face requires a caller signal
 * the plugin does not own; calling it bare throws on signal.throwIfAborted.)
 * NEVER construct the inbox message by hand: a hand-built { role, content,
 * source } without an id persists an id-less user/message that reads fine
 * live but fails load-time validation after restart ("session event at seq
 * N lacks an identified message") and corrupts the chat history.
 */
async function sendWorkerPrompt(ctx, agent, sessionId, text) {
  const identified = await identifiedUserMessage(text);
  agent.followup(identified);
  void ctx;
  void sessionId;
}

// Build an identified user message the same way the prompt path does.
// Falls back to a local UUID when dsh-llm is unreachable (never id-less).
async function identifiedUserMessage(text) {
  const content = [{ type: "text", text }];
  const source = { kind: "user" };
  try {
    const llm = await import("@deepseek-ai/dsh-llm");
    const create =
      llm.createUserMessage ||
      (llm.default && llm.default.createUserMessage);
    if (typeof create === "function") return create({ content, source });
  } catch { /* fall through to the local fallback */ }
  return identifiedFallback(content, source);
}

function identifiedFallback(content, source) {
  let id = "tasks-" + String(Date.now().toString(36));
  try {
    const c = globalThis.crypto;
    if (c && typeof c.randomUUID === "function") id = c.randomUUID();
  } catch { /* keep the timestamp id */ }
  return { id, role: "user", content, source };
}

function randomId() {
  try {
    const c = globalThis.crypto;
    if (c && typeof c.randomUUID === "function") return c.randomUUID();
  } catch { /* fall through */ }
  return String(Date.now().toString(36)) + Math.floor(Math.random() * 0xffffffff).toString(36);
}

// Default LLM route (provider/model[/reasoningEffort]) for the worker agent.
// Same source the api-session create path uses: without provider+model the
// {{provider}}/{{model}} prompt variables have no value and the worker's
// first assembly throws. Falls back to {} (factory defaults) when the
// service is absent.
function defaultRoute(ctx) {
  try {
    const sel = ctx.get("agentDefaultModel");
    const settings = ctx.get("settings");
    const settingsValue = settings && typeof settings.get === "function"
      ? settings.get(TASKS_NS) : undefined;
    const override = workerModelOf(settingsValue);
    if (sel && typeof sel.currentSelection === "function") {
      const { provider, model, reasoningEffort } = sel.currentSelection();
      return {
        ...(provider ? { provider } : {}),
        ...(override ? { model: override } : (model ? { model } : {})),
        ...(reasoningEffort ? { reasoningEffort } : {}),
      };
    }
    if (override) return { model: override };
  } catch { /* fall through to factory defaults */ }
  return {};
}
