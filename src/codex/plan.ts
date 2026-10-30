import { decodeJwtPayload } from "../oauth/chatgpt";

/** Safe, display-only subscription dates from the latest stored ChatGPT JWT. */
export interface ChatgptSubscription {
  activeStart: string | null;
  activeUntil: string | null;
  lastChecked: string | null;
}

/** Whitelist the public date fields, including when reading an older/remote server's DTO. */
export function projectChatgptSubscription(value: unknown): ChatgptSubscription | undefined {
  if (!value || typeof value !== "object") return undefined;
  const dates = value as Record<string, unknown>;
  const keys = ["activeStart", "activeUntil", "lastChecked"] as const;
  if (!keys.some(key => Object.hasOwn(dates, key))) return undefined;
  const date = (key: typeof keys[number]): string | null => typeof dates[key] === "string" ? dates[key] : null;
  return { activeStart: date("activeStart"), activeUntil: date("activeUntil"), lastChecked: date("lastChecked") };
}

/** Same token precedence and decoder as plan extraction; never refresh or expose other claims. */
export function extractChatgptSubscription(idToken?: string, accessToken?: string): ChatgptSubscription | undefined {
  for (const token of [idToken, accessToken]) {
    if (!token) continue;
    const ns = decodeJwtPayload(token)?.["https://api.openai.com/auth"];
    if (!ns || typeof ns !== "object") continue;
    const claims = ns as Record<string, unknown>;
    const keys = ["chatgpt_subscription_active_start", "chatgpt_subscription_active_until", "chatgpt_subscription_last_checked"] as const;
    if (!keys.some(key => Object.hasOwn(claims, key))) continue;
    return projectChatgptSubscription({
      activeStart: claims.chatgpt_subscription_active_start,
      activeUntil: claims.chatgpt_subscription_active_until,
      lastChecked: claims.chatgpt_subscription_last_checked,
    });
  }
  return undefined;
}

/** Preserve user/provider plan labels only when they are usable strings. */
export function codexPlanValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.trim() ? value : undefined;
}

/** Case-insensitive key used by quota, capacity, and collision policy. */
export function codexPlanKey(value: unknown): string | undefined {
  return codexPlanValue(value)?.trim().toLowerCase();
}

export function isThirtyDayOnlyCodexPlan(value: unknown): boolean {
  const key = codexPlanKey(value);
  return key === "go" || key === "free";
}

/**
 * ChatGPT plan label from a live access/id token (`chatgpt_plan_type`).
 * Used when WHAM has not run yet so a stale stored `free` cannot outrank the token (#1989).
 */
export function extractChatgptPlanType(idToken?: string, accessToken?: string): string | undefined {
  for (const token of [idToken, accessToken]) {
    if (!token) continue;
    const payload = decodeJwtPayload(token);
    if (!payload) continue;
    if (typeof payload.chatgpt_plan_type === "string") {
      const plan = codexPlanValue(payload.chatgpt_plan_type);
      if (plan) return plan;
    }
    const ns = payload["https://api.openai.com/auth"];
    if (ns && typeof ns === "object") {
      const nested = (ns as Record<string, unknown>).chatgpt_plan_type;
      const plan = codexPlanValue(nested);
      if (plan) return plan;
    }
  }
  return undefined;
}
