// dsh-tasks-manager - browser half (web).
//
// The GUI the queue was missing: a "Tasks (N)" button in the session header
// utilities (same seat as the jobs list, `conversation.session.header.actions`)
// with a green dot while a task is active, opening a persistent side panel in
// `shell.overlay` with the workspace queue grouped Draft → Queued → Active →
// Closed (closed collapsed behind "show history").
//
// Each card shows #seq (per-workspace visible number) + title + type/state
// badges + branch + truncated spec
// with Expand + timestamps. Drafts offer Approve (direct) + Discard (confirm);
// queued/active offer Close with done|cancelled|failed choice (confirm).
// The panel header carries the per-project queue switch: OFF (paused) hides
// automatic advancement, so every queued card grows a Start button that
// promotes exactly that task. Queued cards also carry ▲/▼ to reorder the queue
// itself (move up/down inside the Queued group); the arrows are disabled at
// the ends and never start anything.
// approve/close/start/setQueueEnabled/move stay USER-ONLY: they travel the
// plugin RPC channel (/tasks-queue via ctx.connection.rpc.call), never model
// tools.
//
// Data: the button reads sessionId + useSessions (running bit for the active
// dot); the panel fetches snapshot/approve/close over the RPC channel with
// the current sessionId and refreshes after every mutation (manual Refresh
// button too). No polling.
//
// The factory is CommonJS-style on purpose: the client bundle is loaded by
// window.__ModuleLoader__ and gets react through require(), not import.
// No build step: this file is served as-is.

window.__ModuleLoader__.load({
  id: "dsh-tasks-manager",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const el = React.createElement;

    /** Locale namespace for the dictionaries below. */
    const NS = "tasksQueue";
    /** RPC channel registered by the host half (lib/index.js WEB_CHANNEL). */
    const CHANNEL = "/tasks-queue";
    /** Closed states, collapsed behind "show history". */
    const CLOSED = ["done", "cancelled", "failed"];
    /** How many closed rows the collapsed history shows. */
    const HISTORY_LIMIT = 10;

    /** One RPC call against the queue channel, unwrapped. */
    async function call(connection, endpoint, payload) {
      const result = await connection.rpc.call(CHANNEL, endpoint, payload ?? {});
      if (!result.ok) {
        const error = new Error(result.error?.message ?? `${endpoint} failed`);
        error.code = result.error?.code;
        throw error;
      }
      return result.value;
    }

    // #region styles (DSW design tokens, credit-meter conventions)
    const cssText =
      "._tskRoot{position:relative;display:inline-flex}" +
      "._tskTrigger{min-height:28px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:0;border-radius:6px;align-items:center;gap:3px;padding:3px 2px;font-size:12px;line-height:18px;display:inline-flex;font:inherit}" +
      "._tskTrigger:hover,._tskTrigger:focus-visible{color:var(--dsw-alias-label-secondary)}" +
      "._tskTriggerDot{flex:none;display:inline-flex}" +
      "._tskCount{margin:0 5px}" +
      "._tskChevron{transition:transform .12s;display:inline-flex;flex:none;color:var(--dsw-alias-label-tertiary)}" +
      "._tskChevronOpen{transform:rotate(180deg)}" +
      "._tskPanel{position:fixed;top:0;right:0;bottom:0;width:400px;max-width:min(420px,100vw - 32px);background:var(--dsw-specific-menu);box-shadow:var(--dsw-elevation-prominent);z-index:200;display:flex;flex-direction:column;border-left:1px solid var(--dsw-alias-border-l1)}" +
      "._tskHead{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid var(--dsw-alias-border-l2)}" +
      "._tskTitle{flex:1;min-width:0;font-size:14px;font-weight:600;line-height:22px;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
      "._tskWs{font-size:11px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}" +
      "._tskIconBtn{appearance:none;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);border-radius:8px;height:30px;padding:0 10px;font-size:12px;cursor:pointer;font:inherit;white-space:nowrap}" +
      "._tskIconBtn:hover{background:var(--dsw-alias-interactive-bg-hover)}" +
      "._tskBody{flex:1;overflow:auto;padding:12px 14px;display:flex;flex-direction:column;gap:14px}" +
      "._tskGroupTitle{margin:0 0 8px;font-size:12px;font-weight:600;line-height:18px;color:var(--dsw-alias-label-secondary);text-transform:uppercase;letter-spacing:.04em}" +
      "._tskList{display:flex;flex-direction:column;gap:10px;margin:0;padding:0;list-style:none}" +
      "._tskCard{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);box-shadow:0 1px 2px rgba(0,0,0,.18);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:8px}" +
      "._tskCardHead{display:flex;align-items:center;gap:8px;min-width:0;max-width:100%;width:100%;overflow:hidden;cursor:pointer;background:0 0;border:0;padding:0;font:inherit;color:inherit;text-align:left}" +
      "._tskCardHeadStatic{display:flex;align-items:center;gap:8px;min-width:0;max-width:100%;width:100%;overflow:hidden}" +
      "._tskCardTitle{flex:1 1 auto;min-width:0;font-size:13px;font-weight:600;line-height:20px;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block}" +
      "._tskId{color:var(--dsw-alias-label-tertiary);font-size:12px;font-variant-numeric:tabular-nums;flex:none;white-space:nowrap}" +
      "._tskBadges{display:flex;gap:6px;align-items:center;flex-wrap:wrap}" +
      "._tskBadge{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}" +
      "._tskBadgeActive{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-brand-primary);border-radius:999px;padding:1px 8px;font-size:11px;font-weight:600;line-height:17px;white-space:nowrap}" +
      "._tskBranch{color:var(--dsw-alias-label-tertiary);font-size:11px;font-family:var(--dsw-font-mono,ui-monospace,monospace);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer}" +
      "._tskSpec{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;white-space:pre-wrap;word-break:break-word}" +
      "._tskExpand{appearance:none;border:0;background:0 0;color:var(--dsw-alias-brand-primary);font-size:12px;cursor:pointer;padding:0;font:inherit;align-self:flex-start}" +
      "._tskMeta{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}" +
      "._tskActions{display:flex;gap:8px;align-items:center;justify-content:flex-end;flex-wrap:wrap}" +
      "._tskSetCard{display:flex;flex-direction:column;gap:10px}" +
      "._tskSetTitle{margin:0;font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary)}" +
      "._tskSetDesc{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}" +
      "._tskSetRow{display:flex;align-items:center;justify-content:space-between;gap:12px}" +
      "._tskSetLabelWrap{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}" +
      "._tskSetLabel{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}" +
      "._tskInput{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);border-radius:8px;height:30px;padding:0 10px;font-size:12px;font:inherit;min-width:0;width:180px}" +
      "._tskTextarea{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);border-radius:8px;min-height:64px;padding:6px 10px;font-size:12px;font:inherit;min-width:0;width:100%;resize:vertical;white-space:pre-wrap}" +
      "._tskSwitch{flex:none;width:38px;height:22px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);cursor:pointer;padding:0;position:relative}" +
      "._tskSwitchOn{background:var(--dsw-alias-state-success-primary);border-color:transparent}" +
      "._tskKnob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:999px;background:var(--dsw-alias-bg-base);transition:left .12s}" +
      "._tskSwitchOn ._tskKnob{left:18px}" +
      "._tskPrimary{appearance:none;border:0;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);border-radius:8px;padding:0 12px;height:30px;font-size:12px;font-weight:600;cursor:pointer;font:inherit;white-space:nowrap}" +
      "._tskGhost{appearance:none;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 12px;height:30px;font-size:12px;cursor:pointer;font:inherit;white-space:nowrap}" +
      "._tskDanger{appearance:none;border:1px solid var(--dsw-alias-state-error-primary);background:transparent;color:var(--dsw-alias-state-error-primary);border-radius:8px;padding:0 12px;height:30px;font-size:12px;cursor:pointer;font:inherit;white-space:nowrap}" +
      "._tskSelect{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;height:30px;font-size:12px;font:inherit;padding:0 8px}" +
      "._tskStatus{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px;margin:0}" +
      "._tskError{display:flex;flex-direction:column;gap:8px;border:1px solid var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent);border-radius:10px;padding:10px 12px}" +
      "._tskErrorText{color:var(--dsw-alias-state-error-primary);font-size:13px;line-height:20px;margin:0;white-space:pre-wrap;word-break:break-word}" +
      "._tskDotW{display:inline-flex;flex:none}" +
      "._tskHistoryBtn{appearance:none;border:0;background:0 0;color:var(--dsw-alias-label-tertiary);font-size:12px;cursor:pointer;padding:4px 2px;font:inherit;align-self:flex-start}" +
      "._tskHistoryBtn:hover{color:var(--dsw-alias-label-secondary)}";
    const tagId = "dsh-tasks-manager/TasksPanel.css";
    if (
      typeof document !== "undefined" &&
      document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null
    ) {
      const tag = document.createElement("style");
      tag.dataset.plugin = "dsh-tasks-manager";
      tag.dataset.pluginCss = tagId;
      tag.textContent = cssText;
      document.head.appendChild(tag);
    }
    // #endregion

    // #region pure helpers (exposed in exports.internals for tests)
    function groupOf(task) {
      if (task.state === "draft") return "draft";
      if (task.state === "queued") return "queued";
      if (task.state === "active") return "active";
      return "closed";
    }

    function groupTasks(tasks) {
      const groups = { draft: [], queued: [], active: [], closed: [] };
      for (const task of tasks) groups[groupOf(task)].push(task);
      return groups;
    }

    function openCount(tasks) {
      let n = 0;
      for (const task of tasks) {
        if (!CLOSED.includes(task.state)) n += 1;
      }
      return n;
    }

    function hasActive(tasks) {
      return tasks.some((task) => task.state === "active");
    }

    function formatTime(iso) {
      if (!iso) return "-";
      try {
        return new Date(iso).toLocaleString();
      } catch {
        return String(iso);
      }
    }
    // #endregion

    // #region dot (working green / attention amber), no external deps
    function Dot({ color, title }) {
      return el("span", {
        className: "_tskDotW",
        title,
        style: {
          width: 8,
          height: 8,
          borderRadius: 999,
          background: color,
          display: "inline-block",
        },
      });
    }
    // #endregion

    // #region reorder buttons (Queued group only)
    // ▲/▼ move a queued task one slot inside the Queued group and never start
    // it. Each arrow is disabled at its own end of the queue (canMoveUp /
    // canMoveDown come from the row position) and while a call is in flight.
    // Renders nothing without onMove, so only the Queued group ever shows them.
    function MoveButtons({ task, busy, onMove, canMoveUp, canMoveDown, t }) {
      if (task.state !== "queued" || typeof onMove !== "function") return null;
      const arrow = (direction, atEnd, enabled) =>
        el(
          "button",
          {
            key: direction,
            type: "button",
            className: "_tskGhost",
            disabled: busy || enabled !== true,
            "aria-label": t(atEnd),
            title: t(atEnd),
            onClick: () => onMove(task, direction),
          },
          direction === "up" ? "▲" : "▼"
        );
      return [arrow("up", "moveUp", canMoveUp), arrow("down", "moveDown", canMoveDown)];
    }
    // #endregion

    // #region task card
    // Drafts render fully open (header is static, body always visible).
    // Every other state renders collapsed: header button toggles the body.
    // queueEnabled === false (paused project) adds the manual Start button on
    // queued cards; the default/unknown value renders no Start (fail-open).
    // Queued cards also get the ▲/▼ reorder buttons (onMove present), each
    // disabled at its end of the queue, plus the "Back to draft" button that
    // pulls the task out of the queue so it becomes revisable again.
    function TaskCard({ task, busy, spawn, onApprove, onDiscard, onClose, onStart, onMove, onUnqueue, canMoveUp, canMoveDown, queueEnabled, t }) {
      const isDraft = task.state === "draft";
      const [collapsed, setCollapsed] = React.useState(!isDraft);
      const [closing, setClosing] = React.useState(false);
      const [outcome, setOutcome] = React.useState("done");
      const spec = task.spec || "";
      const truncated = spec.length > 220 && !collapsed;
      const working = task.state === "active" && task._running === true;
      // Header children as a flat array (no Fragment): the header is a flex
      // <button>, and a Fragment wrapper would break item layout and hide
      // the title. Keys keep React reconciliation stable.
      const head = [
        task.state === "active"
          ? el(Dot, {
              key: "dot",
              color: working
                ? "var(--dsw-alias-state-success-primary)"
                : "var(--dsw-alias-state-warning-primary)",
              title: working ? t("activeWorking") : t("activeAttention"),
            })
          : null,
        el("span", { key: "id", className: "_tskId" }, "#" + (task.seq ?? task.id)),
        el("span", { key: "title", className: "_tskCardTitle", title: task.title }, task.title),
        isDraft
          ? null
          : el(
              "span",
              {
                key: "chev",
                className: "_tskChevron" + (collapsed ? "" : " _tskChevronOpen"),
              },
              "-"
            ),
      ];
      // Body stays a Fragment: it renders inside the <li>, not the button.
      const body = el(
        React.Fragment,
        null,
        el(
          "span",
          { className: "_tskBadges" },
          el("span", { className: "_tskBadge" }, task.type),
          el(
            "span",
            { className: task.state === "active" ? "_tskBadgeActive" : "_tskBadge" },
            task.state
          ),
          working ? el("span", { className: "_tskBadge" }, t("working")) : null
        ),
        task.branch
          ? el(
              "code",
              {
                className: "_tskBranch",
                title: t("branchCopy", { branch: task.branch }),
                onClick: () => {
                  try {
                    if (navigator.clipboard) navigator.clipboard.writeText(task.branch);
                  } catch { /* clipboard is best-effort */ }
                },
              },
              task.branch
            )
          : null,
        spec
          ? el("p", { className: "_tskSpec" }, truncated ? spec.slice(0, 220) + "…" : spec)
          : null,
        spec && spec.length > 220
          ? el(
              "button",
              { type: "button", className: "_tskExpand", onClick: () => setCollapsed((v) => !v) },
              collapsed ? t("showMore") : t("showLess")
            )
          : null,
        el(
          "div",
          { className: "_tskMeta" },
          t("created", { time: formatTime(task.created_at) })
        ),
        task.state === "draft"
          ? el(
              "div",
              { className: "_tskActions" },
              el(
                "button",
                {
                  type: "button",
                  className: "_tskGhost",
                  disabled: busy,
                  onClick: () => onDiscard(task),
                },
                busy ? t("busy") : t("discard")
              ),
              el(
                "button",
                {
                  type: "button",
                  className: "_tskPrimary",
                  disabled: busy,
                  onClick: () => onApprove(task),
                },
                busy ? t("busy") : t("approve")
              )
            )
          : null,
        (task.state === "queued" || task.state === "active") && !closing
          ? el(
              "div",
              { className: "_tskActions" },
              task.state === "queued" && onMove
                ? el(MoveButtons, { task, busy, onMove, canMoveUp, canMoveDown, t })
                : null,
              task.state === "queued" && queueEnabled === false
                ? el(
                    "button",
                    {
                      type: "button",
                      className: "_tskPrimary",
                      disabled: busy,
                      onClick: () => onStart(task),
                    },
                    busy ? t("busy") : t("start")
                  )
                : null,
              task.state === "queued" && typeof onUnqueue === "function"
                ? el(
                    "button",
                    {
                      type: "button",
                      className: "_tskGhost",
                      disabled: busy,
                      onClick: () => onUnqueue(task),
                    },
                    t("unqueue")
                  )
                : null,
              el(
                "button",
                {
                  type: "button",
                  className: "_tskGhost",
                  disabled: busy,
                  onClick: () => setClosing(true),
                },
                t("close")
              )
            )
          : null,
        (task.state === "queued" || task.state === "active") && closing
          ? el(
              "div",
              { className: "_tskActions" },
              el(
                "select",
                {
                  className: "_tskSelect",
                  value: outcome,
                  disabled: busy,
                  onChange: (e) => setOutcome(e.target.value),
                  "aria-label": t("close"),
                },
                el("option", { value: "done" }, "done"),
                el("option", { value: "cancelled" }, "cancelled"),
                el("option", { value: "failed" }, "failed")
              ),
              el(
                "button",
                {
                  type: "button",
                  className: "_tskGhost",
                  disabled: busy,
                  onClick: () => setClosing(false),
                },
                t("cancel")
              ),
              el(
                "button",
                {
                  type: "button",
                  className: "_tskDanger",
                  disabled: busy,
                  onClick: () => onClose(task, outcome),
                },
                busy ? t("busy") : t("closeConfirm")
              )
            )
          : null,
        // Spawn outcome line: worker session on success, reason on failure.
        // The promotion stands either way (failure policy, lib/web.js).
        spawn && spawn.sessionId
          ? el("div", { className: "_tskMeta" }, t("spawnOk", { session: spawn.sessionId }))
          : null,
        spawn && spawn.error
          ? el("div", { className: "_tskErrorText" }, t("spawnFail", { error: spawn.error }))
          : null
      );
      return el(
        "li",
        { style: undefined, className: "_tskCard", "data-task-id": task.id, "data-task-state": task.state },
        isDraft
          ? el("div", { className: "_tskCardHeadStatic" }, head)
          : el(
              "button",
              {
                type: "button",
                className: "_tskCardHead",
                "aria-expanded": !collapsed,
                onClick: () => setCollapsed((v) => !v),
              },
              head
            ),
        isDraft || !collapsed ? body : null
      );
    }
    // #endregion

    // #region panel (overlay lateral persistente)
    // Rendered from the header slot (not shell.overlay) on purpose: the panel
    // needs the session scope (sessionId + useSessions) and overlay is root
    // scope. Positioning is fixed, so it looks and behaves like an overlay.
    function TasksPanel({ sessionId, connection, runningOf, onClosePanel, t }) {
      const [snapshot, setSnapshot] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [busy, setBusy] = React.useState(null);
      const [confirmDiscard, setConfirmDiscard] = React.useState(null);
      const [showHistory, setShowHistory] = React.useState(false);
      // Last spawn outcome per task id: surfaces sendWorkerPrompt failures
      // (e.g. prompt rejected) without rolling back the promotion.
      const [spawnInfo, setSpawnInfo] = React.useState({});

      const refresh = React.useCallback(async () => {
        try {
          const value = await call(connection, "snapshot", { sessionId });
          setSnapshot(value);
          setError(null);
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      }, [connection, sessionId]);

      React.useEffect(() => {
        refresh();
      }, [refresh]);

      const mutate = React.useCallback(
        async (endpoint, key, payload) => {
          setBusy(key);
          setError(null);
          try {
            const value = await call(connection, endpoint, payload);
            // Surface the spawn outcome on the affected card: ok shows the
            // worker session, error shows the reason (promotion stands).
            if (value && value.spawn && (endpoint === "approve" || endpoint === "close" || endpoint === "start")) {
              const ids = [];
              if (value.task && typeof value.task.id === "number") ids.push(value.task.id);
              if (value.promoted && typeof value.promoted.id === "number") ids.push(value.promoted.id);
              if (ids.length > 0) {
                setSpawnInfo((prev) => {
                  const next = { ...prev };
                  for (const id of ids) next[id] = value.spawn;
                  return next;
                });
              }
            }
            await refresh();
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
          } finally {
            setBusy(null);
          }
        },
        [connection, refresh]
      );

      const onApprove = (task) =>
        mutate("approve", "approve:" + task.id, { sessionId, id: task.id });
      const onDiscard = (task) => setConfirmDiscard(task.id);
      const confirmDiscardNow = (task) => {
        setConfirmDiscard(null);
        mutate("close", "close:" + task.id, { sessionId, id: task.id, outcome: "cancelled" });
      };
      const onClose = (task, outcome) =>
        mutate("close", "close:" + task.id, { sessionId, id: task.id, outcome });
      // Manual start: promotes exactly this queued task (the paused path).
      const onStart = (task) =>
        mutate("start", "start:" + task.id, { sessionId, id: task.id });
      // Reorder: only the Queued group passes onMove, so no other group can
      // render the arrows. mutate() refreshes the snapshot, which re-reads the
      // new queued_at order.
      const onMove = (task, direction) =>
        mutate("move", "move:" + task.id, { sessionId, id: task.id, direction });
      // Back to draft: pulls a queued task out of the queue so it can be
      // revised again (Approve/Discard come back on the Draft card). Never
      // promotes, so no worker is spawned; mutate() refresh moves the card
      // into the Draft group.
      const onUnqueue = (task) =>
        mutate("unqueue", "unqueue:" + task.id, { sessionId, id: task.id });
      // Project queue switch. The payload reads the CURRENT snapshot value, so
      // a double click moves the flag once per click, never inverts blindly.
      const onToggleQueue = () => {
        if (snapshot === null) return;
        mutate("setQueueEnabled", "queue", { sessionId, enabled: snapshot.queueEnabled !== true });
      };

      const groups = React.useMemo(
        () => groupTasks(snapshot ? snapshot.tasks : []),
        [snapshot]
      );
      const withRunning = React.useCallback(
        (task) => ({ ...task, _running: runningOf(task) }),
        [runningOf]
      );
      const wsLabel = snapshot && snapshot.workspace
        ? snapshot.workspace.title || snapshot.workspace.path || snapshot.workspace.id
        : "";
      // Finish + merge mode lines under the workspace label: manual
      // (default) means the human closes/merges; automatic means the
      // worker does it on its own.
      const modeLine = snapshot === null
        ? null
        : snapshot.workerCanFinish === true ? t("modeAuto") : t("modeManual");
      const mergeLine = snapshot === null
        ? null
        : snapshot.workerCanMerge === true ? t("mergeAuto") : t("mergeManual");
      // Queue switch state: null until the first snapshot lands (no switch,
      // no line), then true unless the project explicitly paused.
      const queueOn = snapshot === null ? null : snapshot.queueEnabled !== false;
      const queueLine = queueOn === null ? null : queueOn ? t("queueOn") : t("queueOff");

      // movable is true for the Queued group only: it enables the ▲/▼ reorder
      // buttons, whose ends (first/last row) disable one of the two.
      const renderGroup = (title, rows, movable) => {
        if (rows.length === 0) return null;
        return el(
          "section",
          { key: title },
          el("h4", { className: "_tskGroupTitle" }, title + " (" + rows.length + ")"),
          el(
            "ul",
            { className: "_tskList" },
            rows.map((task, index) =>
              el(TaskCard, {
                key: task.id,
                task: withRunning(task),
                busy: busy !== null,
                spawn: spawnInfo[task.id],
                onApprove,
                onDiscard,
                onClose,
                onStart,
                onMove: movable ? onMove : undefined,
                onUnqueue,
                canMoveUp: movable === true && index > 0,
                canMoveDown: movable === true && index < rows.length - 1,
                queueEnabled: queueOn === true,
                t,
              })
            )
          )
        );
      };

      const closedVisible = showHistory
        ? groups.closed
        : groups.closed.slice(-HISTORY_LIMIT);

      return el(
        "div",
        { className: "_tskPanel", role: "dialog", "aria-label": t("panelTitle") },
        el(
          "div",
          { className: "_tskHead" },
          el(
            "div",
            { style: { flex: 1, minWidth: 0 } },
            el("div", { className: "_tskTitle" }, t("panelTitle")),
            wsLabel ? el("div", { className: "_tskWs", title: wsLabel }, wsLabel) : null,
            modeLine ? el("div", { className: "_tskWs", title: modeLine }, modeLine) : null,
            mergeLine ? el("div", { className: "_tskWs", title: mergeLine }, mergeLine) : null,
            queueOn === null
              ? null
              : el(
                  "div",
                  { className: "_tskSetRow" },
                  el(
                    "div",
                    { className: "_tskSetLabelWrap" },
                    el("span", { className: "_tskWs", title: queueLine }, queueLine)
                  ),
                  el(
                    "button",
                    {
                      type: "button",
                      role: "switch",
                      "aria-checked": queueOn,
                      "aria-label": t("queueToggleLabel"),
                      disabled: busy !== null,
                      className: "_tskSwitch" + (queueOn ? " _tskSwitchOn" : ""),
                      onClick: onToggleQueue,
                    },
                    el("span", { className: "_tskKnob" })
                  )
                )
          ),
          el(
            "button",
            { type: "button", className: "_tskIconBtn", disabled: busy !== null, onClick: refresh },
            t("refresh")
          ),
          el(
            "button",
            { type: "button", className: "_tskIconBtn", onClick: onClosePanel, "aria-label": t("closePanel") },
            "✕"
          )
        ),
        el(
          "div",
          { className: "_tskBody" },
          error !== null
            ? el(
                "div",
                { className: "_tskError", role: "alert" },
                el("p", { className: "_tskErrorText" }, error),
                el(
                  "div",
                  { className: "_tskActions" },
                  el(
                    "button",
                    { type: "button", className: "_tskGhost", onClick: refresh },
                    t("retry")
                  )
                )
              )
            : null,
          confirmDiscard !== null
            ? el(
                "div",
                { className: "_tskError", role: "alert" },
                el("p", { className: "_tskErrorText" }, t("discardConfirm", { id: confirmDiscard })),
                el(
                  "div",
                  { className: "_tskActions" },
                  el(
                    "button",
                    {
                      type: "button",
                      className: "_tskGhost",
                      onClick: () => setConfirmDiscard(null),
                    },
                    t("cancel")
                  ),
                  el(
                    "button",
                    {
                      type: "button",
                      className: "_tskDanger",
                      disabled: busy !== null,
                      onClick: () => {
                        const task = (snapshot ? snapshot.tasks : []).find(
                          (row) => row.id === confirmDiscard
                        );
                        if (task) confirmDiscardNow(task);
                        else setConfirmDiscard(null);
                      },
                    },
                    busy !== null ? t("busy") : t("discardConfirmButton")
                  )
                )
              )
            : null,
          snapshot === null && error === null
            ? el("p", { className: "_tskStatus" }, t("loading"))
            : null,
          snapshot !== null && snapshot.tasks.length === 0
            ? el("p", { className: "_tskStatus" }, t("empty"))
            : null,
          renderGroup(t("groupDraft"), groups.draft),
          renderGroup(t("groupQueued"), groups.queued, true),
          renderGroup(t("groupActive"), groups.active),
          groups.closed.length > 0
            ? el(
                "section",
                { key: "closed" },
                el(
                  "h4",
                  { className: "_tskGroupTitle" },
                  t("groupClosed") + " (" + groups.closed.length + ")"
                ),
                el(
                  "ul",
                  { className: "_tskList" },
                  closedVisible.map((task) =>
                    el(TaskCard, {
                      key: task.id,
                      task: withRunning(task),
                      busy: busy !== null,
                      spawn: spawnInfo[task.id],
                      onApprove,
                      onDiscard,
                      onClose,
                      onStart,
                      queueEnabled: queueOn === true,
                      t,
                    })
                  )
                ),
                groups.closed.length > HISTORY_LIMIT
                  ? el(
                      "button",
                      {
                        type: "button",
                        className: "_tskHistoryBtn",
                        onClick: () => setShowHistory((v) => !v),
                      },
                      showHistory ? t("hideHistory") : t("showHistory")
                    )
                  : null
              )
            : null
        )
      );
    }
    // #endregion

    // #region header button (topbar sopra la chat)
    // Hooks rule: useSessions selectors run here at the top level (never
    // inside callbacks). Snapshots are subscribed once and derived below.
    function TasksHeaderAction({ sessionId, useSessions, connection, t }) {
      const [open, setOpen] = React.useState(false);
      const [count, setCount] = React.useState(null);
      const [live, setLive] = React.useState(false);
      const [panelTasks, setPanelTasks] = React.useState([]);

      // useSessions is a guaranteed global standard prop on this session
      // scope (same as the jobs list: no guard, direct top-level call).
      const byId = useSessions((s) => s.byId) ?? {};
      const workerRunning = React.useMemo(() => {
        const map = {};
        for (const id of Object.keys(byId)) {
          if (byId[id] && byId[id].running === true) map[id] = true;
        }
        return map;
      }, [byId]);
      const anyRunning = Object.keys(workerRunning).length > 0;

      // running bit per task -> active dot (design S6: green working while
      // the worker chat runs, amber need_attention while it idles).
      const runningOf = React.useCallback(
        (task) => {
          if (task.state !== "active") return undefined;
          if (task.worker_session) return workerRunning[task.worker_session] === true;
          return anyRunning || undefined;
        },
        [workerRunning, anyRunning]
      );
      const activeWorking = React.useCallback(
        () => panelTasks.some((task) => runningOf(task) === true),
        [panelTasks, runningOf]
      );

      const refreshCount = React.useCallback(async () => {
        try {
          const value = await call(connection, "snapshot", { sessionId });
          setCount(openCount(value.tasks));
          setLive(hasActive(value.tasks));
          setPanelTasks(value.tasks);
        } catch {
          setCount(null);
          setLive(false);
          setPanelTasks([]);
        }
      }, [connection, sessionId]);

      React.useEffect(() => {
        refreshCount();
      }, [refreshCount]);
      React.useEffect(() => {
        if (!open) return;
        refreshCount();
      }, [open, refreshCount]);

      const label =
        count === null ? t("trigger") : t("triggerCount", { count });

      return el(
        "div",
        { className: "_tskRoot" },
        el(
          "button",
          {
            type: "button",
            className: "_tskTrigger",
            "aria-expanded": open,
            "aria-label": label,
            title: label,
            onClick: () => setOpen((v) => !v),
          },
          live
            ? el(
                "span",
                { className: "_tskTriggerDot" },
                el(Dot, {
                  color: activeWorking()
                    ? "var(--dsw-alias-state-success-primary)"
                    : "var(--dsw-alias-state-warning-primary)",
                  title: activeWorking() ? t("activeWorking") : t("activeAttention"),
                })
              )
            : null,
          el("span", { className: "_tskCount" }, label),
          el(
            "span",
            { className: "_tskChevron" + (open ? " _tskChevronOpen" : "") },
            "▾"
          )
        ),
        open
          ? el(TasksPanel, {
              sessionId,
              connection,
              runningOf,
              onClosePanel: () => {
                setOpen(false);
                refreshCount();
              },
              t,
            })
          : null
      );
    }
    // #endregion

    // #region plugin body
    const inject = ["slots", "locale", "connection", "settingsScope"];

    function apply(ctx) {
      const locale = ctx.get("locale");
      if (locale !== undefined) {
        ctx.effect(
          () =>
            locale.register(NS, {
              en: {
                trigger: "Tasks",
                triggerCount: "Tasks ({count})",
                activeRunning: "a task is active",
                panelTitle: "Tasks",
                refresh: "Refresh",
                retry: "Retry",
                loading: "Reading tasks…",
                empty: "No tasks in this workspace yet.",
                groupDraft: "Draft",
                groupQueued: "Queued",
                groupActive: "Active",
                groupClosed: "Closed",
                showHistory: "Show history",
                hideHistory: "Hide history",
                approve: "Approve",
                start: "Start",
                moveUp: "Move up",
                moveDown: "Move down",
                unqueue: "Back to draft",
                queueToggleLabel: "Queue",
                queueOn: "Automatic: approve starts the FIFO head",
                queueOff: "Paused: approve only queues, you start tasks",
                discard: "Discard",
                discardConfirm: "Discard draft #{id}? It will be closed as cancelled.",
                discardConfirmButton: "Discard draft",
                close: "Close",
                closeConfirm: "Confirm close",
                cancel: "Cancel",
                closePanel: "Close tasks panel",
                showMore: "Show more",
                showLess: "Show less",
                created: "created {time}",
                working: "working",
                activeWorking: "worker running",
                activeAttention: "worker idle - needs attention",
                branchCopy: "branch {branch} - click to copy",
                busy: "Working…",
                spawnOk: "worker: {session}",
                spawnFail: "worker spawn failed: {error}",
                modeAuto: "Automatic: the worker closes its task, the queue advances",
                modeManual: "Manual: you close tasks here, the worker only reports ready",
                setTitle: "Tasks",
                setDesc: "One active task per workspace, FIFO promotion. Manual (default): the worker reports ready and you close tasks from the panel. Automatic: the worker closes its own task and the queue advances on its own.",
                setFinishLabel: "Worker closes its own task",
                setMergeLabel: "Worker merges into base (--no-ff)",
                mergeAuto: "Automatic: clean --no-ff merge before closing, abort on any conflict",
                mergeManual: "Manual: the human merges outside, the worker never touches base",
                setBranchLabel: "Base branch",
                setBranchHint: "Empty means auto from origin/HEAD.",
                setBranchPlaceholder: "auto (origin/HEAD)",
                setRulesLabel: "Worker rules",
                setRulesHint: "Appended verbatim to the worker's first message, not to the system prompt.",
                setRulesPlaceholder: "e.g. alla fine del lavoro aggiorna la wiki",
                overridden: "overridden",
                reset: "Reset",
              },
            }),
          "dsh-tasks-manager: dictionaries"
        );
      }

      const connection = ctx.get("connection");
      const slots = ctx.get("slots");
      const settingsScope = ctx.get("settingsScope");
      if (slots !== undefined && connection !== undefined) {
        const t = locale !== undefined ? locale.bind(NS) : (key, params) => {
          if (params && typeof params.count !== "undefined") return `${key} (${params.count})`;
          if (params && typeof params.id !== "undefined") return `${key} #${params.id}`;
          return key;
        };
        // Header button above the chat (header utilities, next to session
        // log): bound to the current session's workspace via sessionId.
        slots.inject("conversation.session.header.utilities", () =>
          slots.register(
            {
              name: "conversation.session.header.utilities",
              id: "tasks-queue",
              order: 20,
              locale: NS,
              inject: () => ({ connection }),
            },
            (props) =>
              el(TasksHeaderAction, {
                sessionId: props.sessionId,
                useSessions: props.useSessions,
                connection: props.connection ?? connection,
                t,
              })
          )
        );
      } else {
        console.warn(
          "[dsh-tasks-manager] slots/connection unavailable - the tasks button will not render"
        );
      }

      // Settings card for the Plugin configuration tab: claims the `tasks`
      // namespace so it renders (a served namespace with no card renders
      // nothing). Direct writes through the bound settings scope.
      if (slots !== undefined && settingsScope !== undefined) {
        const cardT = locale !== undefined ? locale.bind(NS) : (key) => key;
        slots.inject("settings.plugin.item", function* () {
          yield slots.register(
            {
              name: "settings.plugin.item",
              key: TASKS_SETTINGS_NS,
              locale: NS,
              inject: () => ({ settingsScope }),
            },
            (props) =>
              el(TasksSettingsCard, {
                t: cardT,
                settingsScope: props.settingsScope ?? settingsScope,
              })
          );
        });
      } else {
        console.warn(
          "[dsh-tasks-manager] settingsScope unavailable - the tasks settings card will not render"
        );
      }
    }
    // #endregion

    // #region settings card (Plugin configuration tab)
    // The tab dispatches `settings.plugin.item` by namespace: a served
    // namespace with no card renders nothing — which is why Tasks was
    // invisible in Settings. This card claims the `tasks` namespace with
    // direct writes (no staging): switches for workerCanFinish/workerCanMerge,
    // a text field for baseBranch, a textarea for workerRules. Switch OFF
    // unsets (re-inherits the default false); an empty branch/rules unsets
    // (re-inherits ""). Overridden badges read the user layer, exactly like
    // the built-in cards.
    const TASKS_SETTINGS_NS = "tasks";

    function useTasksSettings(settingsScope) {
      const scope = React.useMemo(
        () => settingsScope.bind({ namespace: TASKS_SETTINGS_NS }),
        [settingsScope]
      );
      const [, force] = React.useReducer((v) => v + 1, 0);
      React.useEffect(() => scope.subscribe(() => force()), [scope]);
      return scope;
    }

    function TasksSettingsCard(props) {
      const { t, settingsScope } = props;
      const scope = useTasksSettings(settingsScope);
      const [error, setError] = React.useState(null);
      const [branchDraft, setBranchDraft] = React.useState(null);
      const [rulesDraft, setRulesDraft] = React.useState(null);
      const snap = scope.getSnapshot();
      const ready = snap.status === "ready";
      const writable = ready && snap.writable === true;
      const value = (snap.value !== undefined && snap.value !== null) ? snap.value : {};
      const user = (snap.user !== undefined && snap.user !== null) ? snap.user : {};
      const effectiveFinish = value.workerCanFinish === true;
      const finishOverridden = Object.hasOwn(user, "workerCanFinish");
      const effectiveMerge = value.workerCanMerge === true;
      const mergeOverridden = Object.hasOwn(user, "workerCanMerge");
      const effectiveBranch = typeof value.baseBranch === "string" ? value.baseBranch : "";
      const branchOverridden = Object.hasOwn(user, "baseBranch");
      const branchText = branchDraft !== null ? branchDraft : effectiveBranch;
      const effectiveRules = typeof value.workerRules === "string" ? value.workerRules : "";
      const rulesOverridden = Object.hasOwn(user, "workerRules");
      const rulesText = rulesDraft !== null ? rulesDraft : effectiveRules;

      const write = async (fn) => {
        setError(null);
        try {
          await fn();
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      };
      const toggleFinish = () => {
        if (!writable) return;
        // ON sets true; OFF unsets so the field re-inherits the default.
        write(() => (effectiveFinish ? scope.unset("workerCanFinish") : scope.set("workerCanFinish", true)));
      };
      const commitBranch = () => {
        if (branchDraft === null || !writable) return;
        const trimmed = branchDraft.trim();
        setBranchDraft(null);
        write(() => (trimmed === "" ? scope.unset("baseBranch") : scope.set("baseBranch", trimmed)));
      };
      const resetFinish = () => { if (writable) write(() => scope.unset("workerCanFinish")); };
      const toggleMerge = () => {
        if (!writable) return;
        write(() => (effectiveMerge ? scope.unset("workerCanMerge") : scope.set("workerCanMerge", true)));
      };
      const resetMerge = () => { if (writable) write(() => scope.unset("workerCanMerge")); };
      const resetBranch = () => { if (writable) { setBranchDraft(null); write(() => scope.unset("baseBranch")); } };
      const commitRules = () => {
        if (rulesDraft === null || !writable) return;
        const text = rulesDraft;
        setRulesDraft(null);
        // Verbatim: no trim — whitespace-only unsets (re-inherits "").
        write(() => (text.trim() === "" ? scope.unset("workerRules") : scope.set("workerRules", text)));
      };
      const resetRules = () => { if (writable) { setRulesDraft(null); write(() => scope.unset("workerRules")); } };

      return el(
        "div",
        { className: "_tskSetCard" },
        el("div", { className: "_tskSetTitle" }, t("setTitle")),
        el("p", { className: "_tskSetDesc" }, t("setDesc")),
        error ? el("p", { className: "_tskErrorText", role: "alert" }, error) : null,
        !ready ? el("p", { className: "_tskMeta" }, t("loading")) : el(
          React.Fragment,
          null,
          el(
            "div",
            { className: "_tskSetRow" },
            el(
              "div",
              { className: "_tskSetLabelWrap" },
              el("span", { className: "_tskSetLabel" }, t("setFinishLabel")),
              el("span", { className: "_tskMeta" }, effectiveFinish ? t("modeAuto") : t("modeManual")),
              finishOverridden ? el("span", { className: "_tskBadge" }, t("overridden")) : null
            ),
            el(
              "button",
              {
                type: "button",
                role: "switch",
                "aria-checked": effectiveFinish,
                "aria-label": t("setFinishLabel"),
                disabled: !writable,
                className: "_tskSwitch" + (effectiveFinish ? " _tskSwitchOn" : ""),
                onClick: toggleFinish,
              },
              el("span", { className: "_tskKnob" })
            )
          ),
          finishOverridden
            ? el("button", { type: "button", className: "_tskExpand", onClick: resetFinish, disabled: !writable }, t("reset"))
            : null,
          el(
            "div",
            { className: "_tskSetRow" },
            el(
              "div",
              { className: "_tskSetLabelWrap" },
              el("span", { className: "_tskSetLabel" }, t("setMergeLabel")),
              el("span", { className: "_tskMeta" }, effectiveMerge ? t("mergeAuto") : t("mergeManual")),
              mergeOverridden ? el("span", { className: "_tskBadge" }, t("overridden")) : null
            ),
            el(
              "button",
              {
                type: "button",
                role: "switch",
                "aria-checked": effectiveMerge,
                "aria-label": t("setMergeLabel"),
                disabled: !writable,
                className: "_tskSwitch" + (effectiveMerge ? " _tskSwitchOn" : ""),
                onClick: toggleMerge,
              },
              el("span", { className: "_tskKnob" })
            )
          ),
          mergeOverridden
            ? el("button", { type: "button", className: "_tskExpand", onClick: resetMerge, disabled: !writable }, t("reset"))
            : null,
          el(
            "div",
            { className: "_tskSetRow" },
            el(
              "div",
              { className: "_tskSetLabelWrap" },
              el("span", { className: "_tskSetLabel" }, t("setBranchLabel")),
              el("span", { className: "_tskMeta" }, t("setBranchHint")),
              branchOverridden ? el("span", { className: "_tskBadge" }, t("overridden")) : null
            ),
            el("input", {
              className: "_tskInput",
              value: branchText,
              disabled: !writable,
              placeholder: t("setBranchPlaceholder"),
              onChange: (e) => setBranchDraft(e.target.value),
              onBlur: commitBranch,
              onKeyDown: (e) => { if (e.key === "Enter") commitBranch(); if (e.key === "Escape") setBranchDraft(null); },
            })
          ),
          branchOverridden
            ? el("button", { type: "button", className: "_tskExpand", onClick: resetBranch, disabled: !writable }, t("reset"))
            : null,
          el(
            "div",
            { className: "_tskSetRow" },
            el(
              "div",
              { className: "_tskSetLabelWrap" },
              el("span", { className: "_tskSetLabel" }, t("setRulesLabel")),
              el("span", { className: "_tskMeta" }, t("setRulesHint")),
              rulesOverridden ? el("span", { className: "_tskBadge" }, t("overridden")) : null
            ),
            el("textarea", {
              className: "_tskTextarea",
              value: rulesText,
              disabled: !writable,
              placeholder: t("setRulesPlaceholder"),
              rows: 3,
              onChange: (e) => setRulesDraft(e.target.value),
              onBlur: commitRules,
              onKeyDown: (e) => { if (e.key === "Escape") setRulesDraft(null); },
            })
          ),
          rulesOverridden
            ? el("button", { type: "button", className: "_tskExpand", onClick: resetRules, disabled: !writable }, t("reset"))
            : null
        )
      );
    }
    // #endregion

    exports.internals = {
      CHANNEL,
      CLOSED,
      HISTORY_LIMIT,
      groupOf,
      groupTasks,
      openCount,
      hasActive,
      formatTime,
    };
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
