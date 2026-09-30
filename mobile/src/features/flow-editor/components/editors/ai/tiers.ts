/**
 * The model tiers an AI step may run on — the web's `configuredTierKeys` and
 * `tierLabel` (agent-hub components/licensing/tierMeta.js), so this picker
 * lists exactly what the chat's tier picker lists: the built-in tiers in
 * their canonical order (each only once a model is configured for it; `auto`
 * always), then the org's custom tiers. A step saved on a tier no longer
 * offered keeps it, shown as itself: opening a step must not change its model.
 * Pinned by ai.lockstep.test.ts.
 */

import type { TranslateFn } from '@/core/i18n';

export const STANDARD_TIER_ORDER: readonly string[] = ['auto', 'fast', 'standard', 'swarm', 'thinking', 'writer', 'pro'];

/** Built-in tier names under the web's `tier.<key>` keys; `pro` is an alias of deep_thinking. */
const BUILT_IN: Readonly<Record<string, readonly [string, string]>> = {
    auto: ['tier.auto', 'Auto'],
    fast: ['tier.fast', 'Fast'],
    standard: ['tier.standard', 'Flow'],
    swarm: ['tier.swarm', 'Swarm'],
    thinking: ['tier.thinking', 'Think'],
    writer: ['tier.writer', 'Write'],
    deep_thinking: ['tier.deep_thinking', 'Deep Thinking'],
    pro: ['tier.deep_thinking', 'Deep Thinking'],
};

export type TierConfig = Record<string, { modelId?: string; label?: string } | undefined>;

export function configuredTierKeys(tiers: TierConfig): string[] {
    const customKeys = Object.keys(tiers).filter((k) => k.startsWith('custom:'));
    return [...STANDARD_TIER_ORDER, ...customKeys].filter((key) => {
        const cfg = tiers[key] || {};
        const hasMeta = !!BUILT_IN[key] || key.startsWith('custom:');
        if (!hasMeta) return false;
        return key === 'auto' || key.startsWith('custom:') || !!cfg.modelId;
    });
}

export function tierName(key: string, tiers: TierConfig, t: TranslateFn): string {
    const own = tiers[key]?.label;
    if (own) return own;
    const built = BUILT_IN[key];
    if (built) return t(built[0], built[1]);
    if (key.startsWith('custom:')) return key.replace(/^custom:/, '');
    return key.charAt(0).toUpperCase() + key.slice(1);
}

/** The picker's rows: the offered tiers, and a stored one that no longer is, kept selectable. */
export function tierOptions(tiers: TierConfig, current: string, t: TranslateFn): { value: string; label: string }[] {
    const keys = configuredTierKeys(tiers);
    const list = keys.includes(current) ? keys : [current, ...keys];
    return list.map((id) => ({ value: id, label: tierName(id, tiers, t) }));
}
