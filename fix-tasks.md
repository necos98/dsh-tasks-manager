# Fix conformità DSH — task list

> Fonte: verifica conformità del 2026-09-07 contro i plugin ufficiali installati
> (`dsh-tool-fs`, `dsh-tools`, `dsh-system-prompt`, `dsh-settings`, `dsh-commands`, `dsh-workspace`, preset `standard`).
> Wiki di progetto: vuota, nessun standard documentato lì.
> Esecuzione: in ordine P0 → P1 → P2. Verifica ogni task con i comandi in fondo.

## P0 — bloccanti (il plugin non parte senza questi)

- [ ] **FIX-01 — `CONFIG_KEYS` non matcha mai**
  - File: `lib/config.js:14-21`
  - Problema: chiavi scritte come `'"enabled",'` (con virgolette+virgola) → `includes("enabled")` è sempre falso → `resolveConfig` rigetta ogni config esplicita, incluso `cordis.patch.yml:13-17`.
  - Fix: `["enabled","order","allowCommand","section","baseBranch","dshHome"]`.
  - Acceptance: `resolveConfig({enabled:true,order:50,allowCommand:true,baseBranch:""})` non lancia; chiave ignota lancia ancora.

- [ ] **FIX-02 — i 6 tool senza `output { schema, render }` vengono rifiutati**
  - File: `lib/tools.js:42-84`
  - Problema: `tools.register` esige `output.render` (letto in `dsh-tools` installato) → tutti i tool throwano alla registrazione.
  - Fix: riscrivi `makeToolDefinitions` con `defineTool` da `@deepseek-ai/dsh-tools` (modello: `dsh-tool-fs` → `applyReadTool`): `parameters` in forma per-property (`{titolo:{type:"string",required:true}}`), ogni `execute` restituisce un valore strutturato + `output.schema` / `output.render` separati.
  - Acceptance: registrazione dei 6 tool senza throw; `enqueue_task`/`list_tasks` chiamabili.

- [ ] **FIX-03 — `NL` non definito in `list_tasks`**
  - File: `lib/tools.js:53` → `rows.map(fmt).join(NL)`
  - Fix: `join("\n")`.
  - Acceptance: `list_tasks` con ≥1 task non lancia `ReferenceError`.

- [ ] **FIX-04 — handler `/tasks` deve restituire `CommandResult`**
  - File: `lib/index.js:48` → `handler: async () => "use the Tasks panel…"`
  - Problema: `dsh-commands/normalizeResult` esige `{kind:"success"|"error", text?}` → stringa nuda = throw.
  - Fix: `handler: async () => ({ kind: "success", text: "…" })`.
  - Acceptance: invocazione `/tasks` non lancia `must return a CommandResult`.

## P1 — architettura (prima di shippare)

- [ ] **FIX-05 — export `Config` schemastery + allinea peerDeps**
  - File: `lib/index.js`, `lib/config.js`, `package.json:23-27`
  - Problema: manca `export const Config = z.object({...})` come tutti i plugin ufficiali → niente validazione al compose-time. PeerDeps datate (`cordis ^4.0.1`, `dsh-system-prompt ^0.1.1-rc.2` vs installato `^4.0.2` / `0.1.2-rc.1`).
  - Fix: aggiungi `Config` con `@deepseek-ai/schemastery`, usalo in `apply`; allinea peerDeps alle versioni installate.
  - Acceptance: config invalida fallisce al compose con messaggio schemastery, non a runtime.

- [ ] **FIX-06 — `tasksSchema` settings in schemastery, non JSON-Schema grezzo**
  - File: `lib/config.js:66-72`, `lib/index.js:40`
  - Problema: `settings.register("tasks", {type:"object",…})` grezzo; tutti i caller ufficiali passano `z.object(...)` → probabile fallimento al `resolve` interno.
  - Fix: `tasksSchema = z.object({ baseBranch: z.string().default("") })` (o equivalente).
  - Acceptance: `settings.register` non throwa; lettura/override `baseBranch` funzionano.

- [ ] **FIX-07 — check workspace PRIMA della mutazione + binding worker rotto**
  - File: `lib/tools.js:71,77-80`
  - Problemi: (a) `approve_task`/`close_task` mutano il DB e poi verificano `workspace_id` → approve cross-workspace modifica il task altrui prima del `not-found`. (b) `approve_task` lega il task promosso alla sessione chiamante (utente) → `get_my_task` (cerca per `worker_session === mia sessione`) non trova mai niente; manca il flusso "il worker reclama il task".
  - Fix: (a) get + verifica ownership prima di `approve()`/`close()`. (b) disegna e implementa il reclamo worker (es. il worker chiama un tool/bind alla presa in carico) invece di legare alla sessione dell'approvatore.
  - Acceptance: approve cross-workspace non muta nulla; dopo presa in carico, `get_my_task` restituisce il task al worker giusto.

- [ ] **FIX-08 — intake: il "divieto tecnico di scrittura" è falso**
  - File: `presets/taskqueue-intake/agent.cordis.yml:49-70`, `design-tasks-simple.md` §3/§12
  - Problema: l'intake include `dsh-tool-fs` (read+write+edit in blocco) + shell + jobs → può scrivere via fs e via shell. Il ban è solo auspicio, non fisico.
  - Fix (scegliere uno): (a) togli `tool-fs`+shell dall'intake (resta search/grep/glob + git log read-only), oppure (b) implementa la restrizione scoped lato host. Se resta (b) futura, correggi il design §3: "divieto tecnico" oggi non è vero.
  - Acceptance: da sessione intake, ogni tentativo di scrittura file/shell è tecnicamente impossibile (o il design dichiara onestamente il limite).

- [ ] **FIX-09 — preset senza queue-tools reali**
  - File: `presets/taskqueue-intake/agent.cordis.yml:83-87`, `presets/taskqueue-worker/agent.cordis.yml:118-123`
  - Problema: solo righe commentate (`dsh-tasks-manager/intake-tools`, `…/worker-tools`) che il plugin host non pubblica → oggi intake non può chiamare `enqueue_task`, worker non può chiamare `get_my_task`. Decommentare così com'è = mount failure.
  - Fix: decidi architettura (sottoinsiemi scoped esposti dal plugin vs `tools.restrict`/`allow`) e scrivi le righe vere.
  - Acceptance: sessione intake vede `enqueue_task,list_tasks,task_detail`; worker vede `get_my_task,list_tasks,task_detail`; nessuno vede `approve/close` come tool modello.

## P2 — igiene

- [ ] **FIX-10 — lifecycle/effect cleanup**
  - File: `lib/index.js:43-44,52-57`
  - Fix: sposta `closeDb` in `ctx.effect` (il `console.log` su `"ready"`/`"dispose"` non è il pattern ufficiale); registra i tool diretto senza `ctx.effect(() => dispose)` ridondante (come `dsh-tool-fs`).
  - Acceptance: unload plugin chiude il DB senza log rumorosi; nessun doppio-effect.

- [ ] **FIX-11 — igiene repo + preset intake senza compaction**
  - File: `package.json:11-16`, `presets/taskqueue-intake/agent.cordis.yml`
  - Fix: `files` cita `README.md`/`LICENSE` inesistenti → creali o toglili; aggiungi all'intake il gruppo `compaction` con `isolate` come nel worker/`standard`; documenta `order: 50` della section `tasks:policy` (i placement ufficiali sono `TOOL_READ=1100` ecc. — 50 subito dopo la persona è voluto?).
  - Acceptance: `npm pack --dry-run` senza warning; intake ha compaction; order motivato in commento.

- [ ] **FIX-12 — branch clash solo su active|queued + test oltre `queue.js`**
  - File: `lib/queue.js:38-40`, `test/queue.test.js`, `scripts/check.mjs`
  - Problemi: clash-check ignora i branch dei task chiusi → possibile riuso di branch git esistente (design §7/§13 non restringe). Test coprono solo `queue.js` → i 3 bug P0 stavano nel codice non testato.
  - Fix: allinea clash-check al design (o viceversa, esplicito); aggiungi test per config-guard, `tools.js` con store mockato, registrazione `defineTool`.
  - Acceptance: i nuovi test falliscono sul codice pre-fix e passano dopo.

## Verifica (dopo ogni fix)

```powershell
node --test
node scripts/check.mjs
node -e "import('./lib/config.js').then(m=>m.resolveConfig({enabled:true,order:50,allowCommand:true,baseBranch:''})).then(()=>console.log('config OK'))"
```
