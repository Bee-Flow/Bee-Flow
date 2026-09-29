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
    score += Math.max(0, 20 - daysOld * 2);

    // Importance.
    score += (typeof memory?.importance === 'number' ? memory.importance : 0.5) * 20;

    return score;
}

module.exports = {
    TYPE_BASE_SCORES,
    DEFAULT_TYPE_SCORE,
    RRF_K,
    LEG_WEIGHTS,
    renderedLength,
    renderedBullet,
    rrfFuse,
    finalScore,
};
