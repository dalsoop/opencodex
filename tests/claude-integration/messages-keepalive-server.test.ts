/**
 * Pre-upstream keep-alive on the real `/v1/messages` listener: a streamed turn whose upstream
 * is slow to answer gets `200 text/event-stream` and `ping` events first, then the upstream
 * stream; a late refusal becomes an Anthropic `error` event; a non-streamed turn is untouched.
 * Local fixtures only.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { startServer } from "../../src/server";
import type { OcxConfig } from "../../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { BACKGROUND_WORK_TEARDOWN_TIMEOUT_MS, removeTreeAfterBackgroundWork } from "../helpers/remove-tree";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";

let testDir = "";
let previousHome: string | undefined;
let previousCommit: string | undefined;
let previousInterval: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;
let releaseSpendHome: (() => void) | undefined;
let upstream: ReturnType<typeof Bun.serve> | undefined;
let proxy: ReturnType<typeof startServer> | undefined;
let upstreamDelayMs = 0;
let upstreamReply: (stream: boolean) => Response;

const MESSAGE = {
  id: "msg_fixture", type: "message", role: "assistant", model: "claude-x",
  content: [{ type: "text", text: "fixture reply" }], stop_reason: "end_turn", stop_sequence: null,
  usage: { input_tokens: 11, output_tokens: 3 },
};
const SSE = [
  ["message_start", { type: "message_start", message: { ...MESSAGE, content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 0 } } }],
  ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
  ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "streamed" } }],
  ["content_block_stop", { type: "content_block_stop", index: 0 }],
  ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 7 } }],
  ["message_stop", { type: "message_stop" }],
].map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  previousCommit = process.env.OPENCODEX_MESSAGES_KEEPALIVE_COMMIT_MS;
  previousInterval = process.env.OPENCODEX_MESSAGES_KEEPALIVE_INTERVAL_MS;
  // Commit as soon as the body says `stream: true`; the interval floor is 1 s.
  process.env.OPENCODEX_MESSAGES_KEEPALIVE_COMMIT_MS = "0";
  process.env.OPENCODEX_MESSAGES_KEEPALIVE_INTERVAL_MS = "1000";
  isolatedCodexHome = installIsolatedCodexHome("ocx-messages-keepalive-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-messages-keepalive-"));
  process.env.OPENCODEX_HOME = testDir;
  releaseSpendHome = acquireOwnedSpendHome();
  upstreamDelayMs = 0;
  upstreamReply = stream => stream
    ? new Response(SSE, { headers: { "content-type": "text/event-stream" } })
    : Response.json(MESSAGE);
  upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const body = await req.json() as { stream?: boolean };
    await Bun.sleep(upstreamDelayMs);
    return upstreamReply(body.stream === true);
  } });
  saveConfig({
    port: 0,
    clientIntegrations: { codex: false },
    defaultProvider: "anth",
    providers: { anth: {
      adapter: "anthropic", baseUrl: `http://127.0.0.1:${upstream.port}`, authMode: "key",
      apiKey: "fixture-key-alpha", allowPrivateNetwork: true, models: ["claude-x"],
    } },
    protocols: { rollout: { managedMessagesNative: true } },
  } as OcxConfig);
  proxy = startServer(0);
}, 10_000);

afterEach(async () => {
  const codexHome = isolatedCodexHome;
  isolatedCodexHome = null;
  try {
    try { await proxy?.stop(true); }
    finally {
      proxy = undefined;
      await upstream?.stop(true);
      upstream = undefined;
    }
    releaseSpendHome?.();
    releaseSpendHome = undefined;
    if (testDir) await removeTreeAfterBackgroundWork(testDir);
    testDir = "";
  } finally {
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    if (previousCommit === undefined) delete process.env.OPENCODEX_MESSAGES_KEEPALIVE_COMMIT_MS;
    else process.env.OPENCODEX_MESSAGES_KEEPALIVE_COMMIT_MS = previousCommit;
    if (previousInterval === undefined) delete process.env.OPENCODEX_MESSAGES_KEEPALIVE_INTERVAL_MS;
    else process.env.OPENCODEX_MESSAGES_KEEPALIVE_INTERVAL_MS = previousInterval;
    codexHome?.restoreEnvironment();
  }
  codexHome?.removeAfterDrain();
}, BACKGROUND_WORK_TEARDOWN_TIMEOUT_MS);

function post(stream: boolean): Promise<Response> {
  return fetch(new URL("/v1/messages", proxy!.url), {
    method: "POST",
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "anth/claude-x", max_tokens: 64, stream, messages: [{ role: "user", content: "hi" }] }),
  });
}

const eventNames = (text: string) => text.split("\n\n").filter(Boolean).map(frame => /^event: (\S+)/.exec(frame)?.[1] ?? "?");

test("a slow streamed turn gets headers and pings before the upstream stream", async () => {
  upstreamDelayMs = 2_300;
  const started = Date.now();
  const response = await post(true);
  // Headers arrive long before the upstream answers.
  expect(Date.now() - started).toBeLessThan(1_500);
  expect(response.status).toBe(200);
  expect(response.headers.get("x-opencodex-keepalive")).toBe("pre-upstream");
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  expect(response.headers.get("request-id")).toBeTruthy();
  const names = eventNames(await response.text());
  expect(names.filter(name => name === "ping").length).toBeGreaterThanOrEqual(2);
  expect(names.filter(name => name !== "ping")).toEqual([
    "message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop",
  ]);
}, 15_000);

test("a late refusal after the commit is one Anthropic error event", async () => {
  upstreamDelayMs = 1_200;
  upstreamReply = () => Response.json(
    { type: "error", error: { type: "invalid_request_error", message: "fixture refusal" } },
    { status: 400 },
  );
  const response = await post(true);
  expect(response.status).toBe(200);
  const text = await response.text();
  expect(eventNames(text).filter(name => name !== "ping")).toEqual(["error"]);
  const data = JSON.parse(/event: error\ndata: (.*)\n/.exec(text)![1]!) as { type: string; error: { type: string } };
  expect(data.type).toBe("error");
  expect(data.error.type).toBe("invalid_request_error");
}, 15_000);

test("a non-streamed turn keeps its own status and JSON body", async () => {
  upstreamDelayMs = 1_200;
  const response = await post(false);
  expect(response.status).toBe(200);
  expect(response.headers.get("x-opencodex-keepalive")).toBeNull();
  const json = await response.json() as { type?: string; content?: unknown[] };
  expect(json.type).toBe("message");
}, 15_000);

test("a fast streamed turn is not wrapped", async () => {
  process.env.OPENCODEX_MESSAGES_KEEPALIVE_COMMIT_MS = "5000";
  const response = await post(true);
  expect(response.status).toBe(200);
  expect(response.headers.get("x-opencodex-keepalive")).toBeNull();
  expect(eventNames(await response.text())[0]).toBe("message_start");
}, 15_000);
