# Independent Installation

`scripts/personal-install.ts` resolves only `dalsoop/opencodex` main, fetches that
immutable commit, freezes dependency resolution and builds the GUI before activation.
Its managed launcher intercepts updates; source-layout runtime detection prevents
registry replacement. Activation restores the old pointer on failure and attempts
service recovery. `tests/ci-workflows/install-scripts.test.ts` exercises rollback and
shell argument preservation. See `PERSONAL.md` for installation and recovery.
Service replacement never runs `ocx stop` or another Codex-restoring verb. On macOS
the installer moves the plist onto the `current` pointer and restarts only with
`launchctl kickstart -k`, after `launchctl print` proves launchd holds that stable
definition; a release-pinned job is left running with reload instructions. Linux runs
the bare `ocx service` repair. Recovery repeats the same mechanism.

`.github/workflows/personal-ci.yml` validates the full Bun suite and docs on our main
and integration branch with read-only permissions and no publishing credentials.
Four Linux shards use the existing fresh-process batch runner with scope `all`,
including storage/usage tests and the runner's isolated serial manifest.
`.github/workflows/deploy-docs.yml` requires `OCX_ENABLE_DOCS_DEPLOY=1` before
building or publishing the inherited Pages configuration.
