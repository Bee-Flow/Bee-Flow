/**
 * Topics: the `isAbout(text, "topic"[, threshold])` host function.
 *
 * A Condition node can route on MEANING: `isAbout(item.body, "a complaint")`
 * is true when a zero-shot classifier (classify-service) scores the text at or
 * above the threshold for that topic. The classifier is a network call, so the
 * answer can never come from FUNCTIONS (pure, synchronous, known to App
 * Studio). Instead the automation runner does a pre-pass: it collects every
 * isAbout call in a step (topicCallsOf), resolves the texts, asks the
 * classifier ONCE for all of them with the step's full topic list, and then
 * evaluates with the host from makeTopicHost. The builder's preview does the
 * same with the scores of its sample rows.
 *
 * Shared, like the rest of this directory, so the browser and the runner parse
 * the same calls, normalise texts the same way (the score table is keyed by
 * the normalised text) and apply thresholds the same way.
 *
 * The topic must be a string LITERAL. That is what lets the runner know a
 * step's whole topic list before it runs anything: a zero-shot classifier's
 * scores depend on which topics are asked together, so every text in a step
 * is scored against the same, complete list.
 */

import { collectHostCalls } from './engine.mjs';

export const TOPIC_FN = 'isAbout';
/** Distinct topics one step may ask about (the classifier's own ceiling). */
export const MAX_TOPIC_LABELS = 16;
export const MAX_TOPIC_LABEL_CHARS = 80;
/**
 * Text sent per item. The classifier reads about 500 tokens of it, the start
 * and the end (classify-service), so a longer text keeps its start and its
 * last TAIL characters here too: a cancellation in the closing line survives.
 */
export const MAX_TOPIC_TEXT_CHARS = 4000;
const TAIL_CHARS = 1000;
const GAP = '\n…\n';

const USAGE = 'isAbout needs a field and a topic in quotes, like isAbout(item.body, "a complaint")';

function checkIsAbout(args) {
    if (args.length < 2 || args.length > 3) return USAGE;
    const topic = args[1];
    if (topic.kind !== 'str' || !topic.v.trim()) return USAGE;
    if (topic.v.trim().length > MAX_TOPIC_LABEL_CHARS) {
        return `Keep the topic under ${MAX_TOPIC_LABEL_CHARS} characters`;
    }
    const cut = args[2];
    if (cut && !(cut.kind === 'num' && cut.v > 0 && cut.v < 1)) {
        return 'The sensitivity of isAbout must be a number between 0 and 1, like 0.7';
    }
    return null;
}

/**
 * Pass as `{ host: TOPIC_HOST_SPEC }` to parse or validate expressions that
 * may use isAbout. Evaluating with it (no scores) throws `unanswered`.
 */
export const TOPIC_HOST_SPEC = Object.freeze({
    [TOPIC_FN]: Object.freeze({
        check: checkIsAbout,
        unanswered: 'isAbout() is only answered while the step runs',
    }),
});

/** The key a topic is asked and looked up under. */
export function topicLabel(raw) {
    return String(raw ?? '').trim();
}

/**
 * The text the classifier sees for a value, and the key its scores are
 * stored under. Missing values are '' (never classified, never a match);
 * lists are read line by line; objects as JSON.
 */
export function normalizeTopicText(value) {
    let text;
    if (value == null) text = '';
    else if (typeof value === 'string') text = value;
    else if (typeof value === 'number' || typeof value === 'boolean') text = String(value);
    else if (Array.isArray(value)) text = value.map(normalizeTopicText).filter(Boolean).join('\n');
    else {
        try { text = JSON.stringify(value) ?? ''; } catch { text = ''; }
    }
    text = text.trim();
    if (text.length <= MAX_TOPIC_TEXT_CHARS) return text;
    return text.slice(0, MAX_TOPIC_TEXT_CHARS - TAIL_CHARS - GAP.length) + GAP + text.slice(-TAIL_CHARS);
}

/**
 * The isAbout calls in a set of parsed expressions, and their distinct topics
 * sorted by code point (the same order in every engine), which is the list
 * every text of the step is scored against.
 */
export function topicCallsOf(asts) {
    const calls = [];
    for (const ast of asts) {
        if (ast) calls.push(...collectHostCalls(ast).filter((n) => n.name === TOPIC_FN));
    }
    const labels = [...new Set(calls.map((c) => topicLabel(c.args[1].v)))].sort();
    return { labels, calls };
}

/**
 * The host that answers isAbout from a score table.
 *
 * @param {Map<string, Record<string, number>>} scoresByText  normalised text → topic → score
 * @param {{ defaultThreshold?: number }} [opts]
 *
 * A text that should have been scored and was not throws with `topicFatal`,
 * so the runner fails the step instead of reading "no score" as "no match".
 */
export function makeTopicHost(scoresByText, { defaultThreshold = 0.75 } = {}) {
    const fn = (value, topic, threshold) => {
        const text = normalizeTopicText(value);
        if (!text) return false;
        const label = topicLabel(topic);
        const scores = scoresByText.get(text);
        const score = scores && Object.prototype.hasOwnProperty.call(scores, label) ? scores[label] : undefined;
        if (typeof score !== 'number') {
            const err = new Error(`No topic score for "${label}"`);
            err.topicFatal = true;
            throw err;
        }
        return score >= (typeof threshold === 'number' ? threshold : defaultThreshold);
    };
    return { [TOPIC_FN]: { ...TOPIC_HOST_SPEC[TOPIC_FN], fn } };
}
