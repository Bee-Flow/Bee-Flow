/**
 * contextWindowExamples.mts: what the context-budget percentage means in real
 * tokens, for ONE organisation's own models.
 *
 * The conversation-memory settings screen (routes/orgAiContext.js) shows a
 * line under the safety-limit slider: "<model>: about <n> tokens". It used to
 * name two fixed models of one provider, so an organisation on any other
 * provider, or on a self-hosted model, read numbers for models it never uses.
 *
 * Now the examples come from the organisation's chat tiers (EU overrides and
 * its own custom tiers included, modelResolver.getUserTierMap): each tier's
 * model is sized with contextPolicy.contextWindowFor, tiers that share a
 * window collapse to the first one on the cheapest-first ladder, and the
 * largest and the smallest window are kept. Nothing configured (or the tier
 * config could not be read) gives two neutral examples instead of a vendor's.
 *
 * Lives in its own module rather than in contextPolicy.js: contextPolicy is on
 * the chat hot path and below modelResolver's lazy dependencies, so giving it a
 * dependency on modelResolver would close an import cycle.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

type TierEntry = { modelId?: unknown; label?: unknown; custom?: unknown } | null | undefined;

const { contextWindowFor } = nodeRequire('./contextPolicy') as {
    contextWindowFor(modelId: string | null | undefined): number;
};
const { getUserTierMap, TIER_MATCH_PRIORITY, canonicalTierName } = nodeRequire('./modelResolver') as {
    getUserTierMap(opts: { userOrgId?: string | null }): Promise<Record<string, TierEntry>>;
    TIER_MATCH_PRIORITY: string[];
    canonicalTierName(value: string): string | null;
};
const { DISPLAY_NAME_TO_ID } = nodeRequire('./modelNames') as { DISPLAY_NAME_TO_ID: Record<string, string> };
const TIER_NAMES = nodeRequire('../../i18n/defaults/en/tier.js') as Record<string, string>;
const log = nodeRequire('../../telemetry/log') as { warn(msg: string): void };

/**
 * One example line. `label` is the finished English text, which older clients
 * render as is; `kind`, `tierKey` and `model` let a client translate it:
 *   - `tier`: a built-in tier, named by the i18n key `tier.<tierKey>`, with
 *     the model's display name;
 *   - `custom`: an organisation's or the server's custom tier, whose label is
 *     the admin's own words and is not translated;
 *   - `generic`: nothing configured, "A <contextWindow>-token model".
 */
export type ContextWindowExample = {
    label: string;
    contextWindow: number;
    kind: 'tier' | 'custom' | 'generic';
    tierKey: string | null;
    model: string | null;
};

/** The neutral pair: the two window sizes most chat models have today. */
const GENERIC_WINDOWS = [1_000_000, 200_000];

function genericExample(contextWindow: number): ContextWindowExample {
    return {
        label: `A ${contextWindow.toLocaleString('en-US')}-token model`,
        contextWindow,
        kind: 'generic',
        tierKey: null,
        model: null,
    };
}

/** model id → display name, the first name the picker map gives it (the newest). */
let _namesById: Map<string, string> | null = null;
function modelDisplayName(modelId: string): string {
    if (!_namesById) {
        _namesById = new Map();
        for (const [name, id] of Object.entries(DISPLAY_NAME_TO_ID)) {
            if (!_namesById.has(id)) _namesById.set(id, name);
        }
    }
    return _namesById.get(modelId) || modelId;
}

/** Tier keys in the order a window is claimed: the cheapest-first ladder, then the rest (custom tiers). */
function orderedTierKeys(tiers: Record<string, TierEntry>): string[] {
    const ladder = TIER_MATCH_PRIORITY.filter((k) => Object.prototype.hasOwnProperty.call(tiers, k));
    const rest = Object.keys(tiers).filter((k) => !ladder.includes(k));
    return [...ladder, ...rest];
}

function exampleFor(key: string, tier: NonNullable<TierEntry>, modelId: string): ContextWindowExample {
    const contextWindow = contextWindowFor(modelId);
    const model = modelDisplayName(modelId);
    const isCustom = tier.custom === true || key.startsWith('custom:');
    if (isCustom) {
        const name = typeof tier.label === 'string' && tier.label.trim() ? tier.label.trim() : key.slice('custom:'.length) || key;
        return { label: `${name} (${model})`, contextWindow, kind: 'custom', tierKey: null, model };
    }
    // `pro` shares deep_thinking's name and `smart` is thinking's (tier.js).
    const canonical = key === 'pro' ? 'deep_thinking' : (canonicalTierName(key) || key);
    const tierName = TIER_NAMES[`tier.${canonical}`];
    if (!tierName) {
        return { label: `${key} (${model})`, contextWindow, kind: 'custom', tierKey: null, model };
    }
    return { label: `${tierName} (${model})`, contextWindow, kind: 'tier', tierKey: canonical, model };
}

/**
 * The examples for the settings screen of one organisation: its largest and
 * its smallest context window (one entry when every tier has the same window),
 * or the neutral pair when it has no chat model configured.
 */
export async function contextWindowExamples(orgId: string | null | undefined): Promise<ContextWindowExample[]> {
    let tiers: Record<string, TierEntry>;
    try {
        tiers = await getUserTierMap({ userOrgId: orgId || null });
    } catch (err) {
        log.warn(`[ContextWindowExamples] tier config unreadable for org ${orgId}: ${(err as Error).message}`);
        tiers = {};
    }

    const byWindow = new Map<number, ContextWindowExample>();
    for (const key of orderedTierKeys(tiers || {})) {
        const tier = tiers[key];
        const modelId = tier && typeof tier.modelId === 'string' ? tier.modelId.trim() : '';
        if (!tier || !modelId) continue;
        const example = exampleFor(key, tier, modelId);
        if (!byWindow.has(example.contextWindow)) byWindow.set(example.contextWindow, example);
    }

    if (byWindow.size === 0) return GENERIC_WINDOWS.map(genericExample);
    const sorted = [...byWindow.values()].sort((a, b) => b.contextWindow - a.contextWindow);
    const largest = sorted[0];
    const smallest = sorted[sorted.length - 1];
    return largest === smallest ? [largest] : [largest, smallest];
}
