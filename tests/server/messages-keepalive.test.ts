import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
  MESSAGES_KEEPALIVE_COMMIT_MS_DEFAULT,
  MESSAGES_KEEPALIVE_INTERVAL_MS_DEFAULT,
  messagesStreamIntent,
  noteMessagesStreamIntent,
  resolveMessagesKeepaliveSettings,
  withMessagesKeepalive,
} from "../../src/server/messages-keepalive";

const fast = { commitAfterMs: 20, intervalMs: 15 };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function request(): Request {
  return new Request("http://127.0.0.1/v1/messages", { method: "POST", body: "{}" });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function sse(frames: string[]): Response {
  return new Response(frames.join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
}

const MESSAGE_FRAMES = [
  "event: message_start\ndata: {\"type\":\"message_start\"}\n\n",
  "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
];

function events(text: string): string[] {
  return text.split("\n\n").filter(Boolean).map(frame => /^event: (\S+)/.exec(frame)?.[1] ?? "?");
}

describe("messages keep-alive", () => {
  test("a response that arrives before the commit delay is returned as is", async () => {
    const req = request();
    noteMessagesStreamIntent(req, { stream: true });
    const inner = new Response("{\"type\":\"error\"}", { status: 429, headers: { "retry-after": "3" } });
    const out = await withMessagesKeepalive(req, Promise.resolve(inner), fast, {
      finish: response => { response.headers.set("x-finished", "1"); return response; },
    });
    assert.equal(out.status, 429);
    assert.equal(out.headers.get("retry-after"), "3");
    assert.equal(out.headers.get("x-finished"), "1");
    assert.equal(out.headers.get("x-opencodex-keepalive"), null);
  });

  test("a waiting streamed request gets headers and pings, then the upstream stream", async () => {
    const req = request();
    noteMessagesStreamIntent(req, { stream: true, model: "claude-x" });
    const work = deferred<Response>();
    const out = await withMessagesKeepalive(req, work.promise, fast, {
      finishCommitted: response => { response.headers.set("request-id", "ocx-1"); return response; },
    });
    assert.equal(out.status, 200);
    assert.match(out.headers.get("content-type") ?? "", /text\/event-stream/);
    assert.equal(out.headers.get("x-opencodex-keepalive"), "pre-upstream");
    assert.equal(out.headers.get("request-id"), "ocx-1");
    await sleep(50);
    work.resolve(sse(MESSAGE_FRAMES));
    const seen = events(await out.text());
    assert.equal(seen[0], "ping");
    assert.ok(seen.filter(name => name === "ping").length >= 2, `pings: ${seen.join(",")}`);
    assert.deepEqual(seen.filter(name => name !== "ping"), ["message_start", "message_stop"]);
    // No ping after the upstream stream started.
    assert.equal(seen.lastIndexOf("ping") < seen.indexOf("message_start"), true);
  });

  test("an error answer after the commit becomes one Anthropic error event", async () => {
    const req = request();
    noteMessagesStreamIntent(req, { stream: true });
    const work = deferred<Response>();
    const out = await withMessagesKeepalive(req, work.promise, fast);
    work.resolve(Response.json(
      { type: "error", error: { type: "rate_limit_error", message: "All Anthropic OAuth accounts are temporarily rate-limited" } },
      { status: 429 },
    ));
    const text = await out.text();
    assert.equal(out.status, 200);
    assert.deepEqual(events(text).filter(name => name !== "ping"), ["error"]);
    const data = JSON.parse(/event: error\ndata: (.*)\n/.exec(text)![1]!);
    assert.deepEqual(data, { type: "error", error: { type: "rate_limit_error", message: "All Anthropic OAuth accounts are temporarily rate-limited" } });
  });

  test("a non-JSON error answer is mapped from its status", async () => {
    const req = request();
    noteMessagesStreamIntent(req, { stream: true });
    const work = deferred<Response>();
    const out = await withMessagesKeepalive(req, work.promise, fast);
    work.resolve(new Response("bad gateway", { status: 529 }));
    const data = JSON.parse(/event: error\ndata: (.*)\n/.exec(await out.text())![1]!);
    assert.equal(data.error.type, "overloaded_error");
    assert.match(data.error.message, /HTTP 529/);
  });

  test("a failure after the commit becomes an api_error event", async () => {
    const req = request();
    noteMessagesStreamIntent(req, { stream: true });
    const work = deferred<Response>();
    const out = await withMessagesKeepalive(req, work.promise, fast);
    work.reject(new Error("boom"));
    const text = await out.text();
    const data = JSON.parse(/event: error\ndata: (.*)\n/.exec(text)![1]!);
    assert.equal(data.error.type, "api_error");
    assert.match(data.error.message, /boom/);
  });

  test("a non-streamed request is never committed", async () => {
    const req = request();
    noteMessagesStreamIntent(req, { stream: false });
    const work = deferred<Response>();
    const out = withMessagesKeepalive(req, work.promise, fast);
    await sleep(60);
    work.resolve(Response.json({ type: "error", error: { type: "api_error", message: "late" } }, { status: 502 }));
    const response = await out;
    assert.equal(response.status, 502);
    assert.equal(response.headers.get("x-opencodex-keepalive"), null);
  });

  test("a request whose body is parsed after the delay commits once it says stream", async () => {
    const req = request();
    const work = deferred<Response>();
    const out = withMessagesKeepalive(req, work.promise, fast);
    await sleep(40);
    assert.equal(messagesStreamIntent(req), undefined);
    noteMessagesStreamIntent(req, { stream: true });
    const response = await out;
    assert.equal(response.headers.get("x-opencodex-keepalive"), "pre-upstream");
    work.resolve(sse(MESSAGE_FRAMES));
    assert.deepEqual(events(await response.text()).filter(name => name !== "ping"), ["message_start", "message_stop"]);
  });

  test("an aborted request is not committed", async () => {
    const controller = new AbortController();
    const req = new Request("http://127.0.0.1/v1/messages", { method: "POST", body: "{}", signal: controller.signal });
    noteMessagesStreamIntent(req, { stream: true });
    controller.abort();
    const work = deferred<Response>();
    const out = withMessagesKeepalive(req, work.promise, fast);
    await sleep(40);
    work.resolve(new Response(null, { status: 499 }));
    assert.equal((await out).status, 499);
  });

  test("cancelling the committed stream cancels the late upstream body", async () => {
    const req = request();
    noteMessagesStreamIntent(req, { stream: true });
    const work = deferred<Response>();
    const out = await withMessagesKeepalive(req, work.promise, fast);
    await out.body!.cancel("client left");
    let cancelled = false;
    const upstream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    work.resolve(new Response(upstream, { status: 200, headers: { "content-type": "text/event-stream" } }));
    await sleep(10);
    assert.equal(cancelled, true);
  });

  test("disabled settings return the work's response unchanged", async () => {
    const req = request();
    noteMessagesStreamIntent(req, { stream: true });
    const work = deferred<Response>();
    const out = withMessagesKeepalive(req, work.promise, null);
    await sleep(40);
    work.resolve(new Response("x", { status: 503 }));
    assert.equal((await out).status, 503);
  });
});

describe("messages keep-alive settings", () => {
  test("defaults", () => {
    assert.deepEqual(resolveMessagesKeepaliveSettings({}), {
      commitAfterMs: MESSAGES_KEEPALIVE_COMMIT_MS_DEFAULT,
      intervalMs: MESSAGES_KEEPALIVE_INTERVAL_MS_DEFAULT,
    });
  });
  test("off disables, values are read, interval has a floor", () => {
    assert.equal(resolveMessagesKeepaliveSettings({ OPENCODEX_MESSAGES_KEEPALIVE_COMMIT_MS: "off" }), null);
    assert.deepEqual(resolveMessagesKeepaliveSettings({
      OPENCODEX_MESSAGES_KEEPALIVE_COMMIT_MS: "0",
      OPENCODEX_MESSAGES_KEEPALIVE_INTERVAL_MS: "10",
    }), { commitAfterMs: 0, intervalMs: 1000 });
    assert.deepEqual(resolveMessagesKeepaliveSettings({ OPENCODEX_MESSAGES_KEEPALIVE_COMMIT_MS: "nonsense" }), {
      commitAfterMs: MESSAGES_KEEPALIVE_COMMIT_MS_DEFAULT,
      intervalMs: MESSAGES_KEEPALIVE_INTERVAL_MS_DEFAULT,
    });
  });
});
