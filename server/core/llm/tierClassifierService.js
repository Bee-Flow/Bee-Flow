// @typecheck
/**
 * Auto-tier selection through classify-service (the zero-shot GLiClass model
 * behind the Condition node's "is about" rule), instead of an LLM call.
 *
 * Why: the LLM classifier blocks a chat turn before anything streams, has to
 * read an ~800-token prompt plus the message, and on a busy local model it
 * queues behind other work. The CPU classifier answers a chat-length prompt
 * in a few hundred milliseconds. promptClassifier.js asks this module first
 * and only falls back to the LLM when it answers `null`.
 *
 * `null` means "no opinion": not installed, breaker open, deadline passed,
 * busy, or a verdict too close to call. Unlike the automation client this
 * never throws, because the caller always has a fallback.
 *
 * The deadline goes in as the caller's AbortSignal. classifierClient rethrows
 * an abort of the caller's signal without counting it as a failure, so a slow
 * chat answer never trips the breaker the automation runner depends on.
 *
 * Privacy: only the text and the labels go over the wire (allow-list), and
 * the logs carry the tier, the score and the timing, never the text.
 */

const log = require('../../telemetry/log');

const DEFAULT_DEADLINE_MS = Number(process.env.AUTO_TIER_CLASSIFIER_DEADLINE_MS) || 800;
/** Below this top score the model is guessing. */
const MIN_TOP_SCORE = 0.4;
/** The winning tier must score this many times the runner-up. */
const MIN_RATIO = 2;

/**
 * Several short, concrete labels per canonical tier; a tier scores as its
 * best label. Long descriptive sentences scored low on every label (a
 * zero-shot model matches what a text IS, not how hard it is), so these name
 * kinds of requests instead.
 *
 * Tuned with scripts/eval-auto-tier.mjs against its corpus (cut-offs chosen
 * on half, checked on the other half; 2026-10-02): the service decides 45 of
 * 60 prompts with 2 wrong and never picks Flow wrongly, where one long label
 * per tier decided 18. The service scores all labels in one pass (joint
 * mode), so their ORDER changes the scores: they are sent sorted, and any
 * tuning must sort them too. Change them with the script, not by feel. The
 * service takes at most 16 labels in all.
 */
const TIER_LABELS = {
    fast: ['greeting', 'thanks', 'trivia question', 'translation'],
    thinking: ['code', 'technical explanation', 'pros and cons'],
    writer: ['essay or article', 'letter or email', 'story, poem or speech', 'marketing or social media post'],
    standard: ['multi-step plan', 'research and then a report'],
    deep_thinking: ['mathematical proof', 'deep analysis'],
};

/** Canonical tier → configured keys that can serve it, preferred first. */
const TIER_KEYS = {
    fast: ['fast'],
    thinking: ['thinking', 'smart'],
    writer: ['writer'],
    standard: ['standard'],
    deep_thinking: ['deep_thinking', 'pro'],
};

/**
 * @param {Record<string, { modelId?: string }>} tiers
 * @returns {Map<string, string[]>} configured tier key → its labels
 */
function labelsFor(tiers) {
    const out = new Map();
    for (const [canonical, keys] of Object.entries(TIER_KEYS)) {
        const key = keys.find((k) => tiers[k]?.modelId);
        if (key) out.set(key, TIER_LABELS[canonical]);
    }
    return out;
}

/**
 * @param {string} text
 * @param {Record<string, { modelId?: string }>} tiers  only the tiers auto may pick
 * @param {{
 *   heuristic?: { score: number, reason: string } | null,
 *   deadlineMs?: number,
 *   endpoint?: { url: string|null, apiKey: string },
 *   request?: any,
 * }} [opts]  `endpoint` and `request` are seams for tests
 * @returns {Promise<{ tier: string, score: number, ms: number } | null>}
 */
async function classifyTierViaService(text, tiers, { heuristic = null, deadlineMs = DEFAULT_DEADLINE_MS, endpoint, request } = {}) {
    if (!text || typeof text !== 'string' || !text.trim()) return null;
    const byTier = labelsFor(tiers || {});
    // One tier is no choice; the caller's own logic covers it.
    if (byTier.size < 2) return null;

    const target = endpoint || await require('../classify/classifierEndpoint').getClassifierEndpoint().catch(() => null);
    if (!target || !target.url) return null;

    const labels = [...byTier.values()].flat().sort();
    const started = Date.now();
    let scores;
    // A plain timer, not AbortSignal.timeout(): that one is unref'd and so
    // cannot be relied on to fire while nothing else holds the event loop.
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new DOMException('auto-tier deadline', 'TimeoutError')), deadlineMs);
    try {
        const { classify } = require('../classify/classifierClient');
        const out = await classify([text.trim()], labels, {
            signal: deadline.signal,
            endpoint: target,
            ...(request ? { request } : {}),
        });
        scores = out.scores[0];
    } catch (err) {
        const why = err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'deadline' : (err?.detail || err?.errorClass || err?.name || 'error');
        log.info(`[Classifier] service: no verdict (${why}) after ${Date.now() - started}ms`);
        return null;
    } finally {
        clearTimeout(timer);
    }
    const ms = Date.now() - started;
    if (!scores) return null;

    const ranked = [...byTier].map(([key, ls]) => ({ key, score: Math.max(...ls.map((l) => scores[l])) }))
        .sort((a, b) => b.score - a.score);
    const { key: topKey, score: top } = ranked[0];
    const runnerUp = ranked[1]?.score ?? 0;
    if (top < MIN_TOP_SCORE || top < MIN_RATIO * runnerUp) {
        log.info(`[Classifier] service: too close to call (top=${top.toFixed(3)}, runner-up=${runnerUp.toFixed(3)}) in ${ms}ms`);
        return null;
    }

    let tier = topKey;
    // Structural signals the text model cannot see well: code, or several
    // heavy signals together, never go to the cheapest tier.
    const thinkingKey = TIER_KEYS.thinking.find((k) => tiers[k]?.modelId);
    if (tier === 'fast' && thinkingKey && heuristic && (heuristic.score >= 3 || /(^|, )code(,|$)/.test(heuristic.reason || ''))) {
        tier = thinkingKey;
    }
    log.info(`[Classifier] service: tier="${tier}" (score=${top.toFixed(3)}) in ${ms}ms`);
    return { tier, score: top, ms };
}

module.exports = { classifyTierViaService, TIER_LABELS, MIN_TOP_SCORE, MIN_RATIO };
