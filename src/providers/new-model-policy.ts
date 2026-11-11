import type { OcxConfig } from "../types";
import { routedSlug, slugEquals } from "./slug-codec";
import { INITIAL_MODEL_SELECTION_THRESHOLD } from "./initial-model-selection";
import {
  antigravityEffortFamilyIds, antigravityFamilyDisabled,
  type AntigravityEffortFamilyRow,
} from "./antigravity-effort-families";

export const MODEL_REMOVAL_GRACE_FETCHES = 3;
export const MAX_KNOWN_MODELS_PER_PROVIDER = 2_000;
export const MAX_RECENT_ARRIVALS_PER_PROVIDER = 50;

export type KnownModelBaseline = NonNullable<NonNullable<OcxConfig["modelDiscovery"]>["knownModels"]>[string];
export type NewModelPolicy = "on" | "off";

/**
 * Which side of the reconciliation is running.
 *
 * `converge` (the default) is the catalog convergence cycle: it advances the removal grace and
 * retires ids missing for {@link MODEL_REMOVAL_GRACE_FETCHES} cycles. `discovery` is the HTTP read
 * side (GET /v1/models), which is polled far more often than convergence runs; it absorbs genuine
 * arrivals and reappearances but never advances removal accounting, so a transiently absent id
 * cannot be retired by repeated polls.
 */
export type NewModelPolicyMode = "converge" | "discovery";

export interface NewModelPolicyResult {
  newIds: string[];
  nextBaseline: KnownModelBaseline;
  slugsToDisable: string[];
  arrivals: Array<{ id: string; at: string }>;
  overflow: boolean;
}

/**
 * Whether a transition actually changes persisted state.
 *
 * `updatedAt` moves on every successful fetch, so comparing whole baselines would report a
 * change every time and rewrite config.json on every catalog convergence — a write amplification
 * that also churns the config generation other writers revalidate against. Only the fields that
 * carry meaning are compared.
 */
function baselineDiffers(prior: KnownModelBaseline | undefined, next: KnownModelBaseline): boolean {
  if (!prior) return true;
  if (prior.visibilityInitialized !== next.visibilityInitialized) return true;
  const sameList = (a: readonly string[], b: readonly string[]) =>
    a.length === b.length && a.every((value, index) => value === b[index]);
  if (!sameList(prior.ids, next.ids) || !sameList(prior.removed, next.removed)) return true;
  const priorMissing = prior.missing ?? {};
  const nextMissing = next.missing ?? {};
  const keys = new Set([...Object.keys(priorMissing), ...Object.keys(nextMissing)]);
  for (const key of keys) if (priorMissing[key] !== nextMissing[key]) return true;
  return false;
}

/** Pure successful-discovery transition; callers may supply the initial visible choices. */
export function applyNewModelPolicy(options: {
  provider: string;
  discoveredIds: Iterable<string>;
  baseline?: KnownModelBaseline;
  policy: NewModelPolicy;
  hasSelectedModels?: boolean;
  /** Configured default on first discovery; omitted when preserving existing switch choices. */
  initiallyVisibleIds?: Iterable<string>;
  now: string;
  /** See {@link NewModelPolicyMode}; defaults to `converge`. */
  mode?: NewModelPolicyMode;
}): NewModelPolicyResult {
  const discovered = [...new Set(options.discoveredIds)].sort();
  const prior = options.baseline;
  const visible = options.initiallyVisibleIds === undefined ? null : new Set(options.initiallyVisibleIds);
  if (!prior) {
    const overflow = discovered.length > MAX_KNOWN_MODELS_PER_PROVIDER;
    return {
      newIds: [],
      nextBaseline: { ids: discovered, removed: [], updatedAt: options.now,
        ...(visible !== null ? { visibilityInitialized: true } : {}) },
      slugsToDisable: !overflow && options.policy === "off" && !options.hasSelectedModels && visible !== null
        ? discovered.filter(id => !visible.has(id)).map(id => routedSlug(options.provider, id)) : [],
      arrivals: [],
      overflow,
    };
  }
  const active = new Set(prior.ids);
  const removed = new Set(prior.removed);
  const seen = new Set(discovered);
  const newIds = discovered.filter(id => !active.has(id) && !removed.has(id));
  const missing: Record<string, number> = {};
  // Read-side discovery must not advance the removal grace: a per-poll increment would retire a
  // transiently absent id after three polls. Absence keeps its recorded count (and a reappearance
  // clears it) instead of moving toward `removed`.
  const discovery = options.mode === "discovery";
  for (const id of active) {
    if (seen.has(id)) continue;
    if (discovery) {
      const priorCount = prior.missing?.[id];
      if (priorCount !== undefined) missing[id] = priorCount;
      continue;
    }
    const count = (prior.missing?.[id] ?? 0) + 1;
    if (count >= MODEL_REMOVAL_GRACE_FETCHES) {
      active.delete(id);
      removed.add(id);
    } else missing[id] = count;
  }
  for (const id of discovered) active.add(id);
  const unionSize = active.size + removed.size;
  const overflow = unionSize > MAX_KNOWN_MODELS_PER_PROVIDER;
  const arrivals = newIds.map(id => ({ id, at: options.now }));
  return {
    newIds,
    nextBaseline: {
      ids: [...active].sort(), removed: [...removed].sort(), updatedAt: options.now,
      ...(prior.visibilityInitialized || options.initiallyVisibleIds !== undefined ? { visibilityInitialized: true } : {}),
      ...(Object.keys(missing).length ? { missing } : {}),
    },
    // A non-empty preset/custom allowlist already excludes arrivals. This explicit no-op is
    // deliberate: preset mode owns which matching flagships arrive on.
    slugsToDisable: !overflow && options.policy === "off" && !options.hasSelectedModels
      ? (visible === null ? newIds : discovered.filter(id => !visible.has(id)))
        .map(id => routedSlug(options.provider, id)) : [],
    arrivals,
    overflow,
  };
}

export function effectiveNewModelPolicy(config: OcxConfig, provider: string): NewModelPolicy {
  const local = config.providers[provider]?.newModelPolicy;
  if (local === "on" || local === "off") return local;
  return config.modelDiscovery?.newModelPolicy ?? "off";
}

/** Normalize policy identities only; the original rows and saved wire selections stay intact. */
function normalizeEffortFamilies(config: OcxConfig, provider: string, rows: AntigravityEffortFamilyRow[]) {
  const aliases = new Map<string, string>();
  const inheritedDisables: string[] = [];
  const bases = new Set(rows.filter(row => antigravityEffortFamilyIds(row)).map(row => row.id));
  for (const row of rows) {
    const ids = antigravityEffortFamilyIds(row);
    if (!ids) continue;
    for (const id of ids) if (!bases.has(id)) aliases.set(id, row.id);
    if (antigravityFamilyDisabled(config, row, rows)
      && !config.disabledModels?.some(slug => slugEquals(slug, provider, row.id))) {
      inheritedDisables.push(routedSlug(provider, row.id));
    }
  }
  const normalize = (id: string) => aliases.get(id) ?? id;
  const normalizeIds = (ids: string[]) => [...new Set(ids.map(normalize))].sort();
  const prior = config.modelDiscovery?.knownModels?.[provider];
  let baseline = prior;
  if (prior && aliases.size) {
    const missing: Record<string, number> = {};
    for (const [id, count] of Object.entries(prior.missing ?? {})) {
      const key = normalize(id);
      // A family cannot disappear sooner than its least-missing known tier.
      missing[key] = Math.min(missing[key] ?? count, count);
    }
    baseline = { ...prior, ids: normalizeIds(prior.ids), removed: normalizeIds(prior.removed),
      ...(Object.keys(missing).length ? { missing } : {}) };
  }
  const defaultModel = config.providers[provider]?.defaultModel;
  return { discoveredIds: normalizeIds(rows.map(row => row.id)), baseline, inheritedDisables,
    defaultModel: defaultModel ? normalize(defaultModel) : undefined };
}

/** Apply authoritative provider rows to a mutable convergence copy; degraded providers are omitted. */
export function reconcileSuccessfulModelDiscoveries(options: {
  config: OcxConfig;
  models: Iterable<AntigravityEffortFamilyRow>;
  authoritativeProviders: Iterable<string>;
  now: string;
  /** See {@link NewModelPolicyMode}; defaults to `converge`. */
  mode?: NewModelPolicyMode;
}): boolean {
  const byProvider = new Map<string, AntigravityEffortFamilyRow[]>();
  for (const model of options.models) {
    if (model.custom || model.catalogKind === "custom-model-v1") continue;
    const rows = byProvider.get(model.provider) ?? [];
    rows.push(model); byProvider.set(model.provider, rows);
  }
  let changed = false;
  for (const provider of options.authoritativeProviders) {
    const configured = options.config.providers[provider];
    if (!configured || configured.liveModels === false) continue;
    const { discoveredIds, baseline, inheritedDisables, defaultModel } = normalizeEffortFamilies(
      options.config, provider, byProvider.get(provider) ?? [],
    );
    const discovery = options.config.modelDiscovery ??= {};
    const known = discovery.knownModels ??= {};
    const result = applyNewModelPolicy({
      provider, discoveredIds, baseline,
      policy: effectiveNewModelPolicy(options.config, provider),
      hasSelectedModels: (configured.selectedModels?.length ?? 0) > 0,
      // A previous per-model switch edit is an explicit choice too. Never reinitialize it.
      initiallyVisibleIds: baseline?.visibilityInitialized
        || (baseline && discoveredIds.length < INITIAL_MODEL_SELECTION_THRESHOLD)
        || (baseline && !defaultModel)
        || (configured.modelPreset?.mode === "all" && !configured.modelPreset.fallback)
        || options.config.disabledModels?.some(selector => discoveredIds.some(id => slugEquals(selector, provider, id)))
        ? undefined : defaultModel ? [defaultModel] : [],
      now: options.now,
      mode: options.mode,
    });
    if (result.overflow) continue;
    // Preserving an existing roster is a completed visibility decision too. A later default
    // edit or growth past the bootstrap threshold must not reinitialize those choices.
    result.nextBaseline.visibilityInitialized = true;
    const priorBaseline = known[provider];
    const baselineChanged = baselineDiffers(priorBaseline, result.nextBaseline);
    known[provider] = result.nextBaseline;
    // Keep the previous timestamp when nothing else moved, so a steady-state roster does not
    // make the baseline look dirty on the next comparison either.
    if (!baselineChanged && priorBaseline) known[provider] = priorBaseline;
    const slugsToDisable = [...result.slugsToDisable, ...inheritedDisables];
    if (slugsToDisable.length) {
      const disabled = options.config.disabledModels ??= [];
      for (const slug of slugsToDisable) {
        if (disabled.includes(slug)) continue;
        disabled.push(slug);
        changed = true;
      }
    }
    if (result.arrivals.length) {
      const recent = discovery.recentArrivals ??= {};
      recent[provider] = [...(recent[provider] ?? []), ...result.arrivals]
        .slice(-MAX_RECENT_ARRIVALS_PER_PROVIDER);
      changed = true;
    }
    if (baselineChanged) changed = true;
  }
  return changed;
}
