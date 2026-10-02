# Changelog

One version covers the whole plugin: the tag `v<version>` names the `package.json` version, and the
updater in Settings → Tasks offers the newest tag it can read.

## [0.5.0]

Both taskqueue agents can read the web.

- **`web_search` + `web_fetch` in both presets (#32).** `Task Intake` and
  `Task Worker` now mount `@deepseek-ai/dsh-tool-web` with the same row id and
  config the shipped `standard` preset uses (`fetch: true`,
  `searchTimeoutMs: 60000` — the DeepSeek search route is a full auxiliary
  model request, so it needs more than the provider-neutral 30s default). Both
  are read-only network reads: neither mutates a file and `web_fetch` only GETs
  a public HTTP(S) URL, so the intake's no-write-tools property is unchanged.
  A new pin asserts the row and that guarantee together.
- **No dependency was added.** A preset row is a name the loader resolves at
  mount time (the worker preset already mounts `@deepseek-ai/dsh-tool-fs` this
  way), and `scripts/check.mjs` requires every declared `@deepseek-ai/dsh*` peer
  to pin one exact installed version — a stale pin makes the runtime refuse the
  bundle at boot. The `web` service and its providers are mounted at PROFILE
  level by `dsh-base` (`dsh-web`, `dsh-web-search-deepseek`,
  `dsh-web-fetch-http`), so the preset adds only the model-facing tools. With no
  `DEEPSEEK_API_KEY` the tools stay visible and the call fails with a `WebError`
  (`WEB_PROVIDER_UNAVAILABLE`) instead of the tools disappearing.
- **Restart to pick it up.** A bundle's patch layer composes at boot: update the
  plugin in the profile and restart `dsh web`, then `web_search` and `web_fetch`
  appear in the tool list of both presets.

## [0.4.1]

DSH 0.2.0-rc.2 compatibility. No runtime behaviour changes.

- **The DSH peer line moves with the runtime.** `@deepseek-ai/dsh-system-prompt` and
  `@deepseek-ai/dsh-tools` are pinned to `0.2.0-rc.2` (Cordis to `^4.0.4`, the
  devDependencies with them). DSH 0.2.0 gates an install — and denies a mounted
  bundle at boot — when a declared peer range does not cover the RUNNING runtime,
  so `0.4.0` was refused with "requires @deepseek-ai/dsh-system-prompt
  0.1.7-rc.2, @deepseek-ai/dsh-tools 0.1.7-rc.2". Both packages' `lib/` is
  byte-identical between the two lines: nothing in `lib/` changed, and the full
  suite (266 tests) plus `npm run check` pass against the `0.2.0-rc.2` tree.
- **`scripts/check.mjs` guards the DSH line.** Every `@deepseek-ai/dsh*` peer must
  be ONE exact version equal to the version installed in `node_modules`, and the
  installed DSH packages must agree on a single line, so a manifest edited without
  reinstalling — or a half-upgraded tree — fails the check instead of the install.

## [0.4.0]

Two new capabilities: worker git modes, and per-workspace project rules with commit language/style.

- **Worker git modes (#27).** The `workerCanMerge` boolean is replaced by the
  `workerGitMode` setting (default `branch-automerge`, plus `in-place-local` and
  `in-place-push`); the spawn message names the mode as the authority, the worker
  preset gates three sections on it, and Settings → Tasks gains a Git-workflow card
  with a 3-way selector (`baseBranch` applies only in branch-automerge mode).
- **Per-workspace project rules, commit language and message style (#28).** The
  global `workerRules` setting is removed in favour of a per-workspace `rules`
  column (DB v7) with get/set endpoints; new `commitLanguage` (default English)
  and `messageStyle` (minimal/extended) settings, a Project-rules card in the
  Tasks panel, and the spawn prompt carries language/style lines plus the
  workspace rules section.

## [0.3.1]

The two agent presets mount again on DSH ≥ 0.1.7-rc.2, as bundle declarations
instead of a directory copy.

- **Presets are published again.** 0.1.7-rc.2 stopped reading the user preset
  root `$DSH_HOME/.agent-presets/<id>/`: a preset is now an
  `@deepseek-ai/dsh-agent-preset` DECLARATION carried by a bundle patch, and the
  harness reads declarations only. The plugin still copied its
  `presets/taskqueue-*` compositions there on every boot — the copy worked, the
  harness simply never read it — so `Task Intake` and `Task Worker` vanished from
  the preset roster and every promotion failed with `Unknown agent preset:
  taskqueue-worker`. The compositions now ship as `presets/taskqueue-intake.patch.yml`
  and `presets/taskqueue-worker.patch.yml` and are listed in the package's own
  `dsh.bundle.patch`, so the loader inserts the `preset-taskqueue-intake` /
  `preset-taskqueue-worker` rows while it composes the profile.
- **The on-disk publication path is gone.** `lib/presets-sync.js`, the
  `syncPresets` config key and the boot-time copy are removed (`dshHome` stays: it
  still locates the queue database). `scripts/validate-presets.mjs` now walks the
  bundle patches and validates every row — including a declaration's nested
  `config.plugins` — against the installed plugins' `Config` schemas, so a
  renamed preset field still fails offline. `presets/<id>/agent.cordis.yml` and
  `preset.yml` are replaced by the declaration files; a stale
  `$DSH_HOME/.agent-presets/taskqueue-*` directory can simply be deleted.

## [0.3.0]

Settings survive the DSH 0.1.7-rc.2 settings rewrite.

- **Settings → Tasks mounts again.** The harness removed both halves of the
  settings API the plugin used (`ctx.settings.register(ns, schema)` on the host,
  `settingsScope` in the browser), so the card stayed `pending (waiting for
  service: settingsScope)` and never rendered. Since 0.1.7-rc.2 the settings
  namespace is derived from the entry's exported `Config` schema, keyed by the
  profile entry id (`dsh-tasks-manager`) and built ONLY from its `.volatile()`
  fields: `baseBranch`, `workerCanFinish`, `workerCanMerge`, `workerRules` and
  `workerModel` are now those fields, the browser half injects `configForms`, and
  deployment-only keys (`section`, `updateToken`, …) stay out of the form. An
  entry with no volatile field produces no namespace at all. Preferences saved by
  an earlier version under the old `tasks` namespace are not migrated: re-enter
  them in Settings → Tasks.

## [0.2.0]

First tagged release: the plugin carries a manual, tag-driven updater, and the error box renders again.

- **Settings → Tasks gains a manual GitHub updater.** The new Updates block reads the repository's
  release tags — `git ls-remote --tags`, with the GitHub API as fallback — and compares the newest tag
  with the version installed in the DSH profile; tags are the only version source, so an untagged
  repository reports "no release tag yet" instead of guessing. It answers over the plugin's private
  `/tasks-queue` channel with `updateStatus`, `checkUpdate` and `applyUpdate`: installing pins the
  newest tag (`github:necos98/dsh-tasks-manager#v<version>`) into the profile and the running app keeps
  the old bundle until it is restarted. A check that would install a version other than the one it
  reported, or a profile that does not match, stops before anything is written.
- **The error box renders again.** A stray unary plus in the client stylesheet concatenated a `+`
  into the `._tskError` selector, so the sheet emitted `NaN._tskError{…}` and both the box chrome and
  its red text were dropped. The operator is gone, and a client-half test builds the stylesheet and
  guards against the same typo.
