/** Independent source installation; never installs the upstream npm package. */
import { closeSync, existsSync, fchmodSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const PERSONAL_REPOSITORY = "https://github.com/dalsoop/opencodex.git";
export const PERSONAL_REF = "refs/heads/main";
export const LAUNCHD_LABEL = "com.opencodex.proxy";

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function personalLauncher(root: string, bun: string): string {
  const current = shellQuote(join(root, "current"));
  return `#!/bin/sh
if [ "$1" = update ]; then
  shift
  exec ${shellQuote(bun)} ${current}/scripts/personal-install.ts "$@"
fi
exec node ${current}/bin/ocx.mjs "$@"
`;
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function xmlUnescape(value: string): string {
  return value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** How a root path can appear in a plist: XML-escaped, bare or inside a shell-quoted word. */
function plistRootForms(roots: string[]): string[] {
  return [...new Set(roots.flatMap(root => [xmlEscape(root), xmlEscape(root.replaceAll("'", "'\\''"))]))];
}

/** How a root path can appear in the XML-unescaped program command. */
function commandRootForms(roots: string[]): string[] {
  return plistRootForms(roots).map(xmlUnescape);
}

/**
 * Point a launchd definition at `<root>/current` instead of one `<root>/releases/<commit>`.
 *
 * `launchctl kickstart -k` restarts the definition launchd CACHED at bootstrap and never
 * re-reads the plist, so a release-pinned program path can only be changed by evicting the
 * job. A definition that runs through the `current` pointer lets an update switch releases
 * with the pointer plus a kickstart. Only release-pinned paths change (the program command
 * and the matching runtime-path record); every other key keeps its bytes.
 *
 * The root must start a path (string start, whitespace, quote, `;` of an XML entity, `>`, `:`
 * or `=`) and the commit must end one, so `/x<root>/...` and `<sha>0` never match.
 */
export function stablePersonalServiceDefinition(definition: string, roots: string[]): string {
  let stable = definition;
  for (const form of plistRootForms(roots)) {
    const pinned = new RegExp(`(?<![^\\s'";>:=])${escapeRegExp(form)}/releases/[0-9a-f]{40}(?![\\w.-])`, "g");
    stable = stable.replace(pinned, () => `${form}/current`);
  }
  return stable;
}

/** The shell command launchd runs: the last ProgramArguments string, XML-unescaped. */
export function launchdProgramCommand(definition: string): string | null {
  const block = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(definition)?.[1];
  const strings = block ? [...block.matchAll(/<string>([\s\S]*?)<\/string>/g)].map(match => match[1]) : [];
  const last = strings.at(-1);
  return last === undefined ? null : xmlUnescape(last);
}

/** The `--port <n>` baked at the end of the service command. */
export function launchdCommandPort(command: string): number | null {
  const last = [...command.matchAll(/start --port (\d{1,5})(?!\d)/g)].at(-1);
  const port = last ? Number(last[1]) : NaN;
  return port > 0 && port <= 65535 ? port : null;
}

/** The `pid = <n>` line of `launchctl print`, or null while the job has no process. */
export function launchdPrintedPid(printed: string): number | null {
  const match = /^\s*pid = (\d+)\s*$/m.exec(printed);
  return match ? Number(match[1]) : null;
}

export interface LaunchctlResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export interface PersonalServiceDeps {
  platform: NodeJS.Platform;
  /** The installation root, plus its realpath when that differs. */
  roots: string[];
  plistPath: string;
  uid: number;
  /** `--service` was passed on this run; a first macOS service install requires it. */
  installRequested: boolean;
  readFile: (path: string) => string | null;
  writeFile: (path: string, text: string) => void;
  launchctl: (args: string[]) => LaunchctlResult;
  /** Runs `src/cli/index.ts` of the given release. */
  cli: (release: string, args: string[]) => Promise<unknown>;
  /** GET `http://127.0.0.1:<port>/healthz`; resolves with the parsed body or rejects. */
  fetchHealth: (port: number) => Promise<unknown>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** How long a kickstarted job has to show a new pid and answer /healthz. */
  healthTimeoutMs: number;
  log: (message: string) => void;
}

/** What a refresh did to the running service, recorded BEFORE it acts so rollback can undo it. */
export interface PersonalServiceProgress {
  action?: "kickstart" | "cli";
  /** The launchd pid the kickstart replaced, and the port its health is read on. */
  replacedPid?: number | null;
  port?: number;
}

function launchdTarget(deps: PersonalServiceDeps): string {
  return `gui/${deps.uid}/${LAUNCHD_LABEL}`;
}

function reloadSteps(deps: PersonalServiceDeps): string {
  const target = launchdTarget(deps);
  return `  launchctl bootout ${target}\n`
    + `  # wait until 'launchctl print ${target}' reports no such service\n`
    + `  launchctl bootstrap gui/${deps.uid} ${shellQuote(deps.plistPath)}\n`
    + "Logging out and back in loads it too. The reload restarts the proxy once; as a service\n"
    + "child it keeps Codex routing.";
}

/** Rewrite the plist on disk to its stable form; returns the stable text. Never touches launchd. */
function writeStablePlist(deps: PersonalServiceDeps, definition: string): string {
  const stable = stablePersonalServiceDefinition(definition, deps.roots);
  if (stable !== definition) deps.writeFile(deps.plistPath, stable);
  return stable;
}

/**
 * `launchctl kickstart -k`, then proof that a NEW process serves: launchd reports a pid other
 * than the one replaced, and that pid answers `/healthz` on the baked port.
 */
async function kickstartAndVerify(deps: PersonalServiceDeps, replacedPid: number | null, port: number): Promise<void> {
  const target = launchdTarget(deps);
  const kicked = deps.launchctl(["kickstart", "-k", target]);
  if (!kicked.ok) throw new Error(`launchctl kickstart -k ${target} failed: ${kicked.stderr.trim() || "no detail"}`);
  const deadline = deps.now() + deps.healthTimeoutMs;
  let last = "launchd reported no new pid";
  for (;;) {
    const printed = deps.launchctl(["print", target]);
    const pid = printed.ok ? launchdPrintedPid(printed.stdout) : null;
    if (pid !== null && pid !== replacedPid) {
      try {
        const body = await deps.fetchHealth(port) as { status?: unknown; service?: unknown; pid?: unknown } | null;
        // The answering pid must not be the replaced one. It is normally launchd's pid (the
        // plist `exec`s Bun), but equality is not required so a supervising wrapper cannot
        // fail a healthy update into a rollback.
        if (body?.service === "opencodex" && body.status === "ok" && body.pid !== replacedPid) return;
        last = `pid ${pid} answered /healthz on port ${port} with ${JSON.stringify(body)}`;
      } catch (error) {
        last = `pid ${pid} did not answer /healthz on port ${port}: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    if (deps.now() >= deadline) {
      throw new Error(`${LAUNCHD_LABEL} did not serve within ${Math.round(deps.healthTimeoutMs / 1000)}s of kickstart (${last}).`);
    }
    await deps.sleep(1000);
  }
}

/**
 * Make the managed service run the release `current` now points at, without `ocx stop`.
 *
 * `ocx stop` (and `ocx service stop|uninstall`) restore native Codex and the Grok fence: on
 * a hub whose reviewers and merge queue run through Codex, an update must never do that.
 *
 * macOS with an installed plist: the plist is moved onto the `current` pointer (file only)
 * and the job is restarted with `launchctl kickstart -k gui/<uid>/com.opencodex.proxy`, the
 * one restart a hub allows, then verified by a new pid that answers `/healthz`. The proxy is
 * a service child (`OCX_SERVICE=1`), so its SIGTERM exit keeps Codex routing. When launchd
 * still holds a release-pinned definition, a kickstart would restart the OLD release, so
 * nothing is restarted and the one-time reload is left to the operator.
 *
 * macOS without a plist: only an explicit `--service` runs `ocx service install`, which may
 * stop a standalone proxy (restoring Codex) and bootstraps the new job.
 *
 * Linux: the CLI's bare `ocx service` runs `repair` (rewrite + `systemctl --user restart`,
 * no Codex teardown) when installed, `install` on a first service install.
 */
export async function refreshPersonalService(
  release: string,
  deps: PersonalServiceDeps,
  progress: PersonalServiceProgress = {},
): Promise<void> {
  if (deps.platform !== "darwin") {
    progress.action = "cli";
    await deps.cli(release, ["service"]);
    return;
  }
  const installed = deps.readFile(deps.plistPath);
  if (installed === null) {
    if (!deps.installRequested) {
      throw new Error(
        `${deps.plistPath} is missing, so there is no service to restart. A first service install `
        + "evicts any launchd job and may stop a standalone proxy, which restores Codex; run the "
        + "installer with --service to accept that.",
      );
    }
    progress.action = "cli";
    await deps.cli(release, ["service", "install"]);
    const fresh = deps.readFile(deps.plistPath);
    if (fresh !== null && writeStablePlist(deps, fresh) !== fresh) {
      deps.log(`The service definition now runs from ${join(deps.roots[0], "current")}; launchd loads it at the next login or one-time reload.`);
    }
    return;
  }

  const stable = stablePersonalServiceDefinition(installed, deps.roots);
  const command = launchdProgramCommand(stable);
  if (command === null) {
    throw new Error(`${deps.plistPath} has no ProgramArguments command; the service was not restarted.`);
  }
  const roots = commandRootForms(deps.roots);
  if (!roots.some(root => command.includes(`${root}/current/`)) || roots.some(root => command.includes(`${root}/releases/`))) {
    const runs = /exec ('(?:[^']|'\\'')*'|\S+)/.exec(command)?.[1] ?? "an unrecognised command";
    throw new Error(
      `${deps.plistPath} runs ${runs}, not a Bun + CLI pair from ${join(deps.roots[0], "releases")}`
      + " (a launcher-form or foreign definition); the service was not restarted. Recreate it from this"
      + " installation with --service only when the proxy may be evicted.",
    );
  }
  const port = launchdCommandPort(command);
  if (port === null) throw new Error(`${deps.plistPath} carries no --port; the service was not restarted.`);
  writeStablePlist(deps, installed);

  const target = launchdTarget(deps);
  const printed = deps.launchctl(["print", target]);
  if (!printed.ok) {
    throw new Error(
      `${LAUNCHD_LABEL} is not loaded in gui/${deps.uid} (launchctl print: ${printed.stderr.trim() || "failed"}). `
      + `Nothing was restarted. ${deps.plistPath} now runs from ${join(deps.roots[0], "current")}; load it with\n`
      + reloadSteps(deps),
    );
  }
  if (!`${printed.stdout}\n${printed.stderr}`.includes(command)) {
    throw new Error(
      `launchd still holds a release-pinned definition of ${LAUNCHD_LABEL}; kickstart would restart the previous release.\n`
      + `${deps.plistPath} now runs from ${join(deps.roots[0], "current")}. Nothing was restarted.\n`
      + "Load it once, then run the update again:\n"
      + reloadSteps(deps),
    );
  }
  progress.action = "kickstart";
  progress.replacedPid = launchdPrintedPid(printed.stdout);
  progress.port = port;
  await kickstartAndVerify(deps, progress.replacedPid, port);
}

/**
 * Return the service to `previous` after the pointer rollback, by the same means the refresh
 * used. macOS never runs a CLI service verb here: after a first install it would be
 * `repair`, which evicts and bootstraps the job.
 */
export async function restorePersonalService(
  previous: string,
  deps: PersonalServiceDeps,
  progress: PersonalServiceProgress,
): Promise<void> {
  if (progress.action === "kickstart") {
    const target = launchdTarget(deps);
    const printed = deps.launchctl(["print", target]);
    await kickstartAndVerify(deps, printed.ok ? launchdPrintedPid(printed.stdout) : null, progress.port!);
  } else if (progress.action === "cli" && deps.platform !== "darwin") {
    await deps.cli(previous, ["service"]);
  } else if (progress.action === "cli") {
    deps.log(
      `The first service install was not rolled back automatically. ${deps.plistPath} runs from `
      + `${join(deps.roots[0], "current")}, which points at the previous release again; to load it:\n`
      + reloadSteps(deps),
    );
  }
}

/**
 * Replace a private file atomically: refuse a symlinked target, start from a fresh `.next`
 * (an old one could carry a wider mode), write 0600, fsync, then rename.
 */
export function writePrivateFileAtomic(path: string, text: string): void {
  try {
    if (lstatSync(path).isSymbolicLink()) throw new Error(`${path} is a symlink; refusing to replace it.`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  // `.next`, not `.plist`: launchd loads every `*.plist` in LaunchAgents at login.
  const next = `${path}.next`;
  rmSync(next, { force: true });
  const fd = openSync(next, "wx", 0o600);
  try {
    writeFileSync(fd, text);
    fchmodSync(fd, 0o600);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(next, path);
}

/** Switch only after preparation; restore the previous pointer on activation failure. */
export async function activatePersonalRelease(root: string, release: string, activate: () => Promise<void>): Promise<void> {
  const current = join(root, "current");
  const next = join(root, "current.next");
  const previous = existsSync(current) ? readlinkSync(current) : undefined;
  symlinkSync(release, next);
  renameSync(next, current);
  try {
    await activate();
  } catch (error) {
    if (previous) {
      symlinkSync(previous, next);
      renameSync(next, current);
    } else {
      rmSync(current);
    }
    throw error;
  }
}

async function main(): Promise<void> {
  if (process.platform === "win32") throw new Error("Personal source installation currently supports macOS and Linux.");
  const args = process.argv.slice(2);
  if (args.some(arg => !["--check", "--service"].includes(arg))) {
    throw new Error("Usage: bun scripts/personal-install.ts [--check] [--service]");
  }
  const root = join(homedir(), ".local", "share", "opencodex-personal");
  const bun = process.execPath;
  async function run(argv: string[], cwd?: string, capture = false): Promise<string> {
    const child = Bun.spawn(argv, { cwd, stdin: "ignore", stdout: capture ? "pipe" : "inherit", stderr: "inherit" });
    const output = capture ? await new Response(child.stdout).text() : "";
    if (await child.exited !== 0) throw new Error(`Command failed: ${argv[0]}`);
    return output.trim();
  }
  const remote = await run(["git", "ls-remote", PERSONAL_REPOSITORY, PERSONAL_REF], undefined, true);
  const sha = remote.split(/\s+/)[0];
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("Could not resolve our main commit.");
  console.log(`dalsoop/opencodex main: ${sha}`);
  if (args.includes("--check")) return;

  mkdirSync(root, { recursive: true, mode: 0o700 });
  const lock = join(root, "install.lock");
  try { mkdirSync(lock); } catch { throw new Error("Another personal installation is running (install.lock)."); }
  let staging: string | undefined;
  const service = args.includes("--service") || existsSync(join(root, "manage-service"));
  const cli = (release: string, ...tail: string[]) => [bun, join(release, "src", "cli", "index.ts"), ...tail];
  const serviceDeps: PersonalServiceDeps = {
    platform: process.platform,
    roots: [...new Set([root, realpathSync(root)])],
    plistPath: join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`),
    uid: process.getuid?.() ?? 0,
    installRequested: args.includes("--service"),
    readFile: path => {
      try { return readFileSync(path, "utf8"); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    writeFile: writePrivateFileAtomic,
    launchctl: argv => {
      const child = Bun.spawnSync(["/bin/launchctl", ...argv], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      return { ok: child.exitCode === 0, stdout: child.stdout.toString(), stderr: child.stderr.toString() };
    },
    cli: (release, tail) => run(cli(release, ...tail)),
    fetchHealth: async port => {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(2000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    },
    sleep: ms => new Promise(done => setTimeout(done, ms)),
    now: () => Date.now(),
    healthTimeoutMs: 90_000,
    log: message => console.log(message),
  };
  const serviceProgress: PersonalServiceProgress = {};
  let previous: string | undefined;
  try {
    const releases = join(root, "releases");
    mkdirSync(releases, { recursive: true });
    const release = join(releases, sha);
    if (!existsSync(release)) {
      staging = mkdtempSync(join(releases, ".prepare-"));
      await run(["git", "init", "--quiet", staging]);
      await run(["git", "remote", "add", "origin", PERSONAL_REPOSITORY], staging);
      await run(["git", "fetch", "--quiet", "--depth=1", "origin", sha], staging);
      await run(["git", "checkout", "--quiet", "--detach", "FETCH_HEAD"], staging);
      await run([bun, "install", "--frozen-lockfile"], staging);
      await run([bun, "run", "build:gui"], staging);
      await run([join(staging, "node_modules", "bun", "bin", "bun.exe"), join(staging, "src", "cli", "index.ts"), "help"], staging, true);
      renameSync(staging, release);
      staging = undefined;
    }
    if (await run(["git", "rev-parse", "HEAD"], release, true) !== sha
      || await run(["git", "remote", "get-url", "origin"], release, true) !== PERSONAL_REPOSITORY
      || await run(["git", "status", "--porcelain", "--untracked-files=no"], release, true)) {
      throw new Error("Existing personal release does not match its recorded commit.");
    }
    const current = join(root, "current");
    previous = existsSync(current) ? resolve(root, readlinkSync(current)) : undefined;
    await activatePersonalRelease(root, release, async () => {
      if (service) await refreshPersonalService(release, serviceDeps, serviceProgress);
      if (service) writeFileSync(join(root, "manage-service"), "", { mode: 0o600 });
      const bin = join(root, "bin");
      mkdirSync(bin, { recursive: true });
      const launcher = join(bin, "ocx");
      const managedBun = join(root, "current", "node_modules", "bun", "bin", "bun.exe");
      writeFileSync(`${launcher}.next`, personalLauncher(root, managedBun), { mode: 0o755 });
      renameSync(`${launcher}.next`, launcher);
    });
    console.log(`Installed ${sha}. Use ${join(root, "bin", "ocx")}; update with ocx update.`);
  } catch (error) {
    // Pointer rollback happened first; the service is returned by the same means that moved it.
    if (service && previous) {
      try { await restorePersonalService(previous, serviceDeps, serviceProgress); }
      catch (recovery) {
        console.error(`Previous service recovery failed: ${recovery instanceof Error ? recovery.message : String(recovery)}`);
        console.error(`Check it with: launchctl print gui/${serviceDeps.uid}/${LAUNCHD_LABEL} (macOS) or systemctl --user status opencodex-proxy (Linux).`);
      }
    }
    throw error;
  } finally {
    if (staging) rmSync(staging, { recursive: true, force: true });
    rmSync(lock, { recursive: true });
  }
}

if (import.meta.main) main().catch(error => {
  console.error(error instanceof Error ? error.message : "Personal installation failed.");
  process.exitCode = 1;
});
