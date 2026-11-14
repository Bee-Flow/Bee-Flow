/**
 * The arithmetic of modelCosts.rateUsage (./modelCosts.js), one decision per
 * step: how a cache write splits over its TTLs, which input tokens are
 * uncached, the card's list rates with the cache rates resolved, the
 * long-context tier, the service-tier, geo and regional factors, the cost,
 * and the cost basis. The card itself (catalogue, override, community,
 * estimate) is resolved in modelCosts.js; these steps only read it.
 *
 * Every step that can make a number less certain pushes a note, in the order
 * rateUsage has always produced them.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const rateRules = nodeRequire('./rateRules') as {
    getCacheDiscount(model: string | undefined): number;
    getCacheWriteMultiplier(model: string | undefined, ttl: '5m' | '1h'): number;
    getRegionalUplift(model: string | undefined): number;
    DEFAULT_TIER_MULTIPLIER: Readonly<Record<string, number>>;
};

/** The card kinds priced flat: no tier, geo or default multipliers apply to them. */
export const FLAT_CARDS = ['override', 'local', 'estimate'];

export type CostBasis = 'exact' | 'list' | 'estimated' | 'unknown' | 'local';

export type RateCard = {
    kind: string;
    basis: CostBasis;
    input: number;
    output: number;
    cacheRead: number | null;
    cacheWrite5m: number | null;
    cacheWrite1h: number | null;
    longCtx: { threshold: number; rates: Record<string, number> | null } | null;
    tierPriced: boolean;
    tierRates: Record<string, { input: number; output: number; cacheRead?: number }> | null;
    multipliers: (Record<string, number> & { geo?: Record<string, number> }) | null;
};

export type CacheFacts = {
    cache_ttl?: string | null;
    cache_creation_ttl_assumed?: boolean;
    prompt_includes_cache?: boolean;
};

export type Rates = { input: number; output: number; cacheRead: number; w5: number; w1: number };
export type CacheWrite = { creation: number; n5: number; n1: number };

/**
 * The cache write per TTL. A split wins. A write total that exceeds it keeps
 * its remainder at the legacy TTL; a split that exceeds the total raises the
 * total. Without a split the whole write is at the legacy TTL (5m unless 1h).
 */
export function cacheWriteSplit(creationIn: number, n5In: number, n1In: number, legacyTtl: string | null | undefined): CacheWrite {
    let creation = creationIn;
    let n5 = n5In;
    let n1 = n1In;
    if (n5 + n1 > 0) {
        if (creation > n5 + n1) { if (legacyTtl === '1h') n1 += creation - n5 - n1; else n5 += creation - n5 - n1; }
        creation = n5 + n1;
    } else if (creation > 0) {
        if (legacyTtl === '1h') n1 = creation; else n5 = creation;
    }
    return { creation, n5, n1 };
}

/**
 * The uncached input and the request's whole input. The two provider families
 * report input usage differently:
 *  - Anthropic: `usage.input_tokens` (our prompt_tokens) is ALREADY the
 *    uncached remainder; cache read and write are reported next to it and are
 *    NOT included. Subtracting them again zeroed the uncached input and billed
 *    it at nothing on every cache hit.
 *  - OpenAI / Gemini / Mistral / Scaleway: prompt_tokens is the FULL input and
 *    the cached count is a subset of it, so the cache pieces are subtracted
 *    (Math.max guards a provider that reports a cached count above the total:
 *    never a negative, cost-reducing input component).
 * The normalised usage says which it is (`prompt_includes_cache`); a caller
 * without the flag is told apart by model name.
 */
export function inputTokens(facts: CacheFacts, model: string | undefined, prompt: number, cached: number, creation: number): { uncachedInput: number; totalInput: number } {
    const includesCache = typeof facts.prompt_includes_cache === 'boolean'
        ? facts.prompt_includes_cache
        : !/claude/.test(String(model || '').toLowerCase());
    return {
        uncachedInput: includesCache ? Math.max(0, prompt - cached - creation) : Math.max(0, prompt),
        totalInput: includesCache ? prompt : prompt + cached + creation,
    };
}

/** The card's list rates (standard tier), with the cache rates it does not carry derived from the input rate. */
export function listRates(card: RateCard, model: string | undefined): Rates {
    const input = card.input;
    return {
        input,
        output: card.output,
        cacheRead: Number.isFinite(card.cacheRead) && (card.cacheRead as number) > 0 ? card.cacheRead as number : input * rateRules.getCacheDiscount(model),
        w5: Number.isFinite(card.cacheWrite5m) ? card.cacheWrite5m as number : input * rateRules.getCacheWriteMultiplier(model, '5m'),
        w1: Number.isFinite(card.cacheWrite1h) ? card.cacheWrite1h as number : input * rateRules.getCacheWriteMultiplier(model, '1h'),
    };
}

/**
 * The long-context tier: the whole request above the threshold pays the long
 * rates. A long rate the card does not give follows the input rate's ratio.
 */
export function longContextRates(card: RateCard, rates: Rates, totalInput: number): { rates: Rates; longContext: boolean } {
    if (!card.longCtx || !(totalInput > card.longCtx.threshold)) return { rates, longContext: false };
    const L = card.longCtx.rates || {};
    const lin = Number.isFinite(L.input) ? L.input : rates.input;
    const ratio = rates.input > 0 ? lin / rates.input : 1;
    return {
        rates: {
            input: lin,
            output: Number.isFinite(L.output) ? L.output : rates.output,
            cacheRead: Number.isFinite(L.cache_read) ? L.cache_read : rates.cacheRead * ratio,
            w5: Number.isFinite(L.cache_write_5m) ? L.cache_write_5m : rates.w5 * ratio,
            w1: Number.isFinite(L.cache_write_1h) ? L.cache_write_1h : rates.w1 * ratio,
        },
        longContext: true,
    };
}

/**
 * The service-tier factors on input and output. A catalogue card of the tier
 * itself is already priced; an admin override and a local/estimate card are
 * flat. Otherwise: the source's own tier rate, then the card's multiplier,
 * then the documented default.
 */
export function tierFactors(card: RateCard, tier: string, tierUnrecognised: boolean, notes: string[]): { tierIn: number; tierOut: number } {
    if (tierUnrecognised) notes.push('tier_unrecognised');
    if (tier === 'standard' || card.tierPriced || FLAT_CARDS.includes(card.kind)) return { tierIn: 1, tierOut: 1 };
    const abs = card.tierRates && card.tierRates[tier];
    const mult = card.multipliers && card.multipliers[tier];
    if (abs && card.input > 0) {
        const tierIn = abs.input / card.input;
        return { tierIn, tierOut: card.output > 0 ? abs.output / card.output : tierIn };
    }
    if (Number.isFinite(mult)) return { tierIn: mult as number, tierOut: mult as number };
    if (Object.prototype.hasOwnProperty.call(rateRules.DEFAULT_TIER_MULTIPLIER, tier)) {
        notes.push(`tier_${tier}_default_multiplier`);
        return { tierIn: rateRules.DEFAULT_TIER_MULTIPLIER[tier], tierOut: rateRules.DEFAULT_TIER_MULTIPLIER[tier] };
    }
    notes.push(`tier_${tier}_multiplier_unknown`);
    return { tierIn: 1, tierOut: 1 };
}

/** The factor of a pinned inference geo; 1 for a flat card or a geo the card does not price (noted). */
export function geoFactor(card: RateCard, geo: string | null, notes: string[]): number {
    if (!geo || FLAT_CARDS.includes(card.kind)) return 1;
    const g = card.multipliers && card.multipliers.geo && card.multipliers.geo[geo];
    if (Number.isFinite(g)) return g as number;
    notes.push(`geo_${geo}_multiplier_unknown`);
    return 1;
}

/**
 * The regional factor. The registry says whether the call went to a regional
 * endpoint; a catalogue card may carry the factor, the built-in 1.1 remains
 * the fallback.
 */
export function regionalFactor(card: RateCard, model: string | undefined): number {
    const legacyUplift = rateRules.getRegionalUplift(model);
    return legacyUplift !== 1 && card.multipliers && Number.isFinite(card.multipliers.regional)
        ? card.multipliers.regional
        : legacyUplift;
}

/**
 * The rates after the tier factors. A source that gives the tier's own
 * cached-read rate (flex/priority) is exact, outside the long-context tier.
 */
export function tieredRates(rates: Rates, factors: { tierIn: number; tierOut: number }, card: RateCard, tier: string, longContext: boolean): Rates {
    const r = {
        input: rates.input * factors.tierIn,
        output: rates.output * factors.tierOut,
        cacheRead: rates.cacheRead * factors.tierIn,
        w5: rates.w5 * factors.tierIn,
        w1: rates.w1 * factors.tierIn,
    };
    const own = tier !== 'standard' && !longContext && card.tierRates && card.tierRates[tier];
    if (own && Number.isFinite(own.cacheRead)) r.cacheRead = own.cacheRead as number;
    return r;
}

/**
 * The cost and its input/output split. The sums run in the order of the
 * formula from before the catalogue, so unchanged inputs give unchanged
 * numbers to the last bit.
 */
export function costOf(tokens: { uncachedInput: number; cached: number; n5: number; n1: number; completion: number }, r: Rates, total: number): { cost: number; inputCost: number; outputCost: number } {
    const { uncachedInput, cached, n5, n1, completion } = tokens;
    const inputCost = (((uncachedInput / 1_000_000) * r.input)
        + ((cached / 1_000_000) * r.cacheRead)
        + ((n5 / 1_000_000) * r.w5)
        + ((n1 / 1_000_000) * r.w1)) * total;
    const outputCost = ((completion / 1_000_000) * r.output) * total;
    const cost = (((uncachedInput / 1_000_000) * r.input)
        + ((cached / 1_000_000) * r.cacheRead)
        + ((n5 / 1_000_000) * r.w5)
        + ((n1 / 1_000_000) * r.w1)
        + ((completion / 1_000_000) * r.output)) * total;
    return { cost, inputCost, outputCost };
}

/**
 * The cost basis. An assumed cache TTL matters only when the two write rates
 * differ; it, an unrecognised tier, or a default or unknown multiplier makes
 * an exact or list price an estimate.
 */
export function costBasis(cardBasis: CostBasis, notes: string[], creation: number, facts: CacheFacts, r: Rates): CostBasis {
    if (creation > 0 && facts.cache_creation_ttl_assumed && r.w5 !== r.w1) notes.push('cache_ttl_assumed');
    const lessCertain = notes.some((n) => n === 'tier_unrecognised' || n.endsWith('_default_multiplier') || n.endsWith('_multiplier_unknown') || n === 'cache_ttl_assumed');
    return (cardBasis === 'exact' || cardBasis === 'list') && lessCertain ? 'estimated' : cardBasis;
}
