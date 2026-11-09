import { collectProjectCodexConfigWarnings } from "./project-config-warnings";

onmessage = event => {
  try {
    const cwd = typeof event.data?.cwd === "string" ? event.data.cwd : undefined;
    const codexConfigPath = typeof event.data?.codexConfigPath === "string" ? event.data.codexConfigPath : undefined;
    postMessage({ ok: true, warnings: collectProjectCodexConfigWarnings({ cwd, codexConfigPath }) });
  } catch {
    postMessage({ ok: false });
  }
};
