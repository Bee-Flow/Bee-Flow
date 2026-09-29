/**
 * "Is about" rules: `isAbout(text, "topic")` in a condition, a filter or a
 * switch case (shared/expr/topics.mjs), answered at run time by the topic
 * classifier (classify-service).
 *
 * Two findings, both completeness codes (draft: warning; activate: blocks):
 *
 *   route.topic_labels_too_many   — one step asks about more topics than the
 *                                   classifier takes in one call.
 *   route.topic_classifier_missing — the step uses "is about" and the caller
 *                                   says no classifier is configured
 *                                   (`topicClassifier === false`). `null`,
 *                                   "did not ask or could not reach it", is
 *                                   never a finding: a restart of the service
 *                                   must not block anyone's activation.
 *
 * A rule that does not parse is reported by the step's own parse rule; it
 * simply contributes no topics here.
 */

const { parseExpr, TOPIC_HOST_SPEC, MAX_TOPIC_LABELS, topicCallsOf } = require('../../expr');

function ruleExprsOf(step) {
    if (step.type === 'condition' || step.type === 'filter') return [step.expr];
    if (step.type === 'switch' && Array.isArray(step.cases)) return step.cases.map((c) => c && c.expr);
    return [];
}

function parseQuietly(src) {
    if (typeof src !== 'string' || !src.trim()) return null;
    try { return parseExpr(src, { host: TOPIC_HOST_SPEC }); } catch { return null; }
}

function checkTopics(ctx, step, at) {
    const { pushE, topicClassifier } = ctx;
    const exprs = ruleExprsOf(step);
    if (!exprs.length) return;
    const { labels, calls } = topicCallsOf(exprs.map(parseQuietly));
    if (!calls.length) return;
    if (labels.length > MAX_TOPIC_LABELS) {
        pushE({
            code: 'route.topic_labels_too_many', severity: 'error', path: at,
            message: `Step ${step.id}: its "is about" rules ask about ${labels.length} different topics; one step can ask about at most ${MAX_TOPIC_LABELS}.`,
            hint: 'Merge similar topics, or split the routing over two steps.',
        });
    }
    if (topicClassifier === false) {
        pushE({
            code: 'route.topic_classifier_missing', severity: 'error', path: at,
            message: `Step ${step.id}: uses "is about", but this installation has no topic classifier.`,
            hint: 'Ask an admin to start classify-service (compose profile "classify") and set CLASSIFY_SERVICE_URL, or replace the "is about" rules.',
        });
    }
}

module.exports = { checkTopics };
