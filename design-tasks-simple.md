# Tasks semplici (sincroni) -- design.md

> Stato: revisionato 2026-09-07, pronto per implementazione. Nessun codice scritto.
> Lingua: italiano. GitHub-only in v1. Il doc gemello design-task-queue.md resta come visione v2 (parallela, rimandata).

## 1. Visione in una frase

**Un task = una chat worker che lavora nel tuo repo e committa. Il plugin fa una cosa sola: gestisce una coda stupida. Tutto il resto è nel system prompt.**

L'intake produce draft, l'utente approva o scarta, la coda promuove un task alla volta in active, il worker esegue sul branch nel tuo checkout, tu fai review e mergi come hai sempre fatto. Il plugin dà struttura (coda, storico) non orchestrazione.

## 2. Cosa il tool fa e NON fa

Il tool fa una cosa sola, deterministica: **gestisce la coda** (draft/queued/active/chiusi, un active per repo, avanzamento FIFO).

Il tool NON fa, per scelta:

- Niente worktree: il worker lavora nel checkout dell'utente.
- Niente merge dal worker o dal plugin, niente rilevamento merge, niente stati di PR: chiusura manuale via UI. Il worker apre UNA PR branch -> base via `gh` e ne riporta l'URL; il merge resta umano e fuori dal plugin.
- Niente controlli git: tree pulito, branch libero, fetch, rebase, push sono disciplina del system prompt, non regole del tool.
- Niente test enforcement, niente contatore tentativi, niente log conservati: se i test falliscono, è l'umano a capirlo e chiudere come vuole.
- Niente scheduler, slot, priorità: solo FIFO banale (il queued più vecchio avanza).

## 3. I due ruoli

| Ruolo | Chi | Può scrivere codice? | Tool |
|---|---|---|---|
| **Triage/Intake** | agente con cui parli | **NO file-write**: preset senza `dsh-tool-fs`/editor (lettura via search grep/glob, git log via shell one-shot); limite dichiarato: la shell one-shot può tecnicamente scrivere, quindi il divieto è assenza tool + approval, non blocco fisico | `enqueue_task`, `list_tasks`, `task_detail` + lettura | **Analista**: capisce la natura della chat (risposta diretta vs task), indaga la root cause read-only, scrive spec eseguibili. Il worker riceve conclusioni, mai lavoro di analisi. |
| **Worker** | un agente per task, nella sua chat | SÌ, nel checkout del repo | dev standard + `get_my_task` (sola lettura) |

Regola rigida: se il triage può scrivere, prima o poi scriverà. Per questo non è una regola nel prompt, è assenza fisica dei tool di scrittura file (nota onesta: la shell one-shot tenuta per git log resta tecnicamente capace di scrivere).

`approve_task` e `close_task` sono **solo utente** (bottoni o comando chat): mai il modello. Il triage ha una sola facoltà: mettere un draft in coda. L'utente decide: approva → entra in queue, non approva → cancelled.

## 4. Cos'è un Task

Campi (backend scrive tutto tranne tipo/titolo/spec che compila il modello via `enqueue_task`):

- `id` intero globale; `workspace` root repo da sessione; `tipo` feature|bug|refactor|chore; `titolo` umano; `slug` congelato alla creazione;
- `spec` markdown libero (problema, acceptance, file sospetti, note test); `branch` derivato `task/<id>-<slug>` (mai colonna libera; suffisso -2, -3 su collisione, vedi S7);
- `worker_session` per sapere quale chat osservare (resume stessa sessione dopo restart); `stato` draft|queued|active|done|cancelled|failed; timestamps backend.

Niente `tentativi`, niente `test_esito`, niente log: il tool non li gestisce.

## 5. La coda (l'unico stato che il tool gestisce)

```
draft → queued → active → done | cancelled | failed
draft → cancelled (utente non approva, scarta diretto)
queued → cancelled | failed | done (utente chiude prima che parta)
```

- `enqueue_task` (solo triage) → crea `draft`. Non occupa niente, non scade mai, niente auto-avvio.
- `approve_task` (solo utente) → `draft → queued` **sempre**. Mai diretto in active, è la regola più stupida possibile.
- Il tool promuove da solo: se lo slot è libero (nessun active sullo stesso workspace), il `queued` più vecchio diventa `active`. Quando l'`active` si chiude, avanza il prossimo `queued`. Solo FIFO.
- `close_task(esito)` (solo utente) → `draft|queued|active → done|cancelled|failed`. I tre terminali sono equivalenti per il tool: liberano lo slot e fanno avanzare la coda, fine. Nessuna semantica dentro, nessuna transizione in uscita. Quale etichetta usare lo decide l'umano guardando la chat.
- Unica regola del tool: **un `active` per workspace**. "Repo occupato" non è un errore: è il caso normale in cui il task resta `queued` e aspetta il suo turno.
- Niente "ho finito" in chat libera: i messaggi non cambiano la coda, solo tool + azioni utente.

## 6. Stato interno (NON lo gestisce il tool)

`working | need_attention` non è salvato nel DB, è **derivato da DSH al momento della lettura**, solo per il pannello:

- sessione worker in esecuzione (l'agente sta facendo le sue cose) → `working`;
- chat ferma (l'agente ha risposto e aspetta) oppure l'agente ha usato `ask_user_question` → `need_attention`.

Il tool non lo scrive, non lo cambia, non gli importa se l'agente ha finito o no. Se la chat è ferma → `need_attention`, punto. Si usa `ask_user_question` nativo di DSH, nessun tool `ask_user` del plugin. Un `active` in `need_attention` tiene comunque lo slot.

## 7. Liturgia worker (system prompt, NON tool)

All'avvio, nel checkout utente: fetch di `origin/<base>`; `checkout -b task/<id>-<slug> origin/<base>`; lavora con commit checkpoint liberi; lancia la suite se esiste (se non esiste, dillo e basta, senza inventare test); `push -u origin` del suo branch; apre UNA PR branch -> base via `gh pr create` e ne riporta l'URL ("pronto: <URL>"). Poi tace.

- Branch suo: `push --force-with-lease` ammesso dopo rebase. Mai touch al base: niente checkout del base dopo avvio, niente merge, niente push sul base.
- Base avanzato mentre lavora: rebase + re-test + force-with-lease; se fallisce → lo dice in chat (→ `need_attention`), il tool non fa niente.
- Tree sporco, branch occupato, push rifiutato, base non rilevabile: non sono errori del tool, sono cose che il worker riporta in chat e l'umano gestisce.

Base branch: rilevato da `origin/HEAD` + override settings. Repo senza origin GitHub: il worker lo dice in chat, l'umano chiude il task.

## 8. Chiusura

**Chiusura (`queued/active → done|cancelled|failed`, oppure `draft → cancelled`):** solo utente, bottone nella card o comando chat (`close_task` con esito). Effetto: timestamp di chiusura + avanzamento coda + notifica. Branch locale/remoto restano come sono: nessuna cancellazione automatica, nessuna `gh pr close`. Mergi e pulisci fuori dal plugin, come hai sempre fatto. `done` = "non mi serve più vederlo", non "verificato mergato": il tool non controlla il merge.

## 9. Cosa vuol dire test verdi

Disciplina del prompt, non del tool: suite presente → deve passare prima di dirsi pronto (il worker la individua da package.json, config standard). Nessuna suite → pronto diretto, detto in chat. Lint/typecheck: stessa logica se configurati. Se i test falliscono ripetutamente, il worker lo dice in chat e l'umano decide (chiude failed, chiede modifiche, ecc.). Il tool non conta niente.

## 10. Le chat: come si vivono

- **Triage:** chiacchiera → capisci la natura della richiesta (risposta diretta vs modifica codice) → analisi read-only approfondita (root cause, punto di inserimento) → 2-5 domande SOLO se ambiguo (`ask_user_question` nativo, senza cambio stato) → `enqueue_task` con spec eseguibile (problema, causa, modifica esatta, acceptance, file, test) → approvazione utente → `queued` (poi `active` quando la coda avanza). Mai delegare l'analisi al worker: lo spec contiene conclusioni, non domande.
- **Worker:** una chat per task, background default, nessuna auto-apertura (solo notifica). A pronto dice "guarda il branch X" e tace. Review = conversazione normale, riprova sullo stesso branch e pusha.
- **Bloccato = `ask_user_question` nativo + notifica** (pannello + chat). Il pannello mostra `need_attention` derivato, la coda non si muove.

## 11. DB e tool

Sqlite globale nel data-dir (WAL attivo; un writer alla volta, concorrenza banale). Tabelle `workspaces(path, base_branch)` + `tasks(id, workspace, tipo, titolo, slug, spec, branch, stato, worker_session, timestamps)`. Query filtrate per workspace. Binding sessione-task persistito in `worker_session` (ricostruito dopo restart, serve solo a sapere quale chat osservare).

Tool (tutti workspace-scoped via sessione, zero path nei parametri):

- `enqueue_task(tipo, titolo, spec)` — solo triage → `draft`;
- `list_tasks`, `task_detail`, `get_my_task` — lettura (l'ultimo solo worker, senza argomenti);
- `approve_task(id)` — solo utente → `draft → queued`;
- `close_task(id, esito)` — solo utente → terminale, libera lo slot, avanza la coda.

Backend autoritativo sulla sola coda, fiducia nel worker per tutto il resto (qualità in review).

## 12. Plugin: tre pezzi + skill

1. Host service `taskQueue`: sqlite, coda FIFO per repo, binding sessioni (lazy: la prima `get_my_task` del worker lega la sessione; nessun claim tool, nessun bind all'approvazione). 2. Preset `taskqueue-intake` (triage, senza tool di scrittura file) e `taskqueue-worker` (full dev nel checkout), in `presets/` di questo repo (sottoinsiemi di standard; i tool taskqueue arrivano dagli entry scoped `dsh-tasks-manager/intake-tools` e `.../worker-tools`; approve/close non sono montati in nessun preset). Nota: `dsh-tool-fs` registra read/write/edit in blocco, quindi l'intake omette sia `dsh-tool-fs` che `str_replace_editor`; il divieto di scrittura file è assenza fisica dei tool + approval policy (la shell one-shot per git log resta tecnicamente capace di scrivere: limite dichiarato, non fisico). 3. Pannello Tasks per workspace: lista (coda, interno derivato, branch), card con Approva/Scarta per i draft e Chiudi (done/cancelled/failed) per queued/active, settings base_branch. Niente PR, checks, merge. 4. Skill intake a 4, router nel prompt. Notifiche (pannello + chat giusta): queued→active, need_attention, chiuso.

## 13. Casi limite

- Repo occupato: normale, il task resta `queued`. Tree sporco: il worker lo riporta in chat, il tool non blocca niente. Branch esistente: suffisso automatico -2, -3, salvato nel campo branch. Base avanzato: rebase+retest o messaggio in chat. Test rossi: il worker li riporta, l'umano decide quando chiudere failed. Review rifiutata: riprova stesso branch. Restart DSH: binding da worker_session.

## 14. Esempio end-to-end

1. Chat: il login scazza su mobile → triage bug, 3 domande → draft. 2. Approvi → queued → active quando lo slot è libero → worker chat in background. 3. Worker: branch task/12-login-mobile, fix, test verdi, push, apre la PR via `gh` e riporta "pronto: <URL PR>". 4. Togli quel log → pusha di nuovo (la stessa PR si aggiorna da sola). 5. Mergi su GitHub come sempre. Chiudi task (done) → la coda avanza.

## 15. Registro decisioni

1. Versione stupida sincrona: un attivo per repo, niente worktree/scheduler/PR dal plugin (2026-09-07). 2. Triage divieto tecnico, lettura sì. approve/close solo utente. 3. Tool = sola coda deterministica: approve → sempre queued, promozione FIFO automatica; niente controlli git/test nel tool (2026-09-07). 4. Terminali done/cancelled/failed equivalenti per il tool, scelta umana. 5. Niente contatore tentativi nel tool. 6. working/need_attention derivati da DSH, non gestiti dal tool; ask_user_question nativo. 7. Worker nel checkout: branch suo, mai touch al base, force-with-lease solo sul suo; apre UNA PR via `gh` e ne riporta l'URL, mai merge proprio, mai seconda PR per le review (push sullo stesso branch). 8. Chiusura manuale; branch mai cancellati alla chiusura. 9. Draft eterni; niente auto-avvio. 10. GitHub-only; base da origin/HEAD + override; sqlite WAL. 11. design-task-queue.md = visione v2 rimandata.
