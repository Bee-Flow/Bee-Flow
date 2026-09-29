/**
 * "is about" rules in the Condition node: isAbout(text, "topic") answered by
 * the topic classifier through the pre-pass in topicHost.js, for a condition
 * and for every switch mode (list, column, scalar). The classifier is the
 * `ctx._classifyTopics` seam, so nothing here touches a network.
 *
 * Run: node --test core/automationRunner/execSwitch.topics.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { execSwitch, execCondition } = require('./execControl');

const MAILS = [
    { id: 1, body: 'The parcel arrived broken and nobody answers the phone.' },
    { id: 2, body: 'Please find attached invoice 2026-0412 for September.' },
    { id: 3, body: 'Broken parcel again, and the invoice is wrong too.' },
    { id: 4, body: 'Lunch on Friday?' },
];

// Score table keyed by text: what the fake classifier answers.
const SCORES = {
    [MAILS[0].body]: { 'a complaint': 0.93, 'an invoice': 0.04 },
    [MAILS[1].body]: { 'a complaint': 0.02, 'an invoice': 0.97 },
    [MAILS[2].body]: { 'a complaint': 0.81, 'an invoice': 0.66 },
    [MAILS[3].body]: { 'a complaint': 0.05, 'an invoice': 0.03 },
};

function fakeClassifier() {
    const calls = [];
    const classify = async (texts, labels) => {
        calls.push({ texts: [...texts], labels: [...labels] });
        return {
            scores: texts.map((t) => Object.fromEntries(labels.map((l) => [l, SCORES[t]?.[l] ?? 0]))),
            defaultThreshold: 0.5,
            model: 'fake-model',
            engine: 'fake',
            truncated: 0,
        };
    };
    return { classify, calls };
}

function runState() {
    return { trigger: { output: {} }, steps: { mail: { output: { results: MAILS } } }, vars: {}, secrets: {}, loop: {} };
}

const TOPIC_CASES = [
    { name: 'complaint', expr: 'isAbout(item.body, "a complaint")' },
    { name: 'invoice', expr: 'isAbout(item.body, "an invoice")' },
];

test('list mode fans an item out to every topic it is about; the rest goes to default', async () => {
    const { classify, calls } = fakeClassifier();
    const step = { id: 'route', type: 'switch', arrayRef: 'steps.mail.output.results', matchMode: 'all', cases: TOPIC_CASES };
    const { output } = await execSwitch(step, { _classifyTopics: classify }, runState());
    assert.deepEqual(output.matchesByCase.complaint.map((r) => r.id), [1, 3]);
    assert.deepEqual(output.matchesByCase.invoice.map((r) => r.id), [2, 3]);
    assert.deepEqual(output.matchesByCase.default.map((r) => r.id), [4]);
    assert.equal(calls.length, 1, 'one classifier call for the whole step');
    assert.deepEqual(calls[0].labels, ['a complaint', 'an invoice']);
    assert.equal(calls[0].texts.length, 4);
    assert.deepEqual(output.topics.topics, ['a complaint', 'an invoice']);
    assert.equal(output.topics.texts, 4);
    assert.equal(output._evalError, undefined);
});

test('first-match mode still sends an item to the first topic only', async () => {
    const { classify } = fakeClassifier();
    const step = { id: 'route', type: 'switch', arrayRef: 'steps.mail.output.results', cases: TOPIC_CASES };
    const { output } = await execSwitch(step, { _classifyTopics: classify }, runState());
    assert.deepEqual(output.matchesByCase.complaint.map((r) => r.id), [1, 3]);
    assert.deepEqual(output.matchesByCase.invoice.map((r) => r.id), [2]);
});

test('every text is scored against the step\'s full topic list, even when a rule short-circuits', async () => {
    const { classify, calls } = fakeClassifier();
    const step = {
        id: 'route', type: 'switch', arrayRef: 'steps.mail.output.results', matchMode: 'all',
        cases: [
            { name: 'big', expr: 'item.id > 100 && isAbout(item.body, "a complaint")' },
            { name: 'bill', expr: 'isAbout(item.body, "an invoice", 0.9)' },
        ],
    };
    const { output } = await execSwitch(step, { _classifyTopics: classify }, runState());
    assert.deepEqual(calls[0].labels, ['a complaint', 'an invoice']);
    assert.deepEqual(output.matchesByCase.big, []);
    assert.deepEqual(output.matchesByCase.bill.map((r) => r.id), [2], 'a per-rule threshold applies');
});

test('topics combine with ordinary rules in one case', async () => {
    const { classify } = fakeClassifier();
    const step = {
        id: 'route', type: 'switch', arrayRef: 'steps.mail.output.results',
        cases: [{ name: 'late', expr: 'isAbout(item.body, "a complaint") && contains(item.body, "again")' }],
    };
    const { output } = await execSwitch(step, { _classifyTopics: classify }, runState());
    assert.deepEqual(output.matchesByCase.late.map((r) => r.id), [3]);
});

test('column mode classifies the column the rule names', async () => {
    const { classify } = fakeClassifier();
    const step = {
        id: 'route', type: 'switch', expr: 'steps.mail.output.results[*].id', matchMode: 'all', cases: TOPIC_CASES,
    };
    const { output } = await execSwitch(step, { _classifyTopics: classify }, runState());
    assert.equal(output.mode, 'collection');
    assert.deepEqual(output.matchesByCase.complaint.map((r) => r.id), [1, 3]);
});

test('scalar mode: one text, and its scores are kept in the output', async () => {
    const { classify } = fakeClassifier();
    const state = runState();
    state.trigger.output.body = MAILS[1].body;
    const step = {
        id: 'route', type: 'switch', expr: 'trigger.output.body',
        cases: [
            { name: 'complaint', expr: 'isAbout(trigger.output.body, "a complaint")' },
            { name: 'invoice', expr: 'isAbout(trigger.output.body, "an invoice")' },
        ],
    };
    const { output } = await execSwitch(step, { _classifyTopics: classify }, state);
    assert.equal(output.branch, 'case:invoice');
    assert.deepEqual(output.topics.scores, { 'a complaint': 0.02, 'an invoice': 0.97 });
});

test('a condition on the whole run', async () => {
    const { classify } = fakeClassifier();
    const state = runState();
    state.trigger.output.body = MAILS[0].body;
    const { output } = await execCondition({ id: 'c', type: 'condition', expr: 'isAbout(trigger.output.body, "a complaint")' }, { _classifyTopics: classify }, state);
    assert.equal(output.branch, 'then');
    assert.equal(output.topics.texts, 1);
});

test('without isAbout the classifier is never called and the output keeps its shape', async () => {
    let called = false;
    const ctx = { _classifyTopics: async () => { called = true; throw new Error('must not be called'); } };
    const sw = await execSwitch({ id: 's', type: 'switch', arrayRef: 'steps.mail.output.results', cases: [{ name: 'one', expr: 'item.id == 1' }] }, ctx, runState());
    const cond = await execCondition({ id: 'c', type: 'condition', expr: 'trigger.output.x == null' }, ctx, runState());
    assert.equal(called, false);
    assert.ok(!('topics' in sw.output));
    assert.ok(!('topics' in cond.output));
});

test('rows with no text are not sent and do not match', async () => {
    const { classify, calls } = fakeClassifier();
    const state = runState();
    state.steps.mail.output.results = [...MAILS, { id: 5 }, { id: 6, body: '   ' }];
    const step = { id: 'route', type: 'switch', arrayRef: 'steps.mail.output.results', cases: TOPIC_CASES };
    const { output } = await execSwitch(step, { _classifyTopics: classify }, state);
    assert.equal(calls[0].texts.length, 4);
    assert.deepEqual(output.matchesByCase.default.map((r) => r.id), [4, 5, 6]);
});

test('a classifier failure fails the step instead of routing everything to default', async () => {
    const err = Object.assign(new Error('down'), { errorClass: 'topic_classifier_unavailable', topicFatal: true });
    const ctx = { _classifyTopics: async () => { throw err; } };
    const step = { id: 'route', type: 'switch', arrayRef: 'steps.mail.output.results', cases: TOPIC_CASES };
    await assert.rejects(execSwitch(step, ctx, runState()), (e) => e.errorClass === 'topic_classifier_unavailable');
    await assert.rejects(
        execCondition({ id: 'c', type: 'condition', expr: 'isAbout(trigger.output.x, "a") || true' }, { _classifyTopics: async () => { throw err; } },
            { ...runState(), trigger: { output: { x: 'text' } } }),
        (e) => e.errorClass === 'topic_classifier_unavailable',
    );
});

test('a bad isAbout call is a parse error on that case, not a crash', async () => {
    const { classify, calls } = fakeClassifier();
    const step = {
        id: 'route', type: 'switch', arrayRef: 'steps.mail.output.results',
        cases: [{ name: 'bad', expr: 'isAbout(item.body, item.topic)' }, ...TOPIC_CASES],
    };
    const { output } = await execSwitch(step, { _classifyTopics: classify }, runState());
    assert.match(output._evalError, /topic in quotes/);
    assert.deepEqual(output.matchesByCase.bad, []);
    assert.deepEqual(calls[0].labels, ['a complaint', 'an invoice']);
});

test('a condition whose isAbout does not parse records the error and takes else', async () => {
    const ctx = { _classifyTopics: async () => { throw new Error('must not be called'); } };
    const { output } = await execCondition({ id: 'c', type: 'condition', expr: 'isAbout(trigger.output.x)' }, ctx, runState());
    assert.equal(output.branch, 'else');
    assert.match(output._evalError, /isAbout needs/);
});
