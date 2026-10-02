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
const MIN_TOP_SCORE = 0.5;
/** A top label this close to the runner-up is a coin toss. */
const MIN_MARGIN = 0.05;

/**
 * One plain-language label per canonical tier. Tuned with
 * scripts/eval-auto-tier.mjs; change them there, not by feel.
 */
const TIER_LABELS = {
    fast: 'a greeting, small talk or a quick factual question',
    thinking: 'a technical question, code help or an explanation of one topic',
    writer: 'a request to write a long text such as an essay, article, story or email',
    standard: 'a multi-step task: plan or research first, then produce and check a result',
    deep_thinking: 'a hard problem needing deep research, proofs or careful trade-off analysis',
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
 * @returns {Map<string, string>} label → configured tier key
 */
function labelsFor(tiers) {
    const out = new Map();
    for (const [canonical, keys] of Object.entries(TIER_KEYS)) {
        const key = keys.find((k) => tiers[k]?.modelId);
        if (key) out.set(TIER_LABELS[canonical], key);
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
    const byLabel = labelsFor(tiers || {});
    // One label is no choice; the caller's own logic covers it.
    if (byLabel.size < 2) return null;

    const target = endpoint || await require('../classify/classifierEndpoint').getClassifierEndpoint().catch(() => null);
    if (!target || !target.url) return null;

    const labels = [...byLabel.keys()].sort();
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

    const ranked = labels.map((label) => ({ label, score: scores[label] })).sort((a, b) => b.score - a.score);
    const { label: topLabel, score: top } = ranked[0];
    const runnerUp = ranked[1]?.score ?? 0;
    if (top < MIN_TOP_SCORE || top - runnerUp < MIN_MARGIN) {
        log.info(`[Classifier] service: too close to call (top=${top.toFixed(3)}, margin=${(top - runnerUp).toFixed(3)}) in ${ms}ms`);
        return null;
    }

    let tier = /** @type {string} */ (byLabel.get(topLabel));
    // Structural signals the text model cannot see well: code, or several
    // heavy signals together, never go to the cheapest tier.
    const thinkingKey = TIER_KEYS.thinking.find((k) => tiers[k]?.modelId);
    if (tier === 'fast' && thinkingKey && heuristic && (heuristic.score >= 3 || /(^|, )code(,|$)/.test(heuristic.reason || ''))) {
        tier = thinkingKey;
    }
    log.info(`[Classifier] service: tier="${tier}" (score=${top.toFixed(3)}) in ${ms}ms`);
    return { tier, score: top, ms };
}

module.exports = { classifyTierViaService, TIER_LABELS, MIN_TOP_SCORE, MIN_MARGIN };
