# Independent installation

This repository is maintained at **dalsoop/opencodex**. Its model visibility fixes
are installed from our `main`, separately from the original npm package.

On macOS or Linux, with Git, Node.js and Bun installed:

```sh
git clone https://github.com/dalsoop/opencodex.git
cd opencodex
bun scripts/personal-install.ts --service
```

Put `~/.local/share/opencodex-personal/bin` first in `PATH`. The managed command
is `ocx`; `ocx update --check` prints our latest main commit, and `ocx update`
installs that exact commit. Omit `--service` on the first install to manage the
proxy manually. Once selected, service management persists across updates.

The installer prepares dependencies with frozen lockfiles and builds the GUI
before switching installations. Releases live under
`~/.local/share/opencodex-personal/releases/<commit>`. It atomically switches
`current`, restores the previous pointer if activation fails, and attempts to
restore the previous service. Old releases remain available for recovery.

Updates never run `ocx stop` or any other command that restores the Codex config.
On macOS the launchd plist runs through `current`, and the installer restarts the
service only with `launchctl kickstart -k gui/$(id -u)/com.opencodex.proxy`. It then
waits up to 90 seconds until `/healthz` on the plist's port answers with the new
pid launchd reports. It probes the configured `hostname`, read by the release's own
config loader under the plist's `OPENCODEX_HOME`, and uses 127.0.0.1 only when that
host is unset or a wildcard. On failure it restores `current` and kickstarts the
previous release. launchd keeps the definition it loaded, so while a job is still pinned to
one release the installer restarts nothing and prints a one-time reload:
`launchctl bootout gui/$(id -u)/com.opencodex.proxy`, then, once `launchctl print`
no longer finds it,
`launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.opencodex.proxy.plist`
(or log out and back in). `ocx service install` and `ocx service repair` write a
release-pinned plist again, so after either one the next update refuses until that
reload is repeated. A first macOS service install happens only with an explicit
`--service`; it may stop a standalone proxy, which restores Codex. On Linux the
installer runs `ocx service`, which repairs and restarts the systemd unit without
restoring Codex.

`ocx update` runs the installer of the release it replaces. To move an
installation made before this change, bootstrap once from a fresh clone instead:

```sh
git clone https://github.com/dalsoop/opencodex.git /tmp/opencodex-bootstrap
cd /tmp/opencodex-bootstrap && bun scripts/personal-install.ts
```

On macOS that first run stops at the release-pinned check: perform the one-time
reload above, then run the same command again. Later `ocx update` runs are safe.
An interrupted install leaves `install.lock`; remove it only after confirming
no installer is running. User configuration and credentials remain in their
existing state directories. The source installation disables the npm updater;
the managed launcher routes `ocx update` exclusively to this installer.

Personal repository CI runs the full Bun suite, typecheck, structure/privacy
checks and documentation build. It publishes no packages and uses no secrets.
The inherited cross-platform workflows remain available separately.
Inherited Pages deployment stays off unless the repository owner explicitly sets
`OCX_ENABLE_DOCS_DEPLOY=1` after configuring their own site.
