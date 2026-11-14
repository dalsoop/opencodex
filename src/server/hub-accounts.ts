/**
 * `GET /v1/hub-accounts`: masked account list and quota for one fleet job.
 *
 * `/v1/hub-state` promises a data key never sees quota or account identity, so this route takes
 * no data key. It takes one dedicated read key from OPENCODEX_HUB_ACCOUNTS_READ_KEY, and without
 * that variable the route does not exist. The response leaves here already reduced to the last
 * four id characters, masked addresses and an allow-list of quota fields. The openai native-main
 * slot is left out only when the server checked and found no native Codex login on this hub.
 */
import { classifyAccount, fetchCodexRows, fetchRows, type AccountRow } from "../cli/account-api";
import type { OcxConfig } from "../types";
import { configuredPort, isAllowedRequestOrigin, secretEquals, withCors, type RequestPolicyView } from "./auth-cors";

export const HUB_ACCOUNTS_KEY_ENV = "OPENCODEX_HUB_ACCOUNTS_READ_KEY";
export const HUB_ACCOUNTS_HEADER = "x-opencodex-hub-accounts-key";
export const HUB_ACCOUNTS_PROVIDERS = ["anthropic", "openai", "xai"] as const;
const CACHE_MS = 30_000;
const QUOTA_FIELDS = ["fiveHourPercent", "fiveHourResetAt", "weeklyPercent", "weeklyResetAt", "monthlyPercent", "monthlyResetAt", "updatedAt"] as const;

type ListRows = (provider: string) => Promise<AccountRow[]>;
type Body = Record<string, unknown>;

function maskAddress(value: string | undefined): string | null {
  if (!value) return null;
  const at = value.indexOf("@");
  if (at < 0 || value.includes("*")) return value.slice(0, 64);
  const local = value.slice(0, at);
  const shown = local.length <= 1 ? local : `${local[0]}***${local.at(-1)}`;
  return `${shown}${value.slice(at)}`.slice(0, 64);
}

function projectQuota(quota: AccountRow["quota"]): Body | null {
  if (!quota || typeof quota !== "object") return null;
  const source = quota as unknown as Record<string, unknown>;
  const out: Body = {};
  for (const field of QUOTA_FIELDS) {
    if (typeof source[field] === "number") out[field] = source[field];
  }
  if (Array.isArray(source.customWindows)) {
    out.customWindows = source.customWindows.map(entry => {
      const window = entry as Record<string, unknown>;
      return { label: typeof window.label === "string" ? window.label.slice(0, 64) : null, percent: window.percent ?? null, resetAt: window.resetAt ?? null };
    });
  }
  return out;
}

/**
 * The native-main slot of a hub without a native Codex login. Only the server's checked absence
 * counts; a slot whose credential exists (even one needing reauth) or is unknown stays listed.
 */
function isEmptyNativeMain(row: AccountRow): boolean {
  return row.slotKind === "native-main" && row.id === "__main__" && row.hasCredential === false;
}

export function projectHubAccount(row: AccountRow): Body {
  return {
    id: String(row.id ?? "").slice(-4),
    label: maskAddress(row.label),
    email: maskAddress(row.email),
    active: row.active === true,
    paused: row.paused === true,
    needsReauth: row.needsReauth === true,
    health: row.health ?? null,
    quotaUnavailable: row.quotaUnavailable === true,
    quota: projectQuota(row.quota),
  };
}

let cache: { at: number; body: Body } | null = null;
let inFlight: Promise<Body> | null = null;

export function resetHubAccountsCacheForTest(): void {
  cache = null;
  inFlight = null;
}

async function readAccounts(listRows: ListRows, now: number): Promise<Body> {
  if (cache && now - cache.at >= 0 && now - cache.at < CACHE_MS) return cache.body;
  inFlight ??= (async () => {
    const providers: Body = {};
    for (const provider of HUB_ACCOUNTS_PROVIDERS) {
      const rows = await listRows(provider);
      providers[provider] = rows.filter(row => row.provider === provider && !isEmptyNativeMain(row)).map(projectHubAccount);
    }
    const body = { schemaVersion: 1, fetchedAt: new Date(now).toISOString(), providers };
    cache = { at: now, body };
    return body;
  })().finally(() => { inFlight = null; });
  return inFlight;
}

export async function answerHubAccounts(
  presented: string | null,
  expected: string | undefined,
  listRows: ListRows,
  now = Date.now(),
): Promise<{ status: number; body: Body }> {
  if (!expected?.trim()) return { status: 404, body: { error: { code: "hub_accounts_not_enabled", message: "Not found" } } };
  if (!presented || !secretEquals(presented, expected)) {
    return { status: 401, body: { error: { code: "hub_accounts_unauthorized", message: "The account read key is required" } } };
  }
  try {
    return { status: 200, body: await readAccounts(listRows, now) };
  } catch {
    return { status: 503, body: { error: { code: "hub_accounts_unavailable", message: "An account list could not be read" } } };
  }
}

/**
 * The same local management read `ocx account list <provider> --quota --json` makes; the Codex
 * read also carries the native-main credential presence the server reported.
 */
function localApiRows(config: OcxConfig): ListRows {
  return async provider => {
    const classified = classifyAccount(config, provider);
    if ("error" in classified) return [];
    const base = `http://127.0.0.1:${configuredPort()}`;
    const result = classified.type === "codex"
      ? await fetchCodexRows({ baseUrl: base }, base, false, true, { mainCredential: true })
      : await fetchRows({ baseUrl: base }, base, provider, classified.type, {});
    if (result.networkDown || result.errorJson) throw new Error("account list unavailable");
    return result.rows;
  };
}

export async function handleHubAccounts(req: Request, config: OcxConfig, policy: RequestPolicyView): Promise<Response> {
  const reply = ({ status, body }: { status: number; body: Body }) =>
    withCors(Response.json(body, { status, headers: { "cache-control": "no-store" } }), req, policy);
  if (!isAllowedRequestOrigin(req, policy)) {
    return reply({ status: 403, body: { error: { code: "origin_rejected", message: "Cross-origin request blocked" } } });
  }
  return reply(await answerHubAccounts(req.headers.get(HUB_ACCOUNTS_HEADER), process.env[HUB_ACCOUNTS_KEY_ENV], localApiRows(config)));
}
