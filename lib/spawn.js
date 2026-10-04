// dsh-tasks-manager — worker spawn (host wiring, no pure domain).
//
// When a promotion moves a task to active, the queue alone cannot start any
// work: SOMETHING must open the worker chat. This module does it: it creates
// a session on the worker preset in the task's workspace, binds
// worker_session immediately (no lazy race), titles it, and sends the initial
// prompt so the worker starts on its own in background.
//
// WHICH worker preset is decided by the task's provenance, in one place
// (workerPresetForTask): a draft filed by the Team Task Intake preset is
// executed by the Team Task Worker, every other task by the solo worker.
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
import { bindSession, ensureWorkspace, get, getWorkspaceRules } from "./queue.js";
import { DEFAULT_GIT_MODE, DEFAULT_MESSAGE_STYLE, GIT_MODES, MESSAGE_STYLES, commitLanguageOf, messageStyleOf, workerCanFinishOf, workerGitModeOf, workerModelOf, TASKS_NS } from "./finish-toggle.js";
import { settingsValueOf } from "./config.js";

/** Agent preset the worker chat runs on (declared by presets/taskqueue-worker.patch.yml). */
export const WORKER_PRESET = "taskqueue-worker";
/** Agent preset that executes ONE task as a team (presets/taskqueue-team-worker.patch.yml). */
export const TEAM_WORKER_PRESET = "taskqueue-team-worker";
/** The intake preset whose filed drafts a TEAM executes (presets/taskqueue-team-intake.patch.yml). */
export const TEAM_INTAKE_PRESET = "taskqueue-team-intake";

/**
 * The ONE routing rule, shared by the spawn and the prompt: a task filed by
 * the Team Task Intake preset is executed by a team, everything else (an empty
 * or unknown origin, e.g. every row predating schema v8) by the solo worker.
 * Both call sites read this, so the mounted preset and the line the worker is
 * told about can never disagree.
 */
export function isTeamTask(task) {
  return !!task && task.origin_preset === TEAM_INTAKE_PRESET;
}

// Worker preset id for a task: the same predicate as the prompt's team-mode
// line, so the chat mounts exactly the surface its instructions describe.
function workerPresetForTask(task) {
  return isTeamTask(task) ? TEAM_WORKER_PRESET : WORKER_PRESET;
}

/**
 * Read the finish/git modes from the plugin ctx settings (safe on any
 * missing piece: unknown means manual + branch-automerge). The worker
 * cannot read settings itself, so the spawn message must TELL it the
 * modes — otherwise it guesses (usually "no merge") and the switch looks
 * broken.
 */
export function modesOfCtx(ctx) {
  try {
    const settings = ctx && typeof ctx.get === "function" ? ctx.get("settings") : undefined;
    const value = settingsValueOf(settings, TASKS_NS);
    return { workerCanFinish: workerCanFinishOf(value), workerGitMode: workerGitModeOf(value), commitLanguage: commitLanguageOf(value), messageStyle: messageStyleOf(value), workerModel: workerModelOf(value) };
  } catch {
    return { workerCanFinish: false, workerGitMode: DEFAULT_GIT_MODE, commitLanguage: "English", messageStyle: DEFAULT_MESSAGE_STYLE, workerModel: "" };
  }
}

// Resolve the workspace row id for the spawn's path mapping (same canonical
// mapping as lib/tools.js ctxOf / lib/web.js workspaceCtx: registry path, or
// "ws:<id>" when the workspace has no path). Fail-open: any failure yields
// null (no rules section) instead of failing the spawn.
function workspaceRowIdOfDb(db, workspace) {
  try {
    if (!db || !workspace) return null;
    const path = typeof workspace.path === "string" && workspace.path !== "" ? workspace.path : (workspace.id !== undefined && workspace.id !== null ? "ws:" + String(workspace.id) : "");
    if (path === "") return null;
    return ensureWorkspace(db, path);
  } catch {
    return null;
  }
}

// Read the per-workspace project rules for the spawn prompt. Fail-open: a
// missing row/column or any read failure yields "" (no rules section).
export function workspaceRulesOfDb(db, workspaceId) {
  try {
    if (!db || workspaceId === undefined || workspaceId === null) return "";
    return getWorkspaceRules(db, workspaceId);
  } catch {
    return "";
  }
}

/**
 * The trailing liturgy line for the branch-automerge mode (branch + PR +
 * mandatory auto-merge). Kept as the default shape: identical to the
 * pre-modes prompt minus the removed ON/OFF merge line.
 */
function branchAutomergeLiturgy(task, num) {
  return "Read it with get_my_task, then follow your startup liturgy: "
    + "work on branch " + (task.branch || ("task/" + num + "-" + task.slug)) + " in this checkout, run the suite if one exists, push, open the PR, merge it per ## Auto-merge, and report merged.";
}

// Shared in-place liturgy core: stay on the current branch, dirty-tree stop,
// grouped `git commit` commits with the ` (task #N)` suffix convention.
// The commit language comes from the spawn's language line (no hardcode).
function inPlaceLiturgy(num, pushLine, lang) {
  const language = typeof lang === "string" && lang.trim() !== "" ? lang.trim() : "English";
  return [
    "Stay on the CURRENT branch, NEVER create/checkout another branch, NEVER fetch/checkout base, NEVER open a PR, NEVER merge" + (pushLine === "" ? ", NEVER push." : "."),
    "First run git status --porcelain: if non-empty STOP, list file names only, ask via ask_user_question and wait (never stash, never commit foreign changes, never `checkout -- .`).",
    "Then work, grouping changes into logical commits with `git commit` only. Commit message convention: imperative short summary of the applied change in " + language + " + ` (task #" + num + ")` suffix, e.g. `fix login null guard (task #" + num + ")`. One commit per logical group.",
    pushLine,
  ].filter((line) => line !== "").join("\n");
}

/** Initial prompt sent to the fresh worker so it starts on its own. */
export function workerPrompt(task, modes) {
  // Visible per-workspace number (seq) in prose; the branch line carries the
  // exact git branch either way.
  const num = task.seq ?? task.id;
  const rawMode = modes && modes.workerGitMode;
  const gitMode = GIT_MODES.includes(rawMode) ? rawMode : DEFAULT_GIT_MODE;
  const canFinish = !!(modes && modes.workerCanFinish === true);
  // Commit/PR language: free text, empty/blank reads as "English".
  const rawLang = modes && typeof modes.commitLanguage === "string" ? modes.commitLanguage : "";
  const lang = rawLang.trim() === "" ? "English" : rawLang.trim();
  // Message style: minimal (one-line commits, short PRs) or extended
  // (subject + body, sectioned PRs). Unknown reads as extended.
  const rawStyle = modes && modes.messageStyle;
  const style = MESSAGE_STYLES.includes(rawStyle) ? rawStyle : DEFAULT_MESSAGE_STYLE;
  const styleLine = style === "minimal"
    ? "Message style is minimal: one-line commits (`<imperative summary> (task #" + num + ")`), PR title + max 2-line body, no sections."
    : "Message style is extended: commit subject + body (what/why), PR with What/Verified/Notes sections.";
  // Per-workspace project rules: verbatim, own labelled section AFTER the
  // mode lines and BEFORE the startup liturgy. Empty/blank -> no section,
  // so the prompt stays byte-identical to the no-rules shape.
  const rawRules = modes && typeof modes.workspaceRules === "string" ? modes.workspaceRules : "";
  const rules = rawRules.trim() === "" ? "" : rawRules;
  const lines = [
    "You are the worker for task #" + num + " (" + task.title + ").",
    "Git mode for this task is " + gitMode + ".",
    // Team mode: the SAME predicate that picked the mounted preset, so the
    // worker is told the truth about the surface it has (the team-worker
    // persona reads this line as authoritative, like the git-mode one).
    isTeamTask(task) ? "Team mode for this task is ON." : "Team mode for this task is OFF.",
    "Commit/PR language: " + lang + ".",
    styleLine,
    gitMode === "branch-automerge"
      ? "Branch-automerge: work on your task branch, push, open exactly ONE PR branch -> base, then merge it into the base with --no-ff per the ## Auto-merge section BEFORE closing; any conflict aborts the merge and you report it and wait."
      : gitMode === "in-place-push"
        ? "In-place-push: stay on the CURRENT branch and finish with one plain `git push` of it (no --force, no base touch). Push rejected -> STOP, report, wait. Never push before the suite is green (or no suite declared). " + inPlaceLiturgy(num, "At the very end, after the suite is green (or no suite declared), run one plain `git push` of the current branch.", lang)
        : "In-place-local: stay on the CURRENT branch, never push, never open a PR, never merge. " + inPlaceLiturgy(num, "", lang),
    canFinish
      ? "Self-finish is ON: close your task with finish_task when done."
      : "Self-finish is OFF: do NOT close anything — report ready/merged and wait for the human to close the task from the panel.",
  ];
  if (rules !== "") {
    lines.push(
      "Project rules for this workspace (follow them, they do not override the git mode above):",
      rules
    );
  }
  lines.push(
    "Read it with get_my_task, then follow your startup liturgy:",
    gitMode === "branch-automerge" ? branchAutomergeLiturgy(task, num) : "work in place on the CURRENT branch in this checkout, run the suite if one exists, commit grouped changes, and report ready.",
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
  // WHICH preset: the task's own origin (a task filed by the team intake is
  // executed by a team). The wanted id is picked BEFORE the roster resolve so
  // the resolve — and the fallback below it — applies to that same id.
  let agentPreset = workerPresetForTask(task);
  try {
    if (presets && typeof presets.resolve === "function") {
      agentPreset = (await presets.resolve(agentPreset)).id;
    }
  } catch {
    agentPreset = workerPresetForTask(task);
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
  const modes = modesOfCtx(ctx);
  const workspaceRowId = workspaceRowIdOfDb(db, workspace);
  await sendWorkerPrompt(ctx, handle.agent, sessionId, workerPrompt(task, { ...modes, workspaceRules: workspaceRulesOfDb(db, workspaceRowId) }));

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
    const settingsValue = settingsValueOf(ctx.get("settings"), TASKS_NS);
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
