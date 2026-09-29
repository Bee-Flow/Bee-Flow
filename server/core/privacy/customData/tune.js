'use strict';
/**
 * "Tune automatically": measure candidate settings on the admin's marked test
 * sentences and keep the best. No model is retrained; GLiNER is zero-shot, so
 * tuning means choosing a wording and a floor (ai), a pattern (pattern) or
 * two flags (words).
 *
 *   words    the four combinations of caseSensitive × wholeWord.
 *   pattern  the current pattern, the patterns inferred from the examples and
 *            the assistant's candidates; each must pass validatePattern AND
 *            match every real example completely.
 *   ai       up to 7 wordings (the current prompt, the type's name, the
 *            assistant's labels). ONE guard probe per wording, together with
 *            the org's other ai prompts, at the probe floor; then a local
 *            sweep of floors 0.20..0.90 in steps of 0.05.
 *
 * Ranking: F2 first (a miss leaks, a false alarm only over-hides), then fewer
 * false alarms, then the floor with the most MARGIN (ai only), then the
 * higher floor, then the shorter label or pattern, then the order tried (the
 * current setting is tried first, so it wins a full tie).
 *
 * Margin: for one wording, neighbouring floors often score exactly the same
 * on a small test set (measured on the real model: "project name" found 5 of
 * 5 with no false alarm at every floor from 0.75 to 0.90). The edge of that
 * run is the worst pick in it: at 0.90 a new name the model scores 0.85 is
 * missed, at 0.75 the next false alarm at 0.74 is let in. So a floor's margin
 * is its distance, in sweep steps, to the nearer edge of its equal-scoring
 * run, and the middle of the run wins. Across wordings the same key prefers
 * the wording with the WIDEST run: the widest gap between the scores of what
 * should be found and of everything else, so a new value is least likely to
 * land on the wrong side of the floor. On the real model this chose "code
 * name of a project" at 0.30 over "project name" at 0.90: both 5 of 5 with no
 * false alarm, but the first separates by three times as many steps.
 */

const { badRequest } = require('../../http/errors');
const { fScore } = require('./scoring');
const { fullMatchAll, inferPatternFromExamples, describePattern } = require('./patternTools');
const { LABEL_RX } = require('./assist');
const { predictLocal, probeAll, decodeAi, aiGroup, scoreAll } = require('./bench');

const MIN_GOLD_SENTENCES = 5;
const MAX_AI_WORDINGS = 7;
const EPS = 1e-9;
const FLOOR_SWEEP = Object.freeze(Array.from({ length: 15 }, (_, i) => Math.round((0.2 + i * 0.05) * 100) / 100));

const listOf = (v) => (Array.isArray(v) ? v : []);

function sensitivityFor(floor) {
    if (floor >= 0.7) return 'low';
    if (floor >= 0.45) return 'medium';
    return 'high';
}

/** Negative when `a` ranks before `b`. */
function compareCandidates(a, b) {
    const fa = fScore(a.summary);
    const fb = fScore(b.summary);
    if (Math.abs(fa - fb) > EPS) return fb - fa;
    if (a.summary.falseAlarms !== b.summary.falseAlarms) return a.summary.falseAlarms - b.summary.falseAlarms;
    if ((a.margin ?? 0) !== (b.margin ?? 0)) return (b.margin ?? 0) - (a.margin ?? 0);
    const floorA = a.floor ?? 0;
    const floorB = b.floor ?? 0;
    if (Math.abs(floorA - floorB) > EPS) return floorB - floorA;
    if ((a.length ?? 0) !== (b.length ?? 0)) return (a.length ?? 0) - (b.length ?? 0);
    return a.order - b.order;
}

function rankCandidates(candidates) {
    return [...candidates].sort(compareCandidates);
}

/** Strictly better on what counts: a higher F2, or the same F2 with fewer false alarms. */
function isImprovement(best, before) {
    const fb = fScore(best.summary);
    const f0 = fScore(before.summary);
    if (fb > f0 + EPS) return true;
    return Math.abs(fb - f0) <= EPS && best.summary.falseAlarms < before.summary.falseAlarms;
}

/** A wording the guard accepts as a prompt: 2..60 characters, no « << » or « >> ». */
const promptOk = (p) => typeof p === 'string' && p.trim().length >= 2 && p.trim().length <= 60 && !/<<|>>/.test(p);

async function tuneWords({ engine, spec, sentences }) {
    const cur = spec.words || {};
    const combos = [[!!cur.caseSensitive, !!cur.wholeWord]];
    for (const cs of [false, true]) {
        for (const ww of [true, false]) {
            if (!combos.some(([a, b]) => a === cs && b === ww)) combos.push([cs, ww]);
        }
    }
    const tried = [];
    for (const [caseSensitive, wholeWord] of combos) {
        const words = { ...cur, caseSensitive, wholeWord };
        const { spans } = await predictLocal(engine, { ...spec, words }, sentences.map((s) => s.text));
        tried.push({ config: { words }, summary: scoreAll(sentences, spans).summary, length: 0, order: tried.length });
    }
    return { before: tried[0], tried };
}

async function tuneAi({ engine, spec, sentences, candidates, orgTypes }) {
    const wordings = [];
    const add = (label, strict) => {
        const text = typeof label === 'string' ? label.trim() : '';
        if (!promptOk(text) || (strict && !LABEL_RX.test(text))) return;
        if (wordings.some((w) => w.toLowerCase() === text.toLowerCase()) || wordings.length >= MAX_AI_WORDINGS) return;
        wordings.push(text);
    };
    add(spec.ai.prompt, false);
    add(spec.name, true);
    for (const l of listOf(candidates?.aiLabels)) add(l, true);

    const texts = sentences.map((s) => s.text);
    const tried = [];
    let before = null;
    for (const prompt of wordings) {
        const { labelSet, floors } = aiGroup(spec, prompt, spec.ai.floor, orgTypes);
        const raw = await probeAll(engine, texts, labelSet);
        const floorsToTry = prompt === spec.ai.prompt ? [spec.ai.floor, ...FLOOR_SWEEP] : FLOOR_SWEEP;
        for (const floor of floorsToTry) {
            if (tried.some((t) => t.config.ai.prompt === prompt && Math.abs(t.config.ai.floor - floor) <= EPS)) continue;
            const spans = decodeAi(raw, { ...floors, [spec.id]: floor }, spec.id, texts.length);
            const entry = {
                config: { ai: { prompt, floor } },
                summary: scoreAll(sentences, spans).summary,
                floor,
                length: prompt.length,
                order: tried.length,
            };
            tried.push(entry);
            if (!before && prompt === spec.ai.prompt && floor === spec.ai.floor) before = entry;
        }
    }
    if (!before) throw badRequest('invalid_request', 'This type has no description for the AI that can be tuned.');
    markMargins(tried);
    return { before, tried };
}

/** Same outcome on the test set: F2, found and false alarms all equal. */
const sameOutcome = (a, b) => Math.abs(fScore(a.summary) - fScore(b.summary)) <= EPS
    && a.summary.found === b.summary.found && a.summary.falseAlarms === b.summary.falseAlarms;

/**
 * Per wording, walk its floors in order and give each entry its distance (in
 * steps) to the nearer end of the run of neighbouring floors that score the
 * same. See the header for why the middle of such a run is the safest floor.
 */
function markMargins(tried) {
    const byPrompt = new Map();
    for (const t of tried) {
        const list = byPrompt.get(t.config.ai.prompt) || [];
        list.push(t);
        byPrompt.set(t.config.ai.prompt, list);
    }
    for (const list of byPrompt.values()) {
        list.sort((a, b) => a.floor - b.floor);
        let start = 0;
        for (let i = 1; i <= list.length; i++) {
            if (i < list.length && sameOutcome(list[i], list[start])) continue;
            for (let k = start; k < i; k++) list[k].margin = Math.min(k - start, i - 1 - k);
            start = i;
        }
    }
}

async function tunePattern({ engine, spec, sentences, examples, candidates, validatePattern }) {
    const cur = spec.pattern || {};
    const caseSensitive = !!cur.caseSensitive;
    const texts = sentences.map((s) => s.text);
    const evaluate = async (pattern, order) => {
        const { spans } = await predictLocal(engine, { ...spec, pattern }, texts);
        return { config: { pattern }, summary: scoreAll(sentences, spans).summary, length: pattern.source.length, order };
    };
    const before = await evaluate(cur, 0);
    const tried = [];
    const sources = [cur.source, ...inferPatternFromExamples(examples, caseSensitive), ...listOf(candidates?.patterns)];
    const seen = new Set();
    for (const source of sources) {
        if (typeof source !== 'string' || !source || seen.has(source)) continue;
        seen.add(source);
        if (!fullMatchAll(source, examples, { caseSensitive })) continue;
        if (!(await validatePattern(source, caseSensitive))?.ok) continue;
        const pattern = source === cur.source ? cur : { source, caseSensitive, engine: 're2' };
        try {
            tried.push(source === cur.source ? { ...before, order: tried.length } : await evaluate(pattern, tried.length));
        } catch (err) {
            // A candidate the engine refuses to compile is simply not a candidate.
            if (err?.code !== 'pattern_unsafe' && err?.code !== 'invalid_request') throw err;
        }
    }
    return { before, tried };
}

function describeBest(method, config) {
    if (method === 'ai') return { label: config.ai.prompt, sensitivity: sensitivityFor(config.ai.floor) };
    if (method === 'pattern') {
        const words = describePattern(config.pattern.source);
        return words ? { patternWords: words } : {};
    }
    return { flags: { caseSensitive: !!config.words.caseSensitive, wholeWord: !!config.words.wholeWord } };
}

/**
 * Tuning needs something to measure: at least MIN_GOLD_SENTENCES sentences
 * with a marked part. Near misses (`gold: []`) are scored but do not count.
 * @throws HttpError 400 tune_needs_gold
 */
function assertEnoughGold(sentences) {
    const withGold = listOf(sentences).filter((s) => Array.isArray(s?.gold) && s.gold.length > 0).length;
    if (withGold < MIN_GOLD_SENTENCES) {
        throw badRequest('tune_needs_gold',
            `Mark what should be hidden in at least ${MIN_GOLD_SENTENCES} test sentences first; ${withGold} ${withGold === 1 ? 'has' : 'have'} a marked part now.`,
            { needed: MIN_GOLD_SENTENCES, have: withGold });
    }
    return withGold;
}

/**
 * @param {{ engine, spec, sentences, examples?: string[], candidates?: { aiLabels?: string[], patterns?: string[] },
 *           orgTypes?: object[], validatePattern: (source: string, caseSensitive: boolean) => Promise<{ok: boolean}> }} input
 *   `spec` is the engine-normalised draft; `sentences` the bench sentences.
 * @returns {Promise<{ best: { config, summary, describe }, before: { summary }, improved: boolean, tried: number }>}
 * @throws HttpError 400 tune_needs_gold when fewer than 5 sentences carry a marked part.
 */
async function tuneType({ engine, spec, sentences, examples = [], candidates = {}, orgTypes = [], validatePattern }) {
    assertEnoughGold(sentences);
    const scoredSentences = listOf(sentences).filter((s) => Array.isArray(s.gold));
    const input = { engine, spec, sentences: scoredSentences, examples: listOf(examples), candidates, orgTypes, validatePattern };
    let run;
    if (spec.method === 'words') run = await tuneWords(input);
    else if (spec.method === 'pattern') run = await tunePattern(input);
    else run = await tuneAi(input);

    const ranked = rankCandidates(run.tried);
    const before = run.before;
    const best = ranked[0] || before;
    return {
        best: { config: best.config, summary: best.summary, describe: describeBest(spec.method, best.config) },
        before: { summary: before.summary },
        improved: best !== before && isImprovement(best, before),
        tried: run.tried.length,
    };
}

module.exports = {
    MIN_GOLD_SENTENCES,
    FLOOR_SWEEP,
    sensitivityFor,
    compareCandidates,
    rankCandidates,
    isImprovement,
    assertEnoughGold,
    tuneType,
};
