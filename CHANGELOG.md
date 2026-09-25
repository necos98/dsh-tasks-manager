# Changelog

One version covers the whole plugin: the tag `v<version>` names the `package.json` version, and the
updater in Settings → Tasks offers the newest tag it can read.

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
