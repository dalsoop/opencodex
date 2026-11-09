import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanProjectCodexConfigOffThread } from "../../src/codex/project-config-scan";

const stuckWorker = () => new Worker(URL.createObjectURL(new Blob(
  ["Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);"],
  { type: "text/javascript" },
)));

describe("scanProjectCodexConfigOffThread", () => {
  let dir: string;
  let savedHome: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ocx-project-scan-"));
    savedHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = join(dir, "home");
    mkdirSync(process.env.CODEX_HOME, { recursive: true });
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = savedHome;
    rmSync(dir, { recursive: true, force: true });
  });

  test("returns the warnings of a trusted project from the worker", async () => {
    const project = join(dir, "proj");
    mkdirSync(join(project, ".codex"), { recursive: true });
    writeFileSync(join(project, ".codex", "config.toml"), 'model_provider = "anthropic"\n[model_providers.anthropic]\nname = "anthropic"\n');
    writeFileSync(join(process.env.CODEX_HOME!, "config.toml"), `model_provider = "opencodex"\n\n[projects.'${project}']\ntrust_level = "trusted"\n`);
    const result = await scanProjectCodexConfigOffThread({ cwd: dir, codexConfigPath: join(process.env.CODEX_HOME!, "config.toml") });
    expect(result.status).toBe("complete");
    expect(result.warnings.map(w => w.code)).toContain("model_providers_table");
  });

  test("a stuck worker becomes a skipped check and the event loop keeps running", async () => {
    let ticks = 0;
    const interval = setInterval(() => { ticks += 1; }, 10);
    const started = Date.now();
    const result = await scanProjectCodexConfigOffThread({}, { spawn: stuckWorker, deadlineMs: 150 });
    clearInterval(interval);
    expect(result).toEqual({ status: "timed_out", warnings: [] });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(ticks).toBeGreaterThanOrEqual(3);
  });

  test("a worker that cannot start is reported as failed", async () => {
    const result = await scanProjectCodexConfigOffThread({}, { spawn: () => { throw new Error("no worker"); } });
    expect(result).toEqual({ status: "failed", warnings: [] });
  });

  test("a stuck worker does not keep the process from exiting", () => {
    const moduleUrl = new URL("../../src/codex/project-config-scan.ts", import.meta.url).href;
    const script = `const { scanProjectCodexConfigOffThread: scan } = await import(${JSON.stringify(moduleUrl)});
const spawn = () => new Worker(URL.createObjectURL(new Blob(["Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);"], { type: "text/javascript" })));
const r = await scan({}, { spawn, deadlineMs: 50 });
console.log(r.status);
process.exit(0);`;
    const child = spawnSync(process.execPath, ["--eval", script], { timeout: 8_000, encoding: "utf8" });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    expect(child.stdout.trim()).toBe("timed_out");
  });
});
