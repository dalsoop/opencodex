import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { normalizePackageModes } from "../../scripts/prepare-package";
import {
  activatePersonalRelease,
  LAUNCHD_LABEL,
  launchdProgramCommand,
  personalLauncher,
  refreshPersonalService,
  restorePersonalService,
  stablePersonalServiceDefinition,
  writePrivateFileAtomic,
  type PersonalServiceDeps,
  type PersonalServiceProgress,
} from "../../scripts/personal-install";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoRoot as resolveRepoRoot } from "../helpers/repo-root";

// Windows CI runners spawn Node/Bun child processes slowly ("Slow filesystem detected");
// the package-main import test measured 9.4s there vs bun's 5s default. Same remedy as
// codex-history-provider / cursor-mcp-stdio.
setDefaultTimeout(30_000);

const root = pathToFileURL(resolveRepoRoot() + "/");
const repoRoot = fileURLToPath(root);

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

function removeModeFixture(path: string): void {
  try { chmodSync(path, 0o700); } catch { /* best-effort cleanup */ }
  try { removeTreeWithRetry(path); } catch { /* best-effort cleanup */ }
}

function systemCommandPath(command: string): string {
  const result = spawnSync("/bin/sh", ["-c", `command -v ${command}`], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`required test command is unavailable: ${command}`);
  }
  return result.stdout.trim();
}

function writeExecutable(path: string, source: string): void {
  writeFileSync(path, source, { encoding: "utf8", mode: 0o755 });
}

async function readText(path: string): Promise<string> {
  return await Bun.file(new URL(path, root)).text();
}

describe("install scripts", () => {
  describe("personal service refresh never tears Codex down", () => {
    const root = "/Users/example/.local/share/opencodex-personal";
    const oldRelease = `${root}/releases/${"a".repeat(40)}`;
    const newRelease = `${root}/releases/${"b".repeat(40)}`;
    const plistPath = "/Users/example/Library/LaunchAgents/com.opencodex.proxy.plist";
    const target = `gui/501/${LAUNCHD_LABEL}`;
    const xml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
    const preamble = "if [ -f '/Users/example/.opencodex/service-token' ]; then "
      + "OPENCODEX_API_AUTH_TOKEN=\"$(cat '/Users/example/.opencodex/service-token')\"; export OPENCODEX_API_AUTH_TOKEN; fi; ";
    const commandFor = (prefix: string) => `${preamble}exec '${prefix}/node_modules/bun/bin/bun.exe' '${prefix}/src/cli/index.ts' start --port 10100`;
    // Same shape as src/service/launchd.ts buildPlist.
    const plistFor = (prefix: string, command = commandFor(prefix)) => `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-lc</string>
    <string>${xml(command)}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>OCX_SERVICE</key><string>1</string>
    <key>OCX_BUN_RUNTIME_PATH</key><string>${prefix}/node_modules/bun/bin/bun.exe</string>
    <key>PATH</key><string>/opt/elsewhere/releases/${"c".repeat(40)}/bin:/usr/bin:/bin</string>
  </dict>
  <key>StandardOutPath</key><string>/Users/example/.opencodex/service.log</string>
</dict>
</plist>
`;
    const printFor = (command: string, pid: number | null) => `${target} = {\n\tstate = ${pid ? "running" : "waiting"}\n`
      + (pid ? `\tpid = ${pid}\n` : "") + `\tprogram = /bin/sh\n\targuments = {\n\t\t/bin/sh\n\t\t-lc\n\t\t${command}\n\t}\n}\n`;

    /**
     * A host whose CLI behaves like src/service: bare `service` with a plist is `repair`
     * (installLaunchd: bootout + bootstrap), and `service install` is prepareServiceInstall
     * (stop the manager and any standalone proxy) followed by the same bootout + bootstrap.
     */
    function fakeHost(options: {
      platform?: NodeJS.Platform;
      plist?: string | null;
      live?: string | null;
      kickstartOk?: boolean;
      healthy?: boolean;
      installRequested?: boolean;
    } = {}) {
      const platform = options.platform ?? "darwin";
      const files = new Map<string, string>();
      if (options.plist) files.set(plistPath, options.plist);
      const launchctl: string[][] = [];
      const cli: { release: string; args: string[] }[] = [];
      const effects: string[] = [];
      const logs: string[] = [];
      let pid = 100;
      let clock = 0;
      const deps: PersonalServiceDeps = {
        platform,
        roots: [root],
        plistPath,
        uid: 501,
        installRequested: options.installRequested ?? false,
        readFile: path => files.get(path) ?? null,
        writeFile: (path, text) => { files.set(path, text); },
        launchctl: args => {
          launchctl.push(args);
          if (args[0] === "print") {
            return options.live === null
              ? { ok: false, stdout: "", stderr: "Could not find service" }
              : { ok: true, stdout: printFor(options.live ?? commandFor(`${root}/current`), pid), stderr: "" };
          }
          if (args[0] === "kickstart") {
            if (options.kickstartOk === false) return { ok: false, stdout: "", stderr: "kickstart refused" };
            pid += 1;
            return { ok: true, stdout: "", stderr: "" };
          }
          throw new Error(`unexpected launchctl ${args.join(" ")}`);
        },
        cli: async (release, args) => {
          cli.push({ release, args });
          if (platform !== "darwin") { effects.push("systemctl restart"); return; }
          if (args.length === 1 && args[0] === "service" && files.has(plistPath)) {
            effects.push("bootout", "bootstrap");
            files.set(plistPath, plistFor(release));
          } else if (args[0] === "service") {
            effects.push("stop standalone proxy", "bootout", "bootstrap");
            files.set(plistPath, plistFor(release));
          }
        },
        fetchHealth: async port => {
          if (options.healthy === false) throw new Error("connection refused");
          return { status: "ok", service: "opencodex", pid, port };
        },
        sleep: async ms => { clock += ms; },
        now: () => clock,
        healthTimeoutMs: 5000,
        log: message => { logs.push(message); },
      };
      return { deps, files, launchctl, cli, effects, logs };
    }

    test("only release-pinned paths move onto the current pointer", () => {
      const stable = stablePersonalServiceDefinition(plistFor(oldRelease), [root]);
      expect(launchdProgramCommand(stable)).toBe(commandFor(`${root}/current`));
      expect(stable).toContain(`<key>OCX_BUN_RUNTIME_PATH</key><string>${root}/current/node_modules/bun/bin/bun.exe</string>`);
      expect(stable).not.toContain(`${root}/releases/`);
      // Unrelated keys keep their bytes, including a foreign path that also has a releases/<sha> segment.
      expect(stable).toContain(`/opt/elsewhere/releases/${"c".repeat(40)}/bin`);
      expect(stable).toBe(plistFor(`${root}/current`));
      expect(stablePersonalServiceDefinition(stable, [root])).toBe(stable);
    });

    test("the rewrite is literal, bounded, and covers a bare release path", () => {
      const dollarRoot = "/Users/example/$&-$1 root";
      // `$&` and `$1` must stay literal; `&` reaches the plist XML-escaped.
      const dollar = `<string>${xml(dollarRoot)}/releases/${"d".repeat(40)}/src</string>`;
      expect(stablePersonalServiceDefinition(dollar, [dollarRoot])).toBe(`<string>${xml(dollarRoot)}/current/src</string>`);
      const bare = `<string>${root}/releases/${"e".repeat(40)}</string>`;
      expect(stablePersonalServiceDefinition(bare, [root])).toBe(`<string>${root}/current</string>`);
      const shapes = [
        `<string>/mnt${root}/releases/${"e".repeat(40)}/src</string>`,
        `<string>${root}/releases/${"e".repeat(40)}0/src</string>`,
        `<string>${root}/releases/${"e".repeat(40)}.bak</string>`,
      ];
      for (const shape of shapes) expect(stablePersonalServiceDefinition(shape, [root])).toBe(shape);
    });

    test("an installed macOS service is restarted only by kickstart and must serve again", async () => {
      const host = fakeHost({ plist: plistFor(oldRelease) });
      const progress: PersonalServiceProgress = {};
      await refreshPersonalService(newRelease, host.deps, progress);
      expect(host.cli).toEqual([]);
      expect(host.effects).toEqual([]);
      expect(host.launchctl).toEqual([["print", target], ["kickstart", "-k", target], ["print", target]]);
      expect(host.files.get(plistPath)).toBe(plistFor(`${root}/current`));
      expect(progress).toEqual({ action: "kickstart", replacedPid: 100, port: 10100 });

      // Rollback after the pointer is restored: the same kickstart, never a stop or reload.
      await restorePersonalService(oldRelease, host.deps, progress);
      expect(host.launchctl.slice(3)).toEqual([["print", target], ["kickstart", "-k", target], ["print", target]]);
      expect(host.cli).toEqual([]);
      expect(host.effects).toEqual([]);
    });

    test("a kickstarted job that never answers /healthz fails the refresh", async () => {
      const host = fakeHost({ plist: plistFor(oldRelease), healthy: false });
      const progress: PersonalServiceProgress = {};
      await expect(refreshPersonalService(newRelease, host.deps, progress)).rejects.toThrow("did not answer /healthz on port 10100");
      // Rollback then kickstarts the previous release; nothing else.
      expect(progress.action).toBe("kickstart");
      await expect(restorePersonalService(oldRelease, host.deps, progress)).rejects.toThrow("did not serve");
      expect(host.launchctl.filter(args => args[0] !== "print")).toEqual([["kickstart", "-k", target], ["kickstart", "-k", target]]);
      expect(host.cli).toEqual([]);
      expect(host.effects).toEqual([]);
    });

    test("a release-pinned launchd job is left running instead of evicted", async () => {
      const host = fakeHost({ plist: plistFor(oldRelease), live: commandFor(oldRelease) });
      const progress: PersonalServiceProgress = {};
      await expect(refreshPersonalService(newRelease, host.deps, progress)).rejects.toThrow("release-pinned");
      expect(host.launchctl).toEqual([["print", target]]);
      // The stable definition waits on disk for the operator's one-time reload.
      expect(host.files.get(plistPath)).toBe(plistFor(`${root}/current`));
      expect(progress.action).toBeUndefined();
      await restorePersonalService(oldRelease, host.deps, progress);
      expect(host.launchctl).toEqual([["print", target]]);
      expect(host.cli).toEqual([]);
      expect(host.effects).toEqual([]);
    });

    test("a job launchd does not hold is not restarted and gets reload steps", async () => {
      const host = fakeHost({ plist: plistFor(oldRelease), live: null });
      const failure = refreshPersonalService(newRelease, host.deps);
      await expect(failure).rejects.toThrow("is not loaded in gui/501");
      await expect(failure).rejects.toThrow("launchctl bootstrap gui/501");
      expect(host.launchctl).toEqual([["print", target]]);
      expect(host.cli).toEqual([]);
    });

    test("foreign, launcher-form or half-pinned plists are left alone", async () => {
      const definitions = [
        plistFor("/opt/homebrew/lib/node_modules/@bitkyc08/opencodex"),
        plistFor(oldRelease, `${preamble}exec '${root}/bin/ocx' start --port 10100`),
        plistFor(oldRelease, `${preamble}exec '${oldRelease}/node_modules/bun/bin/bun.exe' '${root}/releases/x/src/cli/index.ts' start --port 10100`),
      ];
      for (const definition of definitions) {
        const host = fakeHost({ plist: definition });
        await expect(refreshPersonalService(newRelease, host.deps)).rejects.toThrow("the service was not restarted");
        expect(host.files.get(plistPath)).toBe(definition);
        expect(host.launchctl).toEqual([]);
        expect(host.cli).toEqual([]);
      }
      const launcher = fakeHost({ plist: plistFor(oldRelease, `${preamble}exec '${root}/bin/ocx' start --port 10100`) });
      await expect(refreshPersonalService(newRelease, launcher.deps)).rejects.toThrow(`runs '${root}/bin/ocx'`);
    });

    test("a failed kickstart is recovered with another kickstart", async () => {
      const host = fakeHost({ plist: plistFor(oldRelease), kickstartOk: false });
      const progress: PersonalServiceProgress = {};
      await expect(refreshPersonalService(newRelease, host.deps, progress)).rejects.toThrow("kickstart refused");
      expect(progress.action).toBe("kickstart");
      await expect(restorePersonalService(oldRelease, host.deps, progress)).rejects.toThrow("kickstart");
      expect(host.launchctl.filter(args => args[0] !== "print")).toEqual([["kickstart", "-k", target], ["kickstart", "-k", target]]);
      expect(host.cli).toEqual([]);
    });

    test("Linux repairs through the bare service verb and recovers the same way", async () => {
      const host = fakeHost({ platform: "linux" });
      const progress: PersonalServiceProgress = {};
      await refreshPersonalService(newRelease, host.deps, progress);
      await restorePersonalService(oldRelease, host.deps, progress);
      expect(host.cli).toEqual([{ release: newRelease, args: ["service"] }, { release: oldRelease, args: ["service"] }]);
      expect(host.launchctl).toEqual([]);
    });

    test("a first macOS service install needs --service and is never rolled back by repair", async () => {
      const refused = fakeHost();
      await expect(refreshPersonalService(newRelease, refused.deps)).rejects.toThrow("--service");
      expect(refused.cli).toEqual([]);
      expect(refused.effects).toEqual([]);

      const host = fakeHost({ installRequested: true });
      const progress: PersonalServiceProgress = {};
      await refreshPersonalService(newRelease, host.deps, progress);
      expect(host.cli).toEqual([{ release: newRelease, args: ["service", "install"] }]);
      expect(host.files.get(plistPath)).toBe(plistFor(`${root}/current`));
      expect(host.logs.join("\n")).toContain("one-time reload");
      // Bare `service` from the previous release would now be repair -> bootout + bootstrap.
      const before = host.effects.length;
      await restorePersonalService(oldRelease, host.deps, progress);
      expect(host.cli).toHaveLength(1);
      expect(host.effects).toHaveLength(before);
      expect(host.logs.join("\n")).toContain("launchctl bootout");
    });

    test("no update or rollback path stops, reloads, or runs a Codex-restoring verb", async () => {
      const forbidden = ["stop", "restore", "disconnect", "sync", "uninstall", "remove", "bootout", "bootstrap", "unload"];
      const seen: string[][] = [];
      for (const options of [{ plist: plistFor(oldRelease) }, { plist: plistFor(oldRelease), healthy: false }, { platform: "linux" as const }]) {
        const host = fakeHost(options);
        const progress: PersonalServiceProgress = {};
        await refreshPersonalService(newRelease, host.deps, progress).catch(() => undefined);
        await restorePersonalService(oldRelease, host.deps, progress).catch(() => undefined);
        seen.push(...host.cli.map(call => call.args), ...host.launchctl);
        expect(host.effects.filter(effect => effect !== "systemctl restart")).toEqual([]);
      }
      expect(seen.filter(args => args.some(arg => forbidden.includes(arg)))).toEqual([]);

      const source = (await readText("scripts/personal-install.ts"))
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      // Catches `run(["stop"])`, `cli(release, "stop")`, `["service", "stop"]` and template forms.
      expect(source).not.toMatch(/["'`](?:stop|restore|disconnect|sync|uninstall|remove|unload)["'`]/);
    });

    test("the plist writer replaces a wider .next, keeps 0600, and refuses symlinks", () => {
      const fixture = mkdtempSync(join(tmpdir(), "ocx-personal-plist-"));
      try {
        const path = join(fixture, "com.opencodex.proxy.plist");
        writeFileSync(`${path}.next`, "stale", { mode: 0o644 });
        chmodSync(`${path}.next`, 0o644);
        writePrivateFileAtomic(path, "first");
        expect(readFileSync(path, "utf8")).toBe("first");
        expect(mode(path)).toBe(0o600);
        writePrivateFileAtomic(path, "second");
        expect(readFileSync(path, "utf8")).toBe("second");
        expect(mode(path)).toBe(0o600);
        const link = join(fixture, "linked.plist");
        symlinkSync(path, link);
        expect(() => writePrivateFileAtomic(link, "third")).toThrow("symlink");
        expect(readFileSync(path, "utf8")).toBe("second");
      } finally { removeModeFixture(fixture); }
    });
  });

  test.skipIf(process.platform === "win32")("personal install keeps the previous release on activation failure", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "ocx-personal-"));
    try {
      const oldRelease = join(fixture, "old");
      const newRelease = join(fixture, "new");
      mkdirSync(oldRelease);
      mkdirSync(newRelease);
      symlinkSync(oldRelease, join(fixture, "current"));
      await expect(activatePersonalRelease(fixture, newRelease, async () => {
        expect(readlinkSync(join(fixture, "current"))).toBe(newRelease);
        throw new Error("service failed");
      })).rejects.toThrow("service failed");
      expect(readlinkSync(join(fixture, "current"))).toBe(oldRelease);
      await activatePersonalRelease(fixture, newRelease, async () => {});
      expect(readlinkSync(join(fixture, "current"))).toBe(newRelease);
    } finally { removeModeFixture(fixture); }
  });

  test.skipIf(process.platform === "win32")("personal launcher sends updates to our source installer and preserves arguments", () => {
    const fixture = mkdtempSync(join(tmpdir(), "ocx-personal-'quoted-"));
    try {
      const bun = join(fixture, "fake bun");
      writeExecutable(bun, '#!/bin/sh\nprintf "%s\\n" "$@"\n');
      const launcher = join(fixture, "ocx");
      writeExecutable(launcher, personalLauncher(fixture, bun));
      const result = spawnSync(launcher, ["update", "--check"], { encoding: "utf8" });
      expect(result.status).toBe(0);
      expect(result.stdout.trim().split("\n")).toEqual([
        join(fixture, "current", "scripts", "personal-install.ts"), "--check",
      ]);
    } finally { removeModeFixture(fixture); }
  });

  test("npm package main is a Node-safe wrapper while Bun keeps the TypeScript API", async () => {
    const pkg = JSON.parse(await readText("package.json")) as {
      main?: string;
      exports?: { "."?: { bun?: string; default?: string } };
      dependencies?: Record<string, string>;
      testRunnerBun?: string;
      devDependencies?: Record<string, string>;
      scripts?: Record<string, string>;
      files?: string[];
    };

    expect(pkg.main).toBe("./bin/package-main.mjs");
    expect(pkg.exports?.["."]?.bun).toBe("./src/index.ts");
    expect(pkg.exports?.["."]?.default).toBe("./bin/package-main.mjs");
    // Bun 1.4.2 fixes the Windows fetch streaming regression reported in #6684.
    // CI's testRunnerBun skipped 1.4.2: it segfaults while RE-LOADING the bunfig
    // preload that `--isolate` re-enters once per test file:
    // `load_preloads -> JSModuleLoader::loadModule -> JSPromise::status` dereferences a dead
    // promise and the process dies with "Segmentation fault at address 0x10". It is a crash in
    // the interpreter, not a test result, and no test content avoids it.
    //
    // The A/B is two Linux CI runs 40 minutes apart, either side of #4064 (02bc10e8af), which
    // is the commit that moved this line to 1.4.2:
    //   run 34274464811, 6bd3274ab2, Bun 1.4.0 -- 0 panics across all four shards
    //   run 34278407438, 02bc10e8af, Bun 1.4.2 -- 12 panics across all four shards
    // Every sampled 1.4.0 tree is clean and every sampled 1.4.2 tree crashes 12-14 times per
    // run. Linux hid it because `scripts/ci/run-bun-test-batches.sh` re-runs a crashed batch one
    // file per process, and one preload load cannot reach the second that faults, so the sweep
    // always "passes". Windows had no such sweep: shard 5/6 died on both attempts of runs
    // 35087572377, 35093667426 and 35098735960, always at the 67th file, and the file sitting at
    // that position changed between them.
    //
    // #4821 (2026-09-17) reverted #4064 (2026-09-09). #6713 run 37631558263 reproduced
    // the crash on Linux 1/4, macOS 2/2 and Windows 9/9; individual files pass.
    // Today's diagnostic sweep cannot turn a crashed primary batch green.
    //
    // testRunnerBun then moved from 1.4.0 to 1.4.3 for oven-sh/bun#44581 (#4956): 1.4.0's
    // Bun.spawnSync lost a child's exit once finalizers released polls on its private wait loop,
    // and spun past its own timeout. Scratch run 38213764818 stalled 8 of 252 Linux shard 1/4
    // batch-5 runs that way (CLI child a zombie, its pidfd armed but never polled).
    // tests/ci-workflows/test-runner-spawnsync-finalizer.test.ts keeps the runner above it.
    // Rejoin after the upstream runner crash is fixed and a green `lane=all` dispatch
    // proves the unified version; then delete testRunnerBun and the setup action's role.
    expect(pkg.dependencies?.bun).toBe("1.4.2");
    expect(pkg.testRunnerBun).toBe("1.4.3");
    expect(pkg.dependencies?.zod).toBe("4.4.3");
    expect(pkg.devDependencies?.typescript).toBe("7.0.2");
    expect(pkg.devDependencies?.["@types/bun"]).toBe("1.4.0");
    expect(pkg.scripts?.dev).toBe("bun run src/cli/index.ts start");
    expect(pkg.scripts?.["dev:proxy"]).toBe("bun run src/cli/index.ts start");
    expect(pkg.scripts?.["dev:gui"]).toBe("cd gui && bun run dev");
    expect(pkg.scripts?.["prepare:package"]).toBe("bun scripts/prepare-package.ts");
    expect(pkg.scripts?.prepack).toBe("bun run prepare:package");
    expect(pkg.files).toContain("assets/banner.png");
    expect(pkg.files).toContain("assets/architecture.png");
    expect(pkg.files).toContain("assets/claude-code-models.gif");
    expect(pkg.files).toContain("assets/codex-app-picker.png");
  });

  test("Node can import the package main without executing the CLI", () => {
    const result = spawnSync("node", [
      "-e",
      "import('./bin/package-main.mjs').then(m => { if (m.cliCommand !== 'ocx') process.exit(2); })",
    ], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
  });

  test("npmignore keeps GUI development docs out of the package", async () => {
    const npmignore = await readText(".npmignore");
    const guiNpmignore = await readText("gui/.npmignore");
    const guiReadme = await readText("gui/README.md");

    expect(npmignore).toContain("gui/README.md");
    expect(guiNpmignore).toContain("README.md");
    expect(guiReadme).toContain("opencodex dashboard");
    expect(guiReadme).toContain("bun run dev:proxy");
    expect(guiReadme).toContain("bun run dev:gui");
    expect(guiReadme).not.toContain("This template provides a minimal setup");
  });

  test("POSIX installer matches the Node launcher prerequisite", async () => {
    const script = await readText("scripts/install.sh");

    expect(script).toContain("Node.js 18+ is required");
    expect(script).toContain("npm install -g @bitkyc08/opencodex");
    expect(script).toContain("command -v ocx");
    expect(script).toContain("ocx help");
    expect(script).not.toContain("bun install -g @bitkyc08/opencodex");
    expect(script).not.toContain("bun.sh/install");
  });

  test("PowerShell installer matches the Node launcher prerequisite", async () => {
    const script = await readText("scripts/install.ps1");

    expect(script).toContain("Node.js 18+ is required");
    expect(script).toContain("& $npm.Source install -g @bitkyc08/opencodex");
    expect(script).toContain("$LASTEXITCODE");
    expect(script).toContain("Get-Command ocx.cmd");
    expect(script).toContain("Get-Command ocx");
    expect(script).toContain("& $ocx.Source help");
    expect(script).not.toContain("bun install -g @bitkyc08/opencodex");
    expect(script).not.toContain("bun.sh/install.ps1");
  });

  test.skipIf(process.platform === "win32")(
    "restart helper launches without setsid in PATH",
    async () => {
      const fixtureRoot = mkdtempSync(join(tmpdir(), "ocx-restart-no-setsid-"));
      const home = join(fixtureRoot, "home");
      const binDir = join(fixtureRoot, "bin");
      const callsPath = join(fixtureRoot, "bun-calls.log");
      const restartLog = join(fixtureRoot, "restart.log");

      try {
        mkdirSync(join(home, ".opencodex"), { recursive: true });
        mkdirSync(binDir, { recursive: true });
        for (const command of ["cat", "dirname", "nohup", "rm", "seq", "tail"]) {
          symlinkSync(systemCommandPath(command), join(binDir, command));
        }
        writeExecutable(join(binDir, "sleep"), "#!/bin/sh\n/bin/sleep 0.02\n");
        writeExecutable(join(binDir, "node"), "#!/bin/sh\nprintf '10100'\n");
        writeExecutable(join(binDir, "curl"), "#!/bin/sh\nexit 0\n");
        writeExecutable(join(binDir, "bun"), `#!/bin/sh
printf '%s\\n' "$*" >> "$OCX_TEST_CALLS"
if [ "$3" = "start" ]; then
  /bin/mkdir -p "$HOME/.opencodex"
  printf '{"port":10100}\\n' > "$HOME/.opencodex/runtime-port.json"
  printf '%s\\n' "$$" > "$HOME/.opencodex/ocx.pid"
fi
exit 0
`);

        const result = spawnSync("/bin/bash", [join(repoRoot, "scripts/ocx-restart.sh")], {
          cwd: repoRoot,
          encoding: "utf8",
          env: {
            HOME: home,
            PATH: binDir,
            OCX_RESTART_LOG: restartLog,
            OCX_TEST_CALLS: callsPath,
          },
          timeout: 10_000,
        });

        expect(result.status).toBe(0);
        expect(result.stdout).toContain("[ocx-restart] healthy on port 10100");
        expect((await Bun.file(callsPath).text()).trim().split("\n")).toEqual([
          "run src/cli/index.ts stop",
          "run src/cli/index.ts start",
        ]);
      } finally {
        removeModeFixture(fixtureRoot);
      }
    },
  );

  test("Node launcher handles package-manager self-update before starting Bun", async () => {
    const launcher = await readText("bin/ocx.mjs");

    expect(launcher).toContain('process.argv[2] === "update"');
    expect(launcher).toContain('["install", "-g", `${PKG}@${tag}`]');
    expect(launcher).toContain('["add", "-g", "--allow-build=bun", `${PKG}@${tag}`]');
    expect(launcher).toContain('return String(currentVersion).includes("-preview.") ? "preview" : "latest"');
    expect(launcher).toContain("!isBunGlobalInstall()");
    expect(launcher).toContain("repairCodexShimIfNeeded(postUpdateLauncher)");
    expect(launcher).toContain("runNpmSelfUpdate()");
    expect(launcher).toContain("runPnpmSelfUpdate()");
  });

  test("release helper watches the workflow run it just dispatched", async () => {
    const script = await readText("scripts/release.ts");

    expect(script).toContain("waitForReleaseWorkflowRun");
    // The invariant is that the dispatched run is located by workflow, branch
    // and commit — not that the call is a shell string. Every external command
    // now goes through the shared launcher as an argv array, because Bun.$
    // resolved PATH itself and walked past the Windows `.cmd` test shims.
    expect(script).toContain('"gh", "run", "list", "--workflow", "release.yml", "--branch"');
    expect(script).toContain('"--commit"');
    expect(script).toContain("createdAt,databaseId,headSha,status,url");
    expect(script).toContain("await watchRun(releaseRun.databaseId)");
  });

  test.skipIf(process.platform === "win32")(
    "package mode normalization skips direct and nested filesystem links",
    () => {
      const fixtureRoot = mkdtempSync(join(tmpdir(), "ocx-package-modes-"));
      const packageRoot = join(fixtureRoot, "package");
      const externalRoot = join(fixtureRoot, "external");
      const externalLauncher = join(externalRoot, "package-main.mjs");
      const externalDirectory = join(externalRoot, "dashboard");
      const externalAsset = join(externalDirectory, "asset.js");

      try {
        mkdirSync(join(packageRoot, "bin"), { recursive: true });
        mkdirSync(join(packageRoot, "gui", "dist", "nested"), { recursive: true });
        mkdirSync(externalDirectory, { recursive: true });

        writeFileSync(join(packageRoot, "bin", "ocx.mjs"), "launcher");
        writeFileSync(join(packageRoot, "gui", "dist", "asset.js"), "asset");
        writeFileSync(join(packageRoot, "gui", "dist", "nested", "chunk.js"), "chunk");
        writeFileSync(externalLauncher, "external launcher");
        writeFileSync(externalAsset, "external asset");

        chmodSync(join(packageRoot, "bin", "ocx.mjs"), 0o600);
        chmodSync(join(packageRoot, "gui", "dist"), 0o700);
        chmodSync(join(packageRoot, "gui", "dist", "asset.js"), 0o600);
        chmodSync(join(packageRoot, "gui", "dist", "nested"), 0o700);
        chmodSync(join(packageRoot, "gui", "dist", "nested", "chunk.js"), 0o600);
        chmodSync(externalLauncher, 0o600);
        chmodSync(externalDirectory, 0o700);
        chmodSync(externalAsset, 0o600);

        const launcherLink = join(packageRoot, "bin", "package-main.mjs");
        const nestedDirectoryLink = join(packageRoot, "gui", "dist", "nested", "external");
        symlinkSync(externalLauncher, launcherLink, "file");
        symlinkSync(externalDirectory, nestedDirectoryLink, "dir");

        normalizePackageModes(packageRoot);

        expect(lstatSync(launcherLink).isSymbolicLink()).toBeTrue();
        expect(lstatSync(nestedDirectoryLink).isSymbolicLink()).toBeTrue();
        expect(mode(externalLauncher)).toBe(0o600);
        expect(mode(externalDirectory)).toBe(0o700);
        expect(mode(externalAsset)).toBe(0o600);
        expect(mode(join(packageRoot, "bin", "ocx.mjs"))).toBe(0o755);
        expect(mode(join(packageRoot, "gui", "dist"))).toBe(0o755);
        expect(mode(join(packageRoot, "gui", "dist", "asset.js"))).toBe(0o644);
        expect(mode(join(packageRoot, "gui", "dist", "nested"))).toBe(0o755);
        expect(mode(join(packageRoot, "gui", "dist", "nested", "chunk.js"))).toBe(0o644);
      } finally {
        try { chmodSync(externalLauncher, 0o600); } catch { /* best-effort cleanup */ }
        try { chmodSync(externalDirectory, 0o700); } catch { /* best-effort cleanup */ }
        try { chmodSync(externalAsset, 0o600); } catch { /* best-effort cleanup */ }
        removeModeFixture(fixtureRoot);
      }
    },
  );

  test("package mode normalization does not traverse a linked output root", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "ocx-package-root-link-"));
    const packageRoot = join(fixtureRoot, "package");
    const externalOutput = join(fixtureRoot, "external-output");
    const externalAsset = join(externalOutput, "asset.js");

    try {
      mkdirSync(join(packageRoot, "gui"), { recursive: true });
      mkdirSync(externalOutput, { recursive: true });
      writeFileSync(externalAsset, "external asset");
      chmodSync(externalOutput, 0o555);
      chmodSync(externalAsset, 0o444);

      const outputLink = join(packageRoot, "gui", "dist");
      symlinkSync(externalOutput, outputLink, process.platform === "win32" ? "junction" : "dir");
      const directoryModeBefore = mode(externalOutput);
      const assetModeBefore = mode(externalAsset);

      normalizePackageModes(packageRoot);

      expect(lstatSync(outputLink).isSymbolicLink()).toBeTrue();
      expect(mode(externalOutput)).toBe(directoryModeBefore);
      expect(mode(externalAsset)).toBe(assetModeBefore);
    } finally {
      try { chmodSync(externalAsset, 0o600); } catch { /* best-effort cleanup */ }
      try { chmodSync(externalOutput, 0o700); } catch { /* best-effort cleanup */ }
      removeModeFixture(fixtureRoot);
    }
  });
});
