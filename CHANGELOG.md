# Changelog

One version covers the whole plugin: the tag `v<version>` names the `package.json` version, and the
updater in Settings → Tasks offers the newest tag it can read.

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
