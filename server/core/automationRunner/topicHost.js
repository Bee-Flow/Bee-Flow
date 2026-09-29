/**
 * The pre-pass that lets a condition, filter or switch step use
 * `isAbout(text, "topic")` (shared/expr/topics.mjs).
 *
 * The expression engine is synchronous and the classifier is a network call,
 * so the answer has to exist before the first row is evaluated:
 *
 *   1. the step's expressions are parsed ONCE with the topic host spec;
 *   2. every isAbout call is collected, with the step's complete topic list;
 *   3. each call's text argument is evaluated in every scope the step will
 *      evaluate in, and the distinct texts are classified in one go, all
 *      against that complete list (a zero-shot classifier's scores depend on
 *      which topics are asked together, so every text sees the same list);
 *   4. the step evaluates with makeTopicHost(scores).
 *
 * A step with no isAbout call returns `{ host: null }` without touching the
 * classifier, so every existing routine runs exactly as it did.
 *
 * Failures THROW (errorClass on the error) before any row is evaluated: the
 * step fails visibly instead of routing everything to "otherwise".
 */

const {
    parseExpr, evaluate, TOPIC_HOST_SPEC, MAX_TOPIC_LABELS, topicCallsOf, normalizeTopicText, makeTopicHost,
} = require('../../automation/expr');

/** Distinct texts one step invocation may classify. */
const MAX_TEXTS_PER_STEP = Number(process.env.AUTOMATION_TOPIC_MAX_TEXTS) || 500;
/** Distinct texts one run may classify, across every step and loop pass. */
const MAX_TEXTS_PER_RUN = Number(process.env.AUTOMATION_TOPIC_MAX_TEXTS_PER_RUN) || 5_000;

function topicError(errorClass, message) {
    const err = new Error(message);
    err.errorClass = errorClass;
    err.topicFatal = true;
    return err;
}

/** Parse an expression that may use isAbout. Throws ExprError like parseExpr. */
function parseTopicExpr(src) {
    return parseExpr(src, { host: TOPIC_HOST_SPEC });
}

/**
 * @param {Array<object|null>} asts       the step's parsed expressions (nulls skipped)
 * @param {() => Iterable<object>} scopes every scope the step will evaluate in
 * @param {object} ctx                    the run context (cancelSignal, budget, test seam)
 * @returns {Promise<{ host: object|null, summary: object|null }>}
 */
async function prepareTopics(asts, scopes, ctx) {
    const { labels, calls } = topicCallsOf(asts);
    if (!calls.length) return { host: null, summary: null };
    if (labels.length > MAX_TOPIC_LABELS) {
        throw topicError('topic_labels_too_many',
            `This step asks about ${labels.length} topics; one step can ask about at most ${MAX_TOPIC_LABELS}.`);
    }

    const texts = new Set();
    for (const scope of scopes()) {
        for (const call of calls) {
            let value;
            // A text argument that cannot be read in this scope is the row's
            // own problem: evaluation reports it for that row, as it always has.
            try { value = evaluate(call.args[0], scope); } catch { continue; }
            const text = normalizeTopicText(value);
            if (text) texts.add(text);
        }
    }
    if (texts.size > MAX_TEXTS_PER_STEP) {
        throw topicError('topic_too_many_texts',
            `This step would classify ${texts.size} different texts; the limit is ${MAX_TEXTS_PER_STEP}. Put a Limit step before it, or narrow the list.`);
    }
    const used = (ctx._topicTextsUsed || 0) + texts.size;
    if (used > MAX_TEXTS_PER_RUN) {
        throw topicError('topic_budget_exhausted',
            `This run has classified ${ctx._topicTextsUsed || 0} texts, and one run may classify at most ${MAX_TEXTS_PER_RUN}. Split the work over several runs.`);
    }
    ctx._topicTextsUsed = used;

    const list = [...texts];
    const classify = ctx._classifyTopics || require('../classify/classifierClient').classify;
    const started = Date.now();
    const res = await classify(list, labels, { signal: ctx.cancelSignal });
    const scores = new Map(list.map((t, i) => [t, res.scores[i]]));
    const summary = {
        topics: labels,
        texts: list.length,
        defaultThreshold: res.defaultThreshold,
        model: res.model || null,
        ms: Date.now() - started,
        ...(res.truncated ? { truncated: res.truncated } : {}),
        // One text (a one-output condition on the whole run): its scores are
        // the most useful thing to show next to the branch it took.
        ...(list.length === 1 ? { scores: res.scores[0] } : {}),
    };
    return { host: makeTopicHost(scores, { defaultThreshold: res.defaultThreshold }), summary };
}

module.exports = { parseTopicExpr, prepareTopics, MAX_TEXTS_PER_STEP, MAX_TEXTS_PER_RUN };
