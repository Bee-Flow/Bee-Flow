// @typecheck
/**
 * A rate for a model that no price source knows.
 *
 * This replaces the "most expensive input and output rate of every model there
 * is" fallback, which measured $3,200 / $9,710 per 1M tokens on current community
 * data (one obscure open-weight model), about 20x any real model, and went
 * straight onto PAYG invoices and cost caps. The estimate is deliberately less
 * generous and always flagged by the caller (cost_basis 'unknown'):
 *
 *   1. family   the nearest same-family model of the same provider. "Family" means
 *               the same leading name word and a donor whose variant words
 *               (mini, sol, opus, flash, ...) are all present in the unknown id,
 *               so `gpt-5.7-sol` borrows from `gpt-5.6-sol`, never from
 *               `gpt-5.6-sol-mini`; the closest version wins, the dearer one on a tie.
 *               One shared leading word is not enough when the id has variant
 *               words of its own: `claude-nova-1` does not borrow from `claude-opus-4`.
 *   2. provider the upper quartile of that provider's chat models (not the maximum:
 *               the maximum is one legacy flagship). Needs a pool of at least
 *               MIN_PROVIDER_POOL models.
 *   3. nothing  no family and no provider pool: no number is invented; the caller
 *               rates the call at 0 and flags it.
 *
 * A model of another provider is never a donor when the provider is known
 * (open weights are sold by a dozen hosts at their own prices, see the Scaleway
 * notes in modelCosts). Only when nothing says which provider the model belongs
 * to is the family looked up across hosts.
 *
 * Sanity: a donor above MAX_INPUT_PER_M / MAX_OUTPUT_PER_M, or with a non-finite
 * or non-positive input rate, is not used at all (a garbled or poisoned price
 * entry must not set a rate), and a non-chat id (embeddings, speech, image, video)
 * never gets the provider-level chat estimate: its unit is not the token.
 *
 * Pure: the candidate list is passed in (modelCosts builds it from the
 * catalogue, the repo snapshots, the community data and the admin overrides).
 */

/** Per 1M tokens. Above every current mainstream chat model; a donor beyond it is treated as bad data. */
const MAX_INPUT_PER_M = 100;
const MAX_OUTPUT_PER_M = 400;
const PROVIDER_PERCENTILE = 0.75;
const MIN_PROVIDER_POOL = 5;
const MAX_ID_LENGTH = 200;

const NOISE = new Set(['latest', 'preview', 'exp', 'experimental', 'beta', 'stable', 'ga', 'instruct', 'it', 'hf', 'fp8', 'fp16', 'bf16', 'int4', 'int8', 'awq', 'gptq']);
const NON_CHAT = /(embed|whisper|tts|speech|transcri|audio|image|imagen|dall-?e|veo|sora|video|rerank|moderat|\bocr\b|music|lyria|realtime|\bstt\b)/i;

/** Which providers a donor may come from for a given provider (a reseller prices like its vendor). */
const VENDOR_SETS = Object.freeze({
    azure: ['azure', 'openai'],
    'google-vertex': ['google-vertex', 'google'],
});
function vendorSet(vendor) {
    return new Set(VENDOR_SETS[vendor] || [vendor]);
}

/**
 * Name -> { words, version } with provider prefixes, tags, dates and noise
 * removed. `gpt-5.6-sol` -> words [gpt, sol], version [5, 6];
 * `claude-3-5-sonnet-20241022` -> words [claude, sonnet], version [3, 5].
 */
function parseModelId(id) {
    let s = String(id || '').toLowerCase();
    s = s.slice(s.lastIndexOf('/') + 1);
    s = s.replace(/[@:].*$/, '');
    s = s.replace(/[-_.]?20\d{2}[-_]?\d{2}[-_]?\d{2}(?=$|[-_])/g, '');
    s = s.replace(/-\d{4}$/, '');
    const words = [];
    const version = [];
    for (const tok of s.split(/[-_\s]+/)) {
        if (!tok || NOISE.has(tok)) continue;
        if (/^\d+(\.\d+)*$/.test(tok)) version.push(...tok.split('.').map(Number));
        else words.push(tok);
    }
    return { words, version };
}

function versionDistance(a, b) {
    const d = (i) => Math.abs((a[i] || 0) - (b[i] || 0));
    return d(0) * 1000 + d(1) * 10 + d(2);
}

const isNonChat = (id) => NON_CHAT.test(String(id));

/**
 * Validate and pre-parse the donors once (modelCosts caches the result).
 * @param {Array<{ id: string, vendor: string|null, input: number, output: number, cacheRead?: number|null, currency?: string, source?: string }>} list
 */
function prepareCandidates(list) {
    const out = [];
    for (const c of Array.isArray(list) ? list : []) {
        if (!c || typeof c.id !== 'string' || c.id.length === 0 || c.id.length > MAX_ID_LENGTH) continue;
        if (!(Number.isFinite(c.input) && c.input > 0 && c.input <= MAX_INPUT_PER_M)) continue;
        if (!(Number.isFinite(c.output) && c.output >= 0 && c.output <= MAX_OUTPUT_PER_M)) continue;
        const parsed = parseModelId(c.id);
        if (parsed.words.length === 0) continue;
        out.push({
            id: c.id,
            vendor: typeof c.vendor === 'string' ? c.vendor : null,
            input: c.input,
            output: c.output,
            cacheRead: Number.isFinite(c.cacheRead) && c.cacheRead > 0 ? c.cacheRead : null,
            currency: typeof c.currency === 'string' && /^[A-Z]{3}$/.test(c.currency) ? c.currency : 'USD',
            source: typeof c.source === 'string' ? c.source : null,
            words: parsed.words,
            version: parsed.version,
            nonChat: isNonChat(c.id),
        });
    }
    return out;
}

function percentile(sorted, p) {
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

function pickFamily(unknown, pool) {
    const wanted = new Set(unknown.words);
    const rootOnly = unknown.words.length <= 1;
    let best = null;
    for (const c of pool) {
        if (c.words[0] !== unknown.words[0]) continue;
        // Every variant word of the donor must be in the unknown id.
        let shared = 0;
        let foreign = false;
        for (const w of new Set(c.words)) {
            if (wanted.has(w)) shared += 1; else { foreign = true; break; }
        }
        if (foreign) continue;
        if (!rootOnly && shared < 2) continue;
        const missing = wanted.size - shared;
        const distance = versionDistance(unknown.version, c.version);
        const blended = c.input + c.output;
        if (!best
            || missing < best.missing
            || (missing === best.missing && distance < best.distance)
            || (missing === best.missing && distance === best.distance && blended > best.blended)
            || (missing === best.missing && distance === best.distance && blended === best.blended && c.id < best.c.id)) {
            best = { c, missing, distance, blended };
        }
    }
    return best && best.c;
}

function sourceId(s) {
    return String(s).replace(/[^A-Za-z0-9._:/@+-]/g, '_').slice(0, 80);
}

/**
 * @param {{ model: string, vendor?: string|null, pool: ReturnType<typeof prepareCandidates> }} q
 *   `vendor` is the adapter type the model belongs to ('claude', 'openai', 'azure',
 *   'google', 'google-vertex', 'mistral', 'scaleway', ...) when known
 * @returns {{ level: 'family'|'provider', input: number, output: number, cacheRead: number|null,
 *             currency: string, source: string, donor: string|null } | null}
 */
function estimateRate({ model, vendor = null, pool }) {
    const unknown = parseModelId(model);
    if (unknown.words.length === 0) return null;
    const allowed = vendor ? vendorSet(vendor) : null;
    const nonChat = isNonChat(model);
    const scope = (Array.isArray(pool) ? pool : []).filter((c) => (allowed ? allowed.has(c.vendor) : true));

    // 1. nearest family
    const donor = pickFamily(unknown, scope.filter((c) => c.nonChat === nonChat && (nonChat || c.output > 0)));
    if (donor) {
        return {
            level: 'family',
            input: donor.input,
            output: donor.output,
            cacheRead: donor.cacheRead,
            currency: donor.currency,
            source: `estimate:family:${sourceId(donor.id)}`,
            donor: donor.id,
        };
    }

    // 2. the provider's upper quartile (chat models only)
    if (!vendor || nonChat) return null;
    const chat = scope.filter((c) => !c.nonChat && c.output > 0);
    const byCurrency = new Map();
    for (const c of chat) byCurrency.set(c.currency, (byCurrency.get(c.currency) || 0) + 1);
    let currency = null;
    for (const [cur, n] of byCurrency) if (!currency || n > byCurrency.get(currency)) currency = cur;
    const same = chat.filter((c) => c.currency === currency);
    if (same.length < MIN_PROVIDER_POOL) return null;
    const ins = same.map((c) => c.input).sort((a, b) => a - b);
    const outs = same.map((c) => c.output).sort((a, b) => a - b);
    return {
        level: 'provider',
        input: percentile(ins, PROVIDER_PERCENTILE),
        output: percentile(outs, PROVIDER_PERCENTILE),
        cacheRead: null,
        currency,
        source: `estimate:provider:${sourceId(vendor)}`,
        donor: null,
    };
}

module.exports = {
    MAX_INPUT_PER_M,
    MAX_OUTPUT_PER_M,
    PROVIDER_PERCENTILE,
    MIN_PROVIDER_POOL,
    parseModelId,
    prepareCandidates,
    estimateRate,
};
