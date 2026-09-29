/**
 * POST /topic-preview (topicPreview.js): the Condition editor's "Check the
 * sample rows" for "is about" rules. The classifier is injected; nothing here
 * touches a network.
 *
 * Run: node --test routes/ai/automationBuilder/topicPreview.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { previewTopics, TopicPreviewBody } = require('./topicPreview');

const fake = (calls = []) => async (texts, labels) => {
    calls.push({ texts, labels });
    return { scores: texts.map((t) => Object.fromEntries(labels.map((l) => [l, t.length / 100]))), defaultThreshold: 0.45 };
};

test('texts come back normalised and de-duplicated, topics trimmed and sorted', async () => {
    const calls = [];
    const out = await previewTopics({ texts: [' a mail ', 'a mail', '', 'other'], labels: [' spam', 'a complaint', 'spam'] }, { classify: fake(calls) });
    assert.deepStrictEqual(out.texts, ['a mail', 'other']);
    assert.deepStrictEqual(out.labels, ['a complaint', 'spam']);
    assert.deepStrictEqual(calls[0], { texts: ['a mail', 'other'], labels: ['a complaint', 'spam'] });
    assert.strictEqual(out.scores.length, 2);
    assert.strictEqual(out.defaultThreshold, 0.45);
});

test('no classifier installed is a 409 the editor can explain', async () => {
    const classify = async () => { throw Object.assign(new Error('x'), { errorClass: 'topic_classifier_not_configured' }); };
    await assert.rejects(previewTopics({ texts: ['a'], labels: ['b'] }, { classify }), (e) => e.status === 409 && e.code === 'topic_classifier_not_configured');
});

test('a classifier that does not answer is a 503', async () => {
    const classify = async () => { throw Object.assign(new Error('x'), { errorClass: 'topic_classifier_unavailable' }); };
    await assert.rejects(previewTopics({ texts: ['a'], labels: ['b'] }, { classify }), (e) => e.status === 503);
});

test('only blank texts is a 400, and the classifier is not asked', async () => {
    const calls = [];
    await assert.rejects(previewTopics({ texts: ['  ', ''], labels: ['b'] }, { classify: fake(calls) }), (e) => e.status === 400);
    assert.strictEqual(calls.length, 0);
});

test('the body schema: at most 25 texts, 16 topics, and nothing else', () => {
    assert.ok(TopicPreviewBody.safeParse({ texts: ['a'], labels: ['b'] }).success);
    assert.ok(!TopicPreviewBody.safeParse({ texts: Array(26).fill('a'), labels: ['b'] }).success);
    assert.ok(!TopicPreviewBody.safeParse({ texts: ['a'], labels: Array(17).fill('b') }).success);
    assert.ok(!TopicPreviewBody.safeParse({ texts: ['a'], labels: ['b'], threshold: 0.5 }).success);
});
