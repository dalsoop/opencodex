/**
 * Keep a streamed Messages request alive while the proxy has not answered yet.
 *
 * A Messages turn can wait locally before the upstream answers with headers: account
 * selection, a same-target 429 wait, an OAuth refresh, pacing. Nothing reaches the client
 * meanwhile, and a reverse proxy in front of the hub (a Cloudflare tunnel closes a request
 * with 524 after ~100 s without response headers) cuts the request even though the hub
 * would have answered.
 *
 * Once a request that asked for `stream: true` has waited `commitAfterMs` without a response,
 * this commits a `200 text/event-stream` response and sends an Anthropic `ping` event right
 * away and every `intervalMs` after that. The Anthropic SDKs skip `ping` events. When the
 * proxy's own response arrives it is spliced in: a streamed success is relayed unchanged; any
 * other answer becomes one Anthropic `error` event, because the HTTP status is already sent.
 *
 * Requests that finish before `commitAfterMs` keep their real status and headers, so fast
 * refusals (401, 429 with Retry-After, 400) are unchanged. Non-streamed requests are never
 * committed: a JSON client reads the status code before the body, and a late 4xx/5xx sent
 * as 200 would be parsed as a message.
 */

const PING_FRAME = new TextEncoder().encode("event: ping\ndata: {\"type\": \"ping\"}\n\n");
const MAX_ERROR_BODY_BYTES = 64 * 1024;
/** How often a waiting request re-checks whether its body has said `stream: true`. */
const STREAM_INTENT_POLL_MS = 250;

export const MESSAGES_KEEPALIVE_COMMIT_MS_DEFAULT = 30_000;
export const MESSAGES_KEEPALIVE_INTERVAL_MS_DEFAULT = 15_000;
const MIN_ENV_INTERVAL_MS = 1_000;

export interface MessagesKeepaliveSettings {
  /** How long a streamed request may wait before the keep-alive response is committed. */
  commitAfterMs: number;
  /** Interval between `ping` events while the proxy's own response is still pending. */
  intervalMs: number;
}

function parseMs(raw: string | undefined, fallback: number): number | null {
  if (raw === undefined || raw.trim() === "") return fallback;
  const text = raw.trim().toLowerCase();
  if (text === "off" || text === "false" || text === "disabled") return null;
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0) return fallback;
  return Math.floor(value);
}

/**
 * Settings from the environment. `OPENCODEX_MESSAGES_KEEPALIVE_COMMIT_MS` (default 30000;
 * `off` disables the keep-alive) and `OPENCODEX_MESSAGES_KEEPALIVE_INTERVAL_MS` (default
 * 15000, at least 1000).
 */
export function resolveMessagesKeepaliveSettings(
  env: Record<string, string | undefined> = process.env,
): MessagesKeepaliveSettings | null {
  const commitAfterMs = parseMs(env.OPENCODEX_MESSAGES_KEEPALIVE_COMMIT_MS, MESSAGES_KEEPALIVE_COMMIT_MS_DEFAULT);
  if (commitAfterMs === null) return null;
  const interval = parseMs(env.OPENCODEX_MESSAGES_KEEPALIVE_INTERVAL_MS, MESSAGES_KEEPALIVE_INTERVAL_MS_DEFAULT);
  if (interval === null) return null;
  return { commitAfterMs, intervalMs: Math.max(interval, MIN_ENV_INTERVAL_MS) };
}

const streamIntent = new WeakMap<Request, boolean>();

/** Record, once the Messages body is parsed, whether the caller asked for a streamed answer. */
export function noteMessagesStreamIntent(req: Request, body: unknown): void {
  const stream = typeof body === "object" && body !== null && !Array.isArray(body)
    && (body as Record<string, unknown>).stream === true;
  streamIntent.set(req, stream);
}

/** `undefined` until the body has been parsed. */
export function messagesStreamIntent(req: Request): boolean | undefined {
  return streamIntent.get(req);
}

const ERROR_TYPE_BY_STATUS: Record<number, string> = {
  400: "invalid_request_error",
  401: "authentication_error",
  403: "permission_error",
  404: "not_found_error",
  413: "request_too_large",
  429: "rate_limit_error",
  503: "overloaded_error",
  529: "overloaded_error",
};

function errorFrame(type: string, message: string): Uint8Array {
  const data = JSON.stringify({ type: "error", error: { type, message } });
  return new TextEncoder().encode(`event: error\ndata: ${data}\n\n`);
}

async function readBoundedText(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < MAX_ERROR_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    if (size >= MAX_ERROR_BODY_BYTES) reader.cancel().catch(() => undefined);
    else reader.releaseLock();
  }
  const all = new Uint8Array(Math.min(size, MAX_ERROR_BODY_BYTES));
  let offset = 0;
  for (const chunk of chunks) {
    const room = all.byteLength - offset;
    if (room <= 0) break;
    all.set(chunk.subarray(0, room), offset);
    offset += Math.min(room, chunk.byteLength);
  }
  return new TextDecoder().decode(all);
}

/** One Anthropic `error` event for a response that can no longer carry its own status. */
export async function errorFrameForResponse(response: Response): Promise<Uint8Array> {
  const fallbackType = ERROR_TYPE_BY_STATUS[response.status] ?? "api_error";
  let text = "";
  try { text = await readBoundedText(response); } catch { /* keep the status-only answer */ }
  try {
    const parsed = JSON.parse(text) as { error?: { type?: unknown; message?: unknown } };
    const type = typeof parsed.error?.type === "string" ? parsed.error.type : fallbackType;
    const message = typeof parsed.error?.message === "string"
      ? parsed.error.message
      : `opencodex: upstream answered HTTP ${response.status}`;
    return errorFrame(type, message);
  } catch {
    return errorFrame(fallbackType, `opencodex: upstream answered HTTP ${response.status}`);
  }
}

function isStreamedSuccess(response: Response): boolean {
  return response.ok && response.body !== null
    && (response.headers.get("content-type") ?? "").toLowerCase().includes("text/event-stream");
}

type WorkOutcome = { response: Response } | { error: unknown };

export interface MessagesKeepaliveOptions {
  /** Applied to the proxy's own response when it is returned before any commit. */
  finish?: (response: Response) => Response;
  /** Applied to the committed keep-alive response (CORS, request id). */
  finishCommitted?: (response: Response) => Response;
}

/**
 * Return `work`'s response, or — when a streamed request has waited `commitAfterMs` — a
 * committed SSE response that pings until `work` settles and then carries its answer.
 */
export function withMessagesKeepalive(
  req: Request,
  work: Promise<Response>,
  settings: MessagesKeepaliveSettings | null,
  options: MessagesKeepaliveOptions = {},
): Promise<Response> {
  const finish = options.finish ?? (response => response);
  if (!settings) return work.then(finish);
  const finishCommitted = options.finishCommitted ?? (response => response);

  return new Promise<Response>((resolve, reject) => {
    let committed = false;
    let done = false;
    let commitTimer: ReturnType<typeof setTimeout> | undefined;
    let pollTimer: ReturnType<typeof setInterval> | undefined;
    const stopWaiting = () => {
      if (commitTimer) clearTimeout(commitTimer);
      if (pollTimer) clearInterval(pollTimer);
      commitTimer = undefined;
      pollTimer = undefined;
    };

    // Filled in only after a commit: hands work's outcome to the committed stream.
    let deliver: ((outcome: WorkOutcome) => void) | undefined;
    const settle = (make: () => Response) => {
      try { resolve(make()); } catch (error) { reject(error); }
    };

    const commit = () => {
      committed = true;
      stopWaiting();
      let pingTimer: ReturnType<typeof setInterval> | undefined;
      let closed = false;
      let innerReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let outcome: Promise<WorkOutcome> | undefined;
      const stopPings = () => {
        if (pingTimer) clearInterval(pingTimer);
        pingTimer = undefined;
      };
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(PING_FRAME);
          pingTimer = setInterval(() => {
            if (closed) return;
            try { controller.enqueue(PING_FRAME); } catch { stopPings(); }
          }, settings.intervalMs);
          outcome = new Promise<WorkOutcome>(resolveOutcome => {
            deliver = result => {
              // Stop pings before any upstream byte, so no ping lands inside a split frame.
              stopPings();
              if (closed) {
                if ("response" in result) result.response.body?.cancel().catch(() => undefined);
                return;
              }
              resolveOutcome(result);
            };
          });
        },
        // Pull-driven, so a slow client back-pressures the upstream body exactly as before the commit.
        async pull(controller) {
          if (closed) return;
          if (!innerReader) {
            const result = await outcome!;
            if (closed) return;
            if ("error" in result) {
              const message = result.error instanceof Error && result.error.message ? result.error.message : "request failed";
              controller.enqueue(errorFrame("api_error", `opencodex: ${message}`));
              closed = true;
              controller.close();
              return;
            }
            if (!isStreamedSuccess(result.response)) {
              const frame = await errorFrameForResponse(result.response);
              if (closed) return;
              controller.enqueue(frame);
              closed = true;
              controller.close();
              return;
            }
            innerReader = result.response.body!.getReader();
          }
          try {
            const { done: eof, value } = await innerReader.read();
            if (closed) return;
            if (eof) { closed = true; controller.close(); return; }
            controller.enqueue(value);
          } catch (error) {
            if (closed) return;
            closed = true;
            controller.error(error);
          }
        },
        cancel(reason) {
          closed = true;
          stopPings();
          innerReader?.cancel(reason).catch(() => undefined);
        },
      }, { highWaterMark: 0 });
      settle(() => finishCommitted(new Response(body, {
        status: 200,
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          "x-accel-buffering": "no",
          "x-opencodex-keepalive": "pre-upstream",
        },
      })));
    };

    const tryCommit = () => {
      if (committed || done) return;
      if (req.signal.aborted) { stopWaiting(); return; }
      if (streamIntent.get(req) !== true) {
        // Body not parsed yet: keep checking. A non-streamed request is never committed.
        if (streamIntent.get(req) === false) stopWaiting();
        else if (!pollTimer) pollTimer = setInterval(tryCommit, Math.min(STREAM_INTENT_POLL_MS, settings.intervalMs));
        return;
      }
      commit();
    };
    commitTimer = setTimeout(tryCommit, settings.commitAfterMs);

    work.then(
      response => {
        done = true;
        stopWaiting();
        if (!committed) { settle(() => finish(response)); return; }
        deliver?.({ response });
      },
      error => {
        done = true;
        stopWaiting();
        if (!committed) { reject(error); return; }
        deliver?.({ error });
      },
    );
  });
}
