/** Independent source installation; never installs the upstream npm package. */
import { existsSync, mkdirSync, mkdtempSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const PERSONAL_REPOSITORY = "https://github.com/dalsoop/opencodex.git";
export const PERSONAL_REF = "refs/heads/main";

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
      await run(cli(staging, "help"), staging, true);
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
      if (service) await run(cli(release, "service", "install"));
      if (service) writeFileSync(join(root, "manage-service"), "", { mode: 0o600 });
      const bin = join(root, "bin");
      mkdirSync(bin, { recursive: true });
      const launcher = join(bin, "ocx");
      writeFileSync(`${launcher}.next`, personalLauncher(root, bun), { mode: 0o755 });
      renameSync(`${launcher}.next`, launcher);
    });
    console.log(`Installed ${sha}. Use ${join(root, "bin", "ocx")}; update with ocx update.`);
  } catch (error) {
    // Pointer rollback happened before reinstalling the previous service definition.
    if (service && previous) {
      try { await run(cli(previous, "service", "install")); }
      catch { console.error("Previous service recovery failed; run its service install command."); }
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
