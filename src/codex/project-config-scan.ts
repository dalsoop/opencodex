import { spawnWorker } from "../lib/worker-embed";
import type { ProjectCodexConfigWarning } from "./project-config-warnings";

/**
 * Runs the trusted-project config check on a worker thread.
 *
 * The check is advisory, but it opens a file inside every trusted project with
 * synchronous calls. A project on a slow disk or on a volume the OS holds behind a
 * privacy approval can hold one of those calls for minutes, and on the main thread that
 * stops the listener, so /healthz and every in-flight request stop too. On a worker the
 * listener keeps serving, and the deadline turns a stuck volume into a skipped check.
 * A worker does not see later process.env changes, so callers pass the config path.
 */
export const PROJECT_CONFIG_SCAN_DEADLINE_MS = 3_000;

export type ProjectConfigScanStatus = "complete" | "timed_out" | "failed";

export interface ProjectConfigScanResult {
  status: ProjectConfigScanStatus;
  warnings: ProjectCodexConfigWarning[];
}

export interface ProjectConfigScanDeps {
  spawn?: () => Worker;
  deadlineMs?: number;
}

function spawnScanWorker(): Worker {
  return spawnWorker(new URL("./project-config-scan-worker.ts", import.meta.url).href, "project-config-scan-worker");
}

export function scanProjectCodexConfigOffThread(
  options: { cwd?: string; codexConfigPath?: string } = {},
  deps: ProjectConfigScanDeps = {},
): Promise<ProjectConfigScanResult> {
  return new Promise(resolve => {
    let worker: Worker;
    try {
      worker = (deps.spawn ?? spawnScanWorker)();
    } catch {
      resolve({ status: "failed", warnings: [] });
      return;
    }
    let done = false;
    const finish = (result: ProjectConfigScanResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      // Not awaited: a thread stuck in a system call cannot acknowledge termination.
      void worker.terminate();
      resolve(result);
    };
    const timer = setTimeout(
      () => finish({ status: "timed_out", warnings: [] }),
      deps.deadlineMs ?? PROJECT_CONFIG_SCAN_DEADLINE_MS,
    );
    worker.onmessage = event => {
      const data = event.data as { ok?: boolean; warnings?: ProjectCodexConfigWarning[] } | null;
      finish(data?.ok === true && Array.isArray(data.warnings)
        ? { status: "complete", warnings: data.warnings }
        : { status: "failed", warnings: [] });
    };
    worker.onerror = () => finish({ status: "failed", warnings: [] });
    try {
      worker.postMessage({ cwd: options.cwd, codexConfigPath: options.codexConfigPath });
    } catch {
      finish({ status: "failed", warnings: [] });
    }
  });
}
