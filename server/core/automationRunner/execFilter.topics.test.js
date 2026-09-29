/**
 * "is about" in a one-output, per-item Condition node, which saves as a
 * `filter` step: keep the items the classifier says are about the topic.
 *
 * Run: node --test core/automationRunner/execFilter.topics.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { execFilter } = require('./execCollections');

const FILES = [
    { name: 'Factuur_2026-0412_Jansen_BV.pdf', text: 'Factuur 2026-0412, te betalen binnen 30 dagen.' },
    { name: 'CV_Pieter_de_Vries.docx', text: 'Curriculum vitae, ervaring als monteur.' },
    { name: 'factuur-correctie.pdf', text: 'Creditnota bij factuur 2026-0398.' },
];

const SCORES = {
    [FILES[0].text]: 0.95,
    [FILES[1].text]: 0.03,
    [FILES[2].text]: 0.58,
};

function ctxWith(calls) {
    return {
        _classifyTopics: async (texts, labels) => {
            calls.push({ texts, labels });
            return {
                scores: texts.map((t) => ({ [labels[0]]: SCORES[t] })),
                defaultThreshold: 0.5, model: 'm', engine: 'e', truncated: 0,
            };
        },
    };
}

const state = () => ({ steps: { list: { output: { items: FILES } } }, vars: {}, trigger: { output: {} } });

test('keeps the items about the topic, and says what it asked', async () => {
    const calls = [];
    const step = { id: 'f', type: 'filter', arrayRef: 'steps.list.output.items', expr: 'isAbout(item.text, "an invoice")' };
    const { output } = await execFilter(step, ctxWith(calls), state());
    assert.deepEqual(output.items.map((f) => f.name), ['Factuur_2026-0412_Jansen_BV.pdf', 'factuur-correctie.pdf']);
    assert.equal(output.rejectedCount, 1);
    assert.deepEqual(output.topics.topics, ['an invoice']);
    assert.equal(calls.length, 1);
});

test('"is not about" with a stricter threshold', async () => {
    const step = { id: 'f', type: 'filter', arrayRef: 'steps.list.output.items', expr: '!isAbout(item.text, "an invoice", 0.7)' };
    const { output } = await execFilter(step, ctxWith([]), state());
    assert.deepEqual(output.items.map((f) => f.name), ['CV_Pieter_de_Vries.docx', 'factuur-correctie.pdf']);
});

test('a classifier failure fails the step', async () => {
    const step = { id: 'f', type: 'filter', arrayRef: 'steps.list.output.items', expr: 'isAbout(item.text, "an invoice")' };
    const ctx = { _classifyTopics: async () => { throw Object.assign(new Error('x'), { errorClass: 'topic_classifier_not_configured', topicFatal: true }); } };
    await assert.rejects(execFilter(step, ctx, state()), (e) => e.errorClass === 'topic_classifier_not_configured');
});

test('a filter without isAbout never calls the classifier', async () => {
    const ctx = { _classifyTopics: async () => { throw new Error('must not be called'); } };
    const step = { id: 'f', type: 'filter', arrayRef: 'steps.list.output.items', expr: 'endsWith(item.name, ".pdf")' };
    const { output } = await execFilter(step, ctx, state());
    assert.equal(output.count, 2);
    assert.ok(!('topics' in output));
});
