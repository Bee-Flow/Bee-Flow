/**
 * The pre-pass behind "is about" (topicHost.js): which texts it sends, the
 * caps, and the run budget. Executor behaviour is in execSwitch.topics.test.js
 * and execFilter.topics.test.js.
 *
 * Run: node --test core/automationRunner/topicHost.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { parseTopicExpr, prepareTopics, MAX_TEXTS_PER_STEP } = require('./topicHost');
const { evaluate } = require('../../automation/expr');

const answerAll = (score) => async (texts, labels) => ({
    scores: texts.map(() => Object.fromEntries(labels.map((l) => [l, score]))),
    defaultThreshold: 0.6,
    model: 'm',
    engine: 'e',
    truncated: 0,
});

test('distinct, normalised texts are sent once; the host answers with the service default threshold', async () => {
    const seen = [];
    const ctx = {
        _classifyTopics: async (texts, labels) => { seen.push(texts); return answerAll(0.55)(texts, labels); },
    };
    const ast = parseTopicExpr('isAbout(item.t, "x")');
    const rows = [{ t: ' same ' }, { t: 'same' }, { t: 'other' }, { t: null }];
    const { host, summary } = await prepareTopics([ast], () => rows.map((item) => ({ item })), ctx);
    assert.deepEqual(seen, [['same', 'other']]);
    assert.equal(summary.texts, 2);
    assert.equal(summary.defaultThreshold, 0.6);
    // 0.55 is under the service's own default of 0.6
    assert.equal(evaluate(ast, { item: rows[0] }, { host }), false);
    assert.equal(evaluate(parseTopicExpr('isAbout(item.t, "x", 0.5)'), { item: rows[0] }, { host }), true);
});

test('too many topics in one step is an error with its own class', async () => {
    const labels = Array.from({ length: 17 }, (_, i) => `isAbout(item.t, "topic ${i}")`).join(' || ');
    await assert.rejects(
        prepareTopics([parseTopicExpr(labels)], () => [{ item: { t: 'a' } }], { _classifyTopics: answerAll(0.1) }),
        (e) => e.errorClass === 'topic_labels_too_many' && e.topicFatal === true,
    );
});

test('too many texts for one step names the fix', async () => {
    const rows = Array.from({ length: MAX_TEXTS_PER_STEP + 1 }, (_, i) => ({ item: { t: `text ${i}` } }));
    await assert.rejects(
        prepareTopics([parseTopicExpr('isAbout(item.t, "x")')], () => rows, { _classifyTopics: answerAll(0.1) }),
        (e) => e.errorClass === 'topic_too_many_texts' && /Limit step/.test(e.message),
    );
});

test('the run budget adds up across steps', async () => {
    const ctx = { _classifyTopics: answerAll(0.1), _topicTextsUsed: 4_999 };
    const ast = parseTopicExpr('isAbout(item.t, "x")');
    await prepareTopics([ast], () => [{ item: { t: 'one' } }], ctx);
    assert.equal(ctx._topicTextsUsed, 5_000);
    await assert.rejects(
        prepareTopics([ast], () => [{ item: { t: 'two' } }], ctx),
        (e) => e.errorClass === 'topic_budget_exhausted',
    );
});

test('no isAbout call: no classifier, no summary', async () => {
    const ctx = { _classifyTopics: async () => { throw new Error('must not be called'); } };
    const res = await prepareTopics([parseTopicExpr('item.a == 1'), null], () => [{ item: {} }], ctx);
    assert.deepEqual(res, { host: null, summary: null });
    assert.equal(ctx._topicTextsUsed, undefined);
});

test('the run\'s cancel signal is handed to the classifier', async () => {
    const controller = new AbortController();
    let got = null;
    const ctx = {
        cancelSignal: controller.signal,
        _classifyTopics: async (texts, labels, opts) => { got = opts.signal; return answerAll(0.1)(texts, labels); },
    };
    await prepareTopics([parseTopicExpr('isAbout(item.t, "x")')], () => [{ item: { t: 'a' } }], ctx);
    assert.equal(got, controller.signal);
});
