// @typecheck
/**
 * memoryScoring — pure ranking maths for memory retrieval.
 *
 * Deliberately free of any database, provider or config dependency, so the
 * numbers that decide what the model sees can be tested without a Postgres.
 * Every constant in here is something someone will eventually want to tune,
 * and before this module there was no way to tell a tuning improvement from a
 * regression.
 */

/**
 * How much a memory's kind is worth before any relevance signal.
 *
 * Standing instructions outrank everything because they are about HOW to
 * answer rather than what the question is about, so they are relevant to turns
 * whose text they share no words with. `context` is lowest because it is the
 * catch-all the extractor reaches for when nothing else fits.
 */
const TYPE_BASE_SCORES = {
    instruction: 100,
    person: 80,
    project: 70,
    preference: 60,
    workflow: 60,
    fact: 40,
    context: 20,
};

/** Score for a type the extractor has never emitted (or a hand-written row). */
const DEFAULT_TYPE_SCORE = 20;

/**
 * Half-life of the recency bonus, in days, per memory type.
 *
 * Standing instructions and preferences change rarely and stay true for
 * about a year; people, projects and workflows for roughly half of that; a
 * plain fact goes stale faster; `context` (what the person was busy with)
 * is only useful for about a month.
 */
const HALF_LIFE_DAYS = {
    instruction: 365,
    preference: 365,
    person: 180,
    project: 180,
    workflow: 180,
    fact: 120,
    context: 30,
};
const DEFAULT_HALF_LIFE_DAYS = 120;
/** Largest recency bonus, reached by a memory touched just now. */
const RECENCY_MAX_BONUS = 20;

/**
 * Recency bonus: exponential decay with a per-type half-life, so it fades
 * smoothly (a linear ramp went to zero after ten days for everything).
 * @param {string} type
 * @param {number} daysOld
 */
function recencyBonus(type, daysOld) {
    const halfLife = HALF_LIFE_DAYS[type] ?? DEFAULT_HALF_LIFE_DAYS;
    const age = Number.isFinite(daysOld) && daysOld > 0 ? daysOld : 0;
    return RECENCY_MAX_BONUS * Math.pow(0.5, age / halfLife);
}

/** Reciprocal-rank-fusion damping. 60 is the value the original RRF paper uses. */
const RRF_K = 60;

/**
 * Relative say each retrieval leg has in the fused ranking.
 *
 * `base` is the ordering the system used before hybrid retrieval existed
 * (importance, then recency). It is weighted lowest but is never removed,
 * because it is the leg that still works when pgvector is missing, the
 * embedding provider times out, or the row has not been backfilled yet. It is
 * the graceful-degradation mechanism, not a tie-breaker.
 */
const LEG_WEIGHTS = { vec: 1.0, fts: 0.8, base: 0.4 };

/**
 * Length of a memory AS IT WILL BE RENDERED into the prompt.
 *
 * The budget used to count `content.length` while `formatMemoriesForPrompt`
 * emitted `subject: attribute = value` for person/project rows and
 * `attribute: value` for preferences — so the two disagreed on exactly the
 * types whose canonical form is shortest than their content. The budget was
 * measuring one string and the prompt carrying another.
 *
 * Keep this in step with `formatMemoriesForPrompt`; `memoryScoring.test.js`
 * asserts they agree.
 */
function renderedLength(memory) {
    return renderedBullet(memory).length;
}

/**
 * The exact bullet `formatMemoriesForPrompt` will emit for this memory.
 *
 * Three distinct canonical forms, not one: person/project, preference and fact
 * each render `subject`/`attribute`/`value` differently, and instruction,
 * workflow and context ignore them entirely. Mirroring that here rather than
 * approximating it is the point — `memoryScoring.test.js` renders both and
 * compares, so a fourth form added to the renderer fails this file rather than
 * quietly putting the budget back out of step with the prompt.
 */
function renderedBullet(memory) {
    if (!memory) return '';
    const { type, subject, attribute, value, content } = memory;
    const canonical = subject && attribute && value;
    if (canonical) {
        if (type === 'person' || type === 'project') return `- ${subject}: ${attribute} = ${value}\n`;
        if (type === 'preference') return `- ${attribute}: ${value}\n`;
        if (type === 'fact') return `- ${subject}.${attribute}: ${value}\n`;
    }
    return `- ${content || ''}\n`;
}

/**
 * Fuse several ranked id lists into one score per id.
 *
 * RRF rather than score normalisation because the legs are not commensurable:
 * a cosine distance, a `ts_rank_cd` and an importance ordering have no shared
 * scale, and normalising them makes the weighting depend on how many results
 * each leg happened to return. Rank position is the only thing they agree on.
 *
 * @param {Array<{key: string, ids: string[]}>} legs ranked best-first
 * @param {{k?: number, weights?: Record<string, number>}} [options]
 * @returns {Map<string, number>} id → fused score
 */
function rrfFuse(legs, { k = RRF_K, weights = LEG_WEIGHTS } = {}) {
    const scores = new Map();
    for (const leg of legs || []) {
        if (!leg || !Array.isArray(leg.ids)) continue;
        const weight = weights[leg.key] ?? 1;
        leg.ids.forEach((id, index) => {
            const contribution = weight / (k + index + 1);
            scores.set(id, (scores.get(id) || 0) + contribution);
        });
    }
    return scores;
}

/**
 * Turn a fused RRF score into the number `selectWithinBudget` sorts on.
 *
 * RRF scores are tiny (order 1/60) and the budget pass has a hard
 * `score > 30` floor inherited from the pre-hybrid scoring, so the fused
 * score is scaled onto the same 0–100-ish range the type bases live on rather
 * than replacing them. That keeps one threshold meaning one thing across both
 * retrieval paths.
 *
 * @param {object} memory
 * @param {number} rrfScore
 * @param {{now?: number}} [options]
 */
function finalScore(memory, rrfScore, { now = Date.now() } = {}) {
    let score = TYPE_BASE_SCORES[memory?.type] ?? DEFAULT_TYPE_SCORE;

    // Relevance. The multiplier maps a top-ranked hit in every leg
    // (~0.036 with the default weights) to roughly the 100 points the old
    // `similarity * 100` term could reach.
    score += (rrfScore || 0) * 2750;

    // Recency, capped so a memory from today cannot outrank a highly relevant
    // one from last month on freshness alone.
    const updatedAt = memory?.updated_at ? new Date(memory.updated_at).getTime() : now;
    const daysOld = (now - updatedAt) / 86_400_000;
    score += recencyBonus(memory?.type, daysOld);

    // Importance.
    score += (typeof memory?.importance === 'number' ? memory.importance : 0.5) * 20;

    return score;
}

// ── Selective injection ──────────────────────────────────────────────────────
//
// Two tiers. PROFILE: a few standing instructions and preferences, always,
// whatever the message is about. RELEVANT: everything else, only with a real
// relevance signal for this message (`item.relevant`, set by the retrieval
// path), capped, best score first. The type base scores alone never qualify a
// memory: they used to let every row through.

const PROFILE_MAX_INSTRUCTIONS = 5;
const PROFILE_MAX_PREFERENCES = 3;
const PROFILE_MAX_CHARS = 300;
const RELEVANT_MAX = 8;
const RELEVANT_MAX_CHARS = 500;
/** Sealed/JS mode: a cosine within this distance of the best candidate counts as a hit. */
const RELATIVE_COSINE_MARGIN = 0.08;
/** Sealed/JS mode: share of a memory's longer words found in the message. */
const KEYWORD_OVERLAP_MIN = 0.3;
/** Two memories at or above this cosine are the same thing said twice. */
const DUPLICATE_COSINE = 0.95;

const normalisedText = (t) => String(t ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

function _cos(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) return 0;
    let dot = 0; let na = 0; let nb = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

function _clip(memory, max) {
    const content = String(memory.content ?? '');
    return content.length > max ? { ...memory, content: content.slice(0, max - 1) + '…' } : memory;
}

/**
 * @param {Array<{memory: object, score: number, relevant?: boolean, vector?: number[]|null}>} items
 * @param {number} charLimit
 * @returns {object[]} memories with `why: 'profile' | 'relevant'`, profile first
 */
/**
 * `profile: false` + a larger `relevantMax` is the explicit-search mode of the
 * memory_search tool: the model asked for more, so no profile padding and a
 * wider relevant cap, still relevance-only and de-duplicated.
 */
function selectTiers(items, charLimit, { profile = true, relevantMax = RELEVANT_MAX } = {}) {
    const sorted = (items || [])
        .filter(i => i && i.memory)
        .map((i, idx) => ({ ...i, _i: idx }))
        .sort((a, b) => (b.score - a.score) || (a._i - b._i));

    const out = [];
    const taken = new Set();
    const seen = [];   // { text, vector }
    let chars = 0;
    const isDuplicate = (item, text) => seen.some(s => s.text === text
        || (s.vector && item.vector && _cos(s.vector, item.vector) >= DUPLICATE_COSINE));
    const take = (item, why, max) => {
        const text = normalisedText(item.memory.content);
        if (isDuplicate(item, text)) return false;
        const memory = _clip(item.memory, max);
        const len = String(memory.content ?? '').length;
        if (chars + len > charLimit) return false;
        out.push({ ...memory, why });
        taken.add(item);
        seen.push({ text, vector: item.vector || null });
        chars += len;
        return true;
    };

    const byImportance = (a, b) =>
        ((b.memory.importance ?? 0.5) - (a.memory.importance ?? 0.5))
        || (new Date(b.memory.updated_at || 0).getTime() - new Date(a.memory.updated_at || 0).getTime())
        || (a._i - b._i);
    /** @type {Array<[string, number]>} */
    const profileCaps = profile ? [['instruction', PROFILE_MAX_INSTRUCTIONS], ['preference', PROFILE_MAX_PREFERENCES]] : [];
    for (const [type, cap] of profileCaps) {
        let n = 0;
        for (const item of sorted.filter(i => i.memory.type === type).sort(byImportance)) {
            if (n >= cap) break;
            if (take(item, 'profile', PROFILE_MAX_CHARS)) n++;
        }
    }

    let relevant = 0;
    for (const item of sorted) {
        if (relevant >= relevantMax) break;
        if (taken.has(item) || !item.relevant) continue;
        if (take(item, 'relevant', RELEVANT_MAX_CHARS)) relevant++;
    }
    return out;
}

/** Share of a memory's words longer than 3 characters that occur in the (lower-cased) message. */
function keywordOverlap(content, lowerMsg) {
    const words = String(content || '').toLowerCase().split(/\s+/).filter(w => w.length > 3);
    if (!words.length || !lowerMsg) return 0;
    return words.filter(w => lowerMsg.includes(w)).length / words.length;
}

module.exports = {
    PROFILE_MAX_INSTRUCTIONS, PROFILE_MAX_PREFERENCES, PROFILE_MAX_CHARS, RELEVANT_MAX, RELEVANT_MAX_CHARS,
    RELATIVE_COSINE_MARGIN, KEYWORD_OVERLAP_MIN, DUPLICATE_COSINE,
    normalisedText, selectTiers, keywordOverlap,
    TYPE_BASE_SCORES,
    DEFAULT_TYPE_SCORE,
    RRF_K,
    LEG_WEIGHTS,
    HALF_LIFE_DAYS,
    recencyBonus,
    renderedLength,
    renderedBullet,
    rrfFuse,
    finalScore,
};
