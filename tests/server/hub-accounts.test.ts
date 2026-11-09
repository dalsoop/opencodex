import { beforeEach, describe, expect, test } from "bun:test";
import type { AccountRow } from "../../src/cli/account-api";
import { answerHubAccounts, resetHubAccountsCacheForTest } from "../../src/server/hub-accounts";

const KEY = "read-key-for-tests";
const row = (provider: string, extra: Partial<AccountRow> = {}): AccountRow => ({
  provider, type: "oauth", id: "account-identifier-1234", email: "person@example.com", active: true, ...extra,
} as AccountRow);

describe("GET /v1/hub-accounts", () => {
  beforeEach(resetHubAccountsCacheForTest);

  test("does not exist without a configured key", async () => {
    expect((await answerHubAccounts(KEY, undefined, async () => [])).status).toBe(404);
    expect((await answerHubAccounts(KEY, "  ", async () => [])).status).toBe(404);
  });

  test("refuses a missing or wrong key before reading any account", async () => {
    let reads = 0;
    const list = async () => { reads++; return []; };
    expect((await answerHubAccounts(null, KEY, list)).status).toBe(401);
    expect((await answerHubAccounts("other", KEY, list)).status).toBe(401);
    expect(reads).toBe(0);
  });

  test("returns only masked identity and allow-listed quota fields", async () => {
    const { status, body } = await answerHubAccounts(KEY, KEY, async provider => provider === "anthropic" ? [row(provider, {
      label: "owner@example.com", upstreamAccountKey: "secret-upstream", masked: "sk-xx",
      quota: { weeklyPercent: 40, weeklyResetAt: 5, extra: "nope" } as unknown as AccountRow["quota"],
    })] : []);
    expect(status).toBe(200);
    const text = JSON.stringify(body);
    for (const leaked of ["account-identifier", "person@", "owner@", "secret-upstream", "sk-xx", "nope"]) expect(text).not.toContain(leaked);
    const account = (body.providers as Record<string, Record<string, unknown>[]>).anthropic[0];
    expect(account.id).toBe("1234");
    expect(account.email).toBe("p***n@example.com");
    expect(account.quota).toEqual({ weeklyPercent: 40, weeklyResetAt: 5 });
  });

  test("keeps only rows of the asked provider", async () => {
    const { body } = await answerHubAccounts(KEY, KEY, async () => [row("anthropic2")]);
    expect((body.providers as Record<string, unknown[]>).anthropic).toEqual([]);
  });

  test("a failed provider read answers 503 without details and is not cached", async () => {
    let fail = true;
    const list = async () => { if (fail) throw new Error("secret detail"); return []; };
    const failed = await answerHubAccounts(KEY, KEY, list, 1000);
    expect(failed.status).toBe(503);
    expect(JSON.stringify(failed.body)).not.toContain("secret detail");
    fail = false;
    expect((await answerHubAccounts(KEY, KEY, list, 1001)).status).toBe(200);
  });

  test("serves concurrent and recent reads from one upstream pass", async () => {
    let reads = 0;
    const list = async () => { reads++; return []; };
    await Promise.all([answerHubAccounts(KEY, KEY, list, 1000), answerHubAccounts(KEY, KEY, list, 1000)]);
    await answerHubAccounts(KEY, KEY, list, 20_000);
    expect(reads).toBe(3);
    await answerHubAccounts(KEY, KEY, list, 40_000);
    expect(reads).toBe(6);
  });
});
