/**
 * Model tiers.
 *
 * The first version of this file hardcoded `auto | fast | balanced | smart`,
 * which was wrong in every particular. The real vocabulary is
 * `auto | fast | standard | swarm | thinking | writer | pro | deep_thinking`
 * plus `custom:<id>` for org-defined tiers, and the labels do not follow the
 * keys: `standard` is shown as "Flow", `writer` as "Write", and both `pro` and
 * `deep_thinking` as "Deep Thinking".
 *
 * More to the point, the list is NOT static. Availability is gated three ways —
 * the user's group `allowedTiers`, beta feature flags (Flow needs both `flow`
 * and `skills`; Swarm needs `swarm`), and EU mode, which substitutes a
 * different model id — and it varies by `taskType`, so the same person sees a
 * different set in direct chat than in an automation step. So the tiers are
 * fetched, never assumed, and a stored selection that is no longer available
 * reconciles back to `auto` rather than sending a tier the server will refuse.
 */

import { api } from '../../api/client';

/** Tier keys the server may return. `custom:<id>` is open-ended. */
export type TierKey = string;

export interface TierInfo {
    /** Present and true only on `auto`. */
    auto?: boolean;
    modelId?: string;
    /** Org-defined tiers carry their own presentation. */
    label?: string;
    icon?: string;
    description?: string;
}

export type TierMap = Record<TierKey, TierInfo>;

export const tierKeys = {
    forTask: (taskType: string) => ['chat', 'tiers', taskType] as const,
};

export async function fetchTiers(
    taskType = 'direct_chat',
    signal?: AbortSignal,
): Promise<TierMap> {
    return (await api.get<TierMap>('/ai/config/tiers-for-user', { query: { taskType }, signal })) ?? {};
}

/**
 * Display names for the built-in tiers.
 *
 * Deliberately a lookup rather than a prettify-the-key function: `standard` →
 * "Flow" and `pro` → "Deep Thinking" are not derivable, and a user who sees
 * "Standard" on the phone and "Flow" on the web will reasonably think they are
 * different things.
 */
const BUILT_IN_LABELS: Record<string, string> = {
    auto: 'Auto',
    fast: 'Fast',
    standard: 'Flow',
    swarm: 'Swarm',
    thinking: 'Think',
    writer: 'Write',
    pro: 'Deep Thinking',
    deep_thinking: 'Deep Thinking',
};

/**
 * The one-line subtitles the web's TierSlider panel shows under the tier name
 * (agent-hub tierMeta.js `desc`). Copied, not paraphrased: the panel is meant
 * to read identically on both clients.
 */
const BUILT_IN_DESCRIPTIONS: Record<string, string> = {
    auto: 'Optimal choice',
    fast: 'Quick answers',
    standard: 'Multi-stage orchestration',
    swarm: 'Parallel agents, synthesised answer',
    thinking: 'Complex problems',
    writer: 'Long-form content',
    pro: 'Advanced reasoning',
    deep_thinking: 'Advanced reasoning',
};

export function tierLabel(key: TierKey, info?: TierInfo): string {
    if (info?.label) return info.label;
    return BUILT_IN_LABELS[key] ?? key.replace(/^custom:/, '');
}

export function tierDescription(key: TierKey, info?: TierInfo): string {
    if (info?.description) return info.description;
    return BUILT_IN_DESCRIPTIONS[key] ?? (key.startsWith('custom:') ? 'Custom tier' : '');
}

/**
 * The tiers that sit on a single "how hard should it think" axis, shallowest
 * first — the stops of the web's slider (tierMeta.js DEPTH_TIER_KEYS). Flow,
 * Swarm, Write and custom tiers are KINDS of work, not depths: putting Write
 * between Think and Deep Thinking on a slider would assert a ranking that
 * does not exist. They render as pills under the track instead.
 */
export const DEPTH_TIER_KEYS = ['auto', 'fast', 'thinking', 'pro', 'deep_thinking'];

/**
 * Split the server's tier map into slider stops and off-scale pills, in the
 * web's canonical order. Mirrors configuredTierKeys + the stops/others split
 * in agent-hub's TierSlider so the two clients list the same options in the
 * same places.
 */
export function splitTiers(map: TierMap): { stops: TierKey[]; others: TierKey[] } {
    const keys = orderTiers(map);
    return {
        stops: keys.filter((k) => DEPTH_TIER_KEYS.includes(k)),
        others: keys.filter((k) => !DEPTH_TIER_KEYS.includes(k)),
    };
}

/**
 * Order the tiers the way the web app's TierSlider does — by depth, cheapest
 * first — with anything unrecognised (custom tiers) after the built-ins in
 * whatever order the server sent them.
 */
const DEPTH_ORDER = ['auto', 'fast', 'standard', 'thinking', 'writer', 'pro', 'deep_thinking', 'swarm'];

export function orderTiers(map: TierMap): TierKey[] {
    const keys = Object.keys(map);
    const known = DEPTH_ORDER.filter((k) => keys.includes(k));
    const rest = keys.filter((k) => !DEPTH_ORDER.includes(k)).sort();
    return [...known, ...rest];
}

/**
 * Reconcile a remembered selection against what is available now.
 *
 * A tier can disappear between sessions — a beta flag switched off, a group
 * changed, a custom tier deleted — and sending a tier the server will not
 * accept fails the turn with an error the user cannot act on. Falling back to
 * `auto` always works, because `auto` is the one tier the server guarantees.
 */
export function reconcileTier(stored: TierKey | null, map: TierMap): TierKey {
    if (stored && Object.prototype.hasOwnProperty.call(map, stored)) return stored;
    if (Object.prototype.hasOwnProperty.call(map, 'auto')) return 'auto';
    return orderTiers(map)[0] ?? 'auto';
}

/**
 * Does this tier run the swarm runtime?
 *
 * Worth a named predicate: a swarm turn short-circuits into an entirely
 * different server runtime with its own event vocabulary, and a client that
 * only listens for `content` renders an empty bubble for the whole answer.
 */
export function isSwarmTier(key: TierKey): boolean {
    return key === 'swarm';
}
