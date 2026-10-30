import { expect, spyOn, test } from "bun:test";
import { cmdAccount } from "../../src/cli/account";
import type { AccountDeps } from "../../src/cli/account-api";

const subscription = {
  activeStart: "2026-09-18T17:15:31+00:00",
  activeUntil: "2026-10-18T17:15:31+00:00",
  lastChecked: null,
};

for (const quota of [false, true]) {
  test(`account list JSON whitelists subscription dates${quota ? " with quota" : ""}`, async () => {
    const paths: string[] = [];
    const deps: AccountDeps = {
      baseUrl: "http://127.0.0.1:1",
      loadConfigImpl: () => ({ port: 0, defaultProvider: "openai", providers: {
        openai: { adapter: "openai-responses", codexAccountMode: "pool" },
      } }),
      fetchImpl: (async (input: string | URL | Request) => {
        const url = new URL(String(input));
        paths.push(url.pathname + url.search);
        if (url.pathname === "/api/codex-auth/active") return Response.json({ activeCodexAccountId: "pool" });
        if (url.pathname === "/api/codex-auth/accounts") return Response.json({ accounts: [
          { id: "__main__", subscription, quota: null },
          { id: "pool", subscription: { ...subscription, token: "synthetic-secret" }, accessToken: "synthetic-secret" },
          { id: "legacy" },
          { id: "empty", subscription: {} },
          { id: "partial", subscription: { activeUntil: subscription.activeUntil, activeStart: { token: "synthetic-secret" } } },
        ] });
        return Response.json({ error: "unexpected test request" }, { status: 404 });
      }) as typeof fetch,
    };
    const logs: string[] = [];
    const log = spyOn(console, "log").mockImplementation((...args: unknown[]) => { logs.push(args.join(" ")); });
    try {
      expect(await cmdAccount(["list", "openai", "--json", ...(quota ? ["--quota"] : [])], deps)).toBe(0);
    } finally {
      log.mockRestore();
    }
    const text = logs.join("\n");
    const rows = JSON.parse(text).accounts;
    expect(rows[0].subscription).toEqual(subscription);
    expect(rows[1].subscription).toEqual(subscription);
    expect(rows[2]).not.toHaveProperty("subscription");
    expect(rows[3]).not.toHaveProperty("subscription");
    expect(rows[4].subscription).toEqual({ activeStart: null, activeUntil: subscription.activeUntil, lastChecked: null });
    expect(text).not.toContain("synthetic-secret");
    expect(paths.sort()).toEqual(["/api/codex-auth/accounts", "/api/codex-auth/active"]);
  });
}
