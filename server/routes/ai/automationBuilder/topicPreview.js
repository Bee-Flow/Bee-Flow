/**
 * POST /topic-preview: score the Condition editor's sample rows for its
 * "is about" rules, so "Check the sample rows" can show how many rows each
 * output would catch before the automation runs.
 *
 * Body: { texts: string[] (≤25), labels: string[] (≤ MAX_TOPIC_LABELS) }
 * Returns: { texts, labels, scores: [{ label: score }], defaultThreshold }
 *
 * The texts are the sample values the editor already shows its author (a
 * previous run's output). They go to the in-cluster classifier and nowhere
 * else, are not stored and are not logged: the client logs counts only.
 * The editor keys the scores by the SAME normalised text the runner uses
 * (shared/expr/topics.mjs), which is why `texts` comes back normalised.
 */

'use strict';

const express = require('express');
const { z } = require('zod');
const { requireAuth } = require('../../../auth/permissions');
const { validate } = require('../../../core/http/validate');
const { HttpError } = require('../../../core/http/errors');
const { topicPreviewRateLimit } = require('./rateLimits');
const { requireAutomationsBeta } = require('./routeRules');
const {
    MAX_TOPIC_LABELS, MAX_TOPIC_LABEL_CHARS, MAX_TOPIC_TEXT_CHARS, normalizeTopicText, topicLabel,
} = require('../../../automation/expr');

const router = express.Router();

const MAX_PREVIEW_TEXTS = 25;

const TopicPreviewBody = z.object({
    texts: z.array(z.string().max(MAX_TOPIC_TEXT_CHARS * 2), { invalid_type_error: 'texts is a list of sample texts.' })
        .min(1, 'Send at least one sample text.')
        .max(MAX_PREVIEW_TEXTS, `At most ${MAX_PREVIEW_TEXTS} sample texts.`),
    labels: z.array(z.string().max(MAX_TOPIC_LABEL_CHARS * 2), { invalid_type_error: 'labels is a list of topics.' })
        .min(1, 'Send at least one topic.')
        .max(MAX_TOPIC_LABELS, `At most ${MAX_TOPIC_LABELS} topics.`),
}).strict();

/**
 * The route's work, with the classifier injectable (the tests pass a fake;
 * the route passes nothing and gets the real client).
 */
async function previewTopics(body, { classify } = {}) {
    const texts = [...new Set(body.texts.map(normalizeTopicText).filter(Boolean))];
    const labels = [...new Set(body.labels.map(topicLabel).filter(Boolean))].sort();
    if (!texts.length) throw new HttpError(400, 'topic_preview_empty', 'None of the sample texts has any text in it.');
    if (!labels.length) throw new HttpError(400, 'topic_preview_no_topics', 'Send at least one topic.');
    if (labels.some((l) => l.length > MAX_TOPIC_LABEL_CHARS)) {
        throw new HttpError(400, 'topic_preview_topic_too_long', `Keep each topic under ${MAX_TOPIC_LABEL_CHARS} characters.`);
    }
    const run = classify || require('../../../core/classify/classifierClient').classify;
    let result;
    try {
        result = await run(texts, labels);
    } catch (e) {
        if (e && e.errorClass === 'topic_classifier_not_configured') {
            throw new HttpError(409, 'topic_classifier_not_configured', 'No topic classifier is installed on this server.');
        }
        if (e && e.errorClass === 'topic_classifier_unavailable') {
            throw new HttpError(503, 'topic_classifier_unavailable', 'The topic classifier did not answer. Try again in a moment.');
        }
        throw e;
    }
    return { texts, labels, scores: result.scores, defaultThreshold: result.defaultThreshold };
}

router.post('/topic-preview', requireAuth, topicPreviewRateLimit, requireAutomationsBeta, validate({ body: TopicPreviewBody }), async (req, res) => {
    res.json(await previewTopics(req.body));
});

module.exports = router;
module.exports.previewTopics = previewTopics;
module.exports.TopicPreviewBody = TopicPreviewBody;
