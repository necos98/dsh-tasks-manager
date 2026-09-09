// dsh-tasks-manager — worker spawn (host wiring, no pure domain).
//
// When approve promotes a task to active, the queue alone cannot start any
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
import { bindSession } from "./queue.js";

/** Agent preset the worker chat runs on (synced by presets-sync.js). */
export const WORKER_PRESET = "taskqueue-worker";

/** Initial prompt sent to the fresh worker so it starts on its own. */
export function workerPrompt(task) {
  return [
    "You are the worker for task #" + task.id + " (" + task.title + ").",
    "Read it with get_my_task, then follow your startup liturgy:",
    "work on branch " + (task.branch || ("task/" + task.id + "-" + task.slug)) + " in this checkout, run the suite if one exists, push, and report ready.",
  ].join("\n");
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
      titles.rename(handle.agent.session, "task #" + task.id + " " + task.title);
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
  await sendWorkerPrompt(ctx, handle.agent, sessionId, workerPrompt(task));

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
    if (sel && typeof sel.currentSelection === "function") {
      const { provider, model, reasoningEffort } = sel.currentSelection();
      return {
        ...(provider ? { provider } : {}),
        ...(model ? { model } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {}),
      };
    }
  } catch { /* fall through to factory defaults */ }
  return {};
}
