'use strict';

/**
 * A wizard page answered after a restart (formPublic/submit.js answerPage).
 *
 * The page's choices, its per-item questions and its conditions are computed
 * from run data when the run pauses. After a pod restart NOTHING but the
 * stored step row (`output.form`, the rendered config as JSON) carries them,
 * so the answer has to be judged against exactly that: the listed values, the
 * expanded question names, the rules and the showIf conditions.
 *
 * Harness: formPublic.testkit.js (mocks first, then the real router).
 *
 * Run: node --test routes/automation/formPublic/submit.wizard.test.js
 */
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const {
    TOKEN, state, resetState, issueCsrf, postSession, makeRes, makeReq, flushAsync, startSession, awaitingRun,
} = require('./formPublic.testkit');
const { renderFormConfig } = require('../../../automation/formTriggerContract');

beforeEach(resetState);

const AUTHORED_PAGE = {
    title: 'Follow up',
    submitLabel: 'Send',
    fields: [
        { name: 'contact', type: 'radio', label: 'Contact by', required: true, options: [{ value: 'email', label: 'E-mail' }, { value: 'phone', label: 'Phone' }] },
        { name: 'address', type: 'email', label: 'Address', required: true, showIf: 'form.contact == "email"' },
        { name: 'number', type: 'text', label: 'Number', required: true, minLength: 5, showIf: 'form.contact == "phone"' },
        { name: 'choice', type: 'radio', label: 'Pick one', required: true, optionsFrom: { ref: 'steps.load.output.rows', value: 'id', label: 'title', hint: 'note' } },
        { name: 'topics', type: 'multiselect', label: 'Topics', options: ['Option A', 'Option B', 'Option C'], maxSelected: 2 },
        { name: 'rating', type: 'select', label: 'Rate it', required: true, options: ['good', 'poor'], fieldsFrom: { ref: 'steps.load.output.rows', value: 'id', label: 'title' } },
    ],
};

const ROWS = [
    { id: 'item_1', title: 'First', note: 'The first one' },
    { id: 'item_2', title: 'Second' },
];

/** What the runner stores when it pauses on the page, after a JSON round trip. */
function storedPage(rows = ROWS) {
    const rendered = renderFormConfig(AUTHORED_PAGE, { resolveList: (ref) => (ref === 'steps.load.output.rows' ? rows : undefined) });
    return JSON.parse(JSON.stringify(rendered));
}

const ANSWERS = { contact: 'phone', number: '0123456', choice: 'item_2', topics: ['Option B'], rating__1: 'good', rating__2: 'poor' };

async function answer(sid, over = {}, nonce = 'w1') {
    const res = makeRes();
    await postSession(makeReq({ sid, body: { csrf: issueCsrf(`${TOKEN}:${sid}`), nonce, ...ANSWERS, ...over } }), res);
    await flushAsync();
    return res;
}

async function pausedOn(rows) {
    state.runQueue = [{ id: 'runW' }];
    const sid = await startSession();
    awaitingRun('runW', 'fp1', storedPage(rows));
    state.runQueue = [{ id: 'runW2' }];
    return sid;
}

test('the stored page carries the vocabulary, and nothing about where it came from', () => {
    const page = storedPage();
    assert.deepEqual(page.fields.find(f => f.name === 'choice').options.map(o => o.value), ['item_1', 'item_2']);
    assert.ok(page.fields.some(f => f.name === 'rating__1'));
    assert.ok(!JSON.stringify(page).includes('steps.load.output.rows'));
});

test('a listed value is accepted and the resume carries the value, not the label', async () => {
    const sid = await pausedOn();
    const res = await answer(sid);
    assert.strictEqual(res.statusCode, 202, JSON.stringify(res.body));
    assert.strictEqual(state.resumes.length, 1);
    const { decision } = state.resumes[0].opts;
    assert.strictEqual(decision.choice, 'item_2');
    assert.deepEqual(decision.topics, ['Option B']);
    assert.strictEqual(decision.contact, 'phone');
});

test('a label is not a value', async () => {
    const sid = await pausedOn();
    const res = await answer(sid, { choice: 'Second' });
    assert.strictEqual(res.statusCode, 400);
    assert.deepEqual(res.body.fields.map(f => f.field), ['choice']);
    assert.match(res.body.fields[0].message, /offered choices/);
    assert.strictEqual(state.resumes.length, 0);
});

test('an off-list value is a 400 with a field error, and the run stays paused', async () => {
    const sid = await pausedOn();
    const res = await answer(sid, { choice: 'item_99', topics: ['Option Z'] });
    assert.strictEqual(res.statusCode, 400);
    assert.deepEqual(res.body.fields.map(f => f.field).sort(), ['choice', 'topics']);
    assert.strictEqual(state.resumes.length, 0);
});

test('a hidden required question does not block, and nothing typed into it is carried', async () => {
    const sid = await pausedOn();
    // Phone was chosen: the address is hidden, whatever the body says.
    const res = await answer(sid, { address: 'someone@example.com' });
    assert.strictEqual(res.statusCode, 202, JSON.stringify(res.body));
    assert.strictEqual(state.resumes[0].opts.decision.address, '');
});

test('the visible branch is still enforced, with its rules', async () => {
    const sid = await pausedOn();
    const missing = await answer(sid, { contact: 'email' }, 'w2');
    assert.strictEqual(missing.statusCode, 400);
    assert.deepEqual(missing.body.fields.map(f => f.field), ['address']);

    const short = await answer(sid, { number: '12' }, 'w3');
    assert.strictEqual(short.statusCode, 400);
    assert.deepEqual(short.body.fields.map(f => f.field), ['number']);
    assert.match(short.body.fields[0].message, /at least 5 characters/);
    assert.strictEqual(state.resumes.length, 0);
});

test('multiselect bounds come from the stored page', async () => {
    const sid = await pausedOn();
    const res = await answer(sid, { topics: ['Option A', 'Option B', 'Option C'] });
    assert.strictEqual(res.statusCode, 400);
    assert.match(res.body.fields[0].message, /at most 2 choices/);
});

test('group answers arrive folded as { key, label, answer } in item order', async () => {
    const sid = await pausedOn();
    const res = await answer(sid);
    assert.strictEqual(res.statusCode, 202, JSON.stringify(res.body));
    const { decision } = state.resumes[0].opts;
    assert.deepEqual(decision.rating, [
        { key: 'item_1', label: 'First', answer: 'good' },
        { key: 'item_2', label: 'Second', answer: 'poor' },
    ]);
    assert.strictEqual('rating__1' in decision, false);
    assert.strictEqual('rating__2' in decision, false);
});

test('an expanded question is judged by its own name, so the error shows inline', async () => {
    const sid = await pausedOn();
    const res = await answer(sid, { rating__2: 'meh' });
    assert.strictEqual(res.statusCode, 400);
    assert.deepEqual(res.body.fields.map(f => f.field), ['rating__2']);
});

test('a page whose list came back empty can still be answered', async () => {
    const sid = await pausedOn([]);
    const body = { contact: 'phone', number: '0123456' };
    const res = makeRes();
    await postSession(makeReq({ sid, body: { csrf: issueCsrf(`${TOKEN}:${sid}`), nonce: 'w9', ...body } }), res);
    await flushAsync();
    assert.strictEqual(res.statusCode, 202, JSON.stringify(res.body));
    const { decision } = state.resumes[0].opts;
    assert.strictEqual(decision.choice, '');
    assert.deepEqual(decision.rating, []);
});
