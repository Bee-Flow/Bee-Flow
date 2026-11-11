/**
 * App Studio AI steps with answer checks (`checks`, `repairRounds`): the automation ai_step's
 * checks and repair message around ai_generate / ai_extract's model calls (aiChecks.mts). The
 * runtime is handed in, so a fake one records every call and answers from a queue. Without
 * checks the step makes exactly the one call it always made.
 *
 * Run: cd server && node --test appStudio/actionExecutor/aiChecks.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { answerStructured, answerText, checkExtractRows, checkedAnswer } = require('./aiChecks.mts');
const { readAppReliability } = require('../aiReliability.mts');
const { describeStepError } = require('./stepErrors.mts');
const { mockStepResult, defaultMockHelpers } = require('../actionTests/mockStep.mts');

const SCOPE = { form: { files: [{ fileId: 'f1' }, { fileId: 'f2' }] }, vars: { categories: [{ name: 'Billing' }, { name: 'Support' }] } };
const FIELDS = [{ name: 'category' }];
const CATEGORY_CHECK = { kind: 'allowedFrom', field: 'category', ref: 'vars.categories', value: 'name' };

/** A fake aiRuntime: answers from `answers` (the last one repeats), every call recorded. */
function runtime(answers) {
    const calls = [];
    const next = () => (answers.length > 1 ? answers.shift() : answers[0]);
    return {
        calls,
        runStructuredWithTools: async (app, model, args) => { calls.push({ model, args }); return { structured: next() }; },
        runTextWithTools: async (app, model, args) => { calls.push({ model, args }); return { text: next() }; },
        coerceRowToFields: (row, fields) => Object.fromEntries(fields.map((f) => [f.name, row ? (row[f.name] ?? null) : null])),
        MAX_EXTRACT_ROWS: 500,
    };
}
const MODEL = { modelId: 'm' };
const TOOLS = [{ def: { function: { name: 'query_genome_dataset' } } }];
const stepCall = (rt, step) => ({ rt, app: { id: 'app-1' }, model: MODEL, rel: readAppReliability(step), scope: SCOPE });
const BASE = { system: 'sys', user: 'Classify the ticket', parameters: { type: 'object' } };

test('without checks: one call with the step’s own arguments, no follow-up, no report', async () => {
    const rt = runtime([{ category: 'Bananas' }]);
    const r = await answerStructured(stepCall(rt, {}), BASE, TOOLS, FIELDS);
    assert.deepEqual(r.output, { category: 'Bananas' });
    assert.equal(r.checkReport, undefined);
    assert.equal(rt.calls.length, 1);
    assert.equal(rt.calls[0].model, MODEL);
    assert.deepEqual(rt.calls[0].args, { ...BASE, tools: TOOLS });
});

test('a failing answer gets a repair round: the model sees its own answer and what failed, then passes', async () => {
    const rt = runtime([{ category: 'Bananas' }, { category: 'billing' }]);
    const r = await answerStructured(stepCall(rt, { checks: [CATEGORY_CHECK] }), BASE, TOOLS, FIELDS);
    // The list's own spelling (ignoreCase is the default), as in automations.
    assert.deepEqual(r.output, { category: 'Billing' });
    assert.deepEqual(r.checkReport, { passed: true, repaired: true, fallbackUsed: false, errors: [], rounds: 1 });
    assert.equal(rt.calls.length, 2);
    const repair = rt.calls[1].args;
    assert.deepEqual(repair.tools, [], 'a repair round offers no tools');
    assert.equal(repair.user, BASE.user, 'the original request is repeated');
    const [assistant, user] = repair.followUp;
    assert.deepEqual(assistant, { role: 'assistant', content: JSON.stringify({ category: 'Bananas' }) });
    assert.match(user.content, /category: the value is not one of the allowed values \(you wrote: "Bananas"\)/);
    assert.doesNotMatch(user.content, /Support|Billing/, 'the allowed values are not sent in the repair message');
});

test('passing first time: one call and a report', async () => {
    const rt = runtime([{ category: 'Support' }]);
    const r = await answerStructured(stepCall(rt, { checks: [CATEGORY_CHECK] }), BASE, TOOLS, FIELDS);
    assert.equal(rt.calls.length, 1);
    assert.deepEqual(r.checkReport, { passed: true, repaired: false, fallbackUsed: false, errors: [], rounds: 0 });
});

test('still failing after repairRounds: ai_check_failed, which the step-error mapping keeps (retryable, no values)', async () => {
    const rt = runtime([{ category: 'Bananas' }]);
    const err = await answerStructured(stepCall(rt, { checks: [CATEGORY_CHECK], repairRounds: 2 }), BASE, TOOLS, FIELDS).then(() => null, (e) => e);
    assert.equal(rt.calls.length, 3);
    assert.equal(err.status, 422);
    assert.equal(err.code, 'ai_check_failed');
    const res = describeStepError(err, { kind: 'ai_generate' });
    assert.deepEqual(res, {
        ok: false, code: 'ai_check_failed', retryable: true,
        error: 'The AI answer did not pass its checks after 2 repair rounds: category: the value is not one of the allowed values',
    });
    assert.doesNotMatch(res.error, /Bananas|Billing/);
});

test('repairRounds 0: checked, never repaired', async () => {
    const rt = runtime([{ category: 'Bananas' }]);
    const err = await answerStructured(stepCall(rt, { checks: [CATEGORY_CHECK], repairRounds: 0 }), BASE, TOOLS, FIELDS).then(() => null, (e) => e);
    assert.equal(rt.calls.length, 1);
    assert.equal(err.message, 'The AI answer did not pass its checks: category: the value is not one of the allowed values');
});

test('a list that is not there fails with the path that names it', async () => {
    const rt = runtime([{ category: 'x' }]);
    const step = { checks: [{ kind: 'allowedFrom', field: 'category', ref: 'vars.nothing' }], repairRounds: 0 };
    const err = await answerStructured(stepCall(rt, step), BASE, TOOLS, FIELDS).then(() => null, (e) => e);
    assert.match(err.message, /the list of allowed values \(vars\.nothing\) is empty: nothing set it before this step/);
});

test('a text answer is checked as { text }', async () => {
    const rt = runtime(['Привет', 'Hello there']);
    const r = await answerText(stepCall(rt, { checks: [{ kind: 'script', field: 'text', script: 'latin' }] }), { system: 'sys', user: 'Greet' }, []);
    assert.deepEqual(r.output, { text: 'Hello there' });
    assert.equal(rt.calls[1].args.followUp[0].content, 'Привет');
    assert.equal(r.checkReport.repaired, true);
});

test('ai_extract: the rows are checked as { rows }; the repaired rows are the ones returned', async () => {
    const rt = runtime([{ rows: [{ sku: 'A' }, { sku: 'B' }] }]);
    const step = { checks: [{ kind: 'items', field: 'rows', sameCountAs: 'form.files' }] };
    const r = await checkExtractRows(stepCall(rt, step), BASE, [{ name: 'sku' }], { rows: [{ sku: 'A' }] }, () => new Error('no rows'));
    assert.deepEqual(r.rows, [{ sku: 'A' }, { sku: 'B' }]);
    assert.equal(r.checkReport.rounds, 1);
    assert.equal(rt.calls.length, 1, 'the first answer is the step’s own; only the repair is asked here');
    assert.match(rt.calls[0].args.followUp[1].content, /rows: it must have as many items as the source list/);
});

test('ai_extract: a repair answer without rows is the step’s no-records failure', async () => {
    const rt = runtime([{ nothing: true }]);
    const noRows = Object.assign(new Error('no records'), { status: 422, code: 'ai_no_output' });
    const err = await checkExtractRows(stepCall(rt, { checks: [{ kind: 'items', field: 'rows', minItems: 2 }] }), BASE, [{ name: 'sku' }], { rows: [{ sku: 'A' }] }, () => noRows)
        .then(() => null, (e) => e);
    assert.equal(err, noRows);
});

test('checkedAnswer: an unreadable check is dropped by the reader, so the step runs as without checks', async () => {
    let asked = 0;
    const r = await checkedAnswer(readAppReliability({ checks: [{ kind: 'allowedFrom', field: 'category', ref: 'trigger.x' }] }), SCOPE, {
        ask: async () => { asked += 1; return { category: 'Bananas' }; },
        view: (a) => ({ output: a, modelOutput: a, prior: a }),
    });
    assert.equal(asked, 1);
    assert.deepEqual(r.output, { category: 'Bananas' });
    assert.equal(r.checkReport, undefined);
});

test('a mocked step (app_run_action / app_run_tests) behaves as before: the mock is the answer, no checks run', () => {
    const step = (extra) => ({ kind: 'ai_generate', prompt: 'Classify', output: 'structured', schema: FIELDS, resultVar: 'r', ...extra });
    const opts = { prompt: 'Classify', helpers: defaultMockHelpers() };
    const res = mockStepResult(step({ checks: [CATEGORY_CHECK], repairRounds: 3 }), { category: 'Bananas' }, opts);
    assert.deepEqual(res, mockStepResult(step({}), { category: 'Bananas' }, opts));
    assert.equal(res.ok, true);
});
