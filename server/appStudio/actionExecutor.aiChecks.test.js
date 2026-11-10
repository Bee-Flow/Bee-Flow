/**
 * App Studio AI steps with answer checks (ai_generate / ai_extract `temperature`, `checks`,
 * `repairRounds`): the automation ai_step's checks and repair message, run through
 * executeDataStep with appStudio/aiRuntime stubbed (a queue of model answers, every call recorded).
 * A step without the fields makes exactly the one call it always made.
 *
 * Run: cd server && node --test appStudio/actionExecutor.aiChecks.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

function stub(path, exports) {
    const filename = require.resolve(path);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

stub('../stores/studioAppDbStore', { query: async () => ({ rows: [] }), exec: async () => ({ changes: 1 }), batch: async (o, a, s) => s.map(() => ({ changes: 1 })), sizeBytes: async () => 0 });
stub('../stores/studioAppDataStore', { bumpDataVersion: async () => 1, bumpRowCount: async () => ({}), getRowCounts: async () => ({}), getMemberRole: async () => null });

const MODEL = Object.freeze({ modelId: 'm-std', options: Object.freeze({ temperature: 0.7 }), supportsVision: false, tierName: 'standard' });
/** @type {Array<{ fn: string, model: any, args: any }>} */
const calls = [];
/** @type {any[]} */
let answers = [];
const next = () => (answers.length > 1 ? answers.shift() : answers[0]);
stub('./aiRuntime', {
    resolveOwnerModel: async () => MODEL,
    extractDocuments: async (app, descriptors, opts) => { if (opts && opts.report) opts.report.read += descriptors.length; return [{ type: 'text', text: 'DOC' }]; },
    groundWithKB: async () => ({ context: '', chunks: [] }),
    runStructuredWithTools: async (app, model, args) => { calls.push({ fn: 'structured', model, args }); return { structured: next() }; },
    runTextWithTools: async (app, model, args) => { calls.push({ fn: 'text', model, args }); return { text: next() }; },
    fieldsToObjectSchema: (fields) => ({ type: 'object', properties: Object.fromEntries(fields.map((f) => [f.name, { type: 'string' }])) }),
    normalizeSchemaFields: (fields) => (Array.isArray(fields) ? fields.filter((f) => f && f.name).map((f) => ({ name: f.name, type: f.type || 'string', required: !!f.required })) : []),
    coerceRowToFields: (row, fields) => { const o = {}; for (const f of fields) o[f.name] = row ? (row[f.name] ?? null) : null; return o; },
    MAX_EXTRACT_ROWS: 500,
});

const { executeDataStep } = require('./actionExecutor');
const { mockStepResult, defaultMockHelpers } = require('./actionTests/mockStep.mts');

const APP = { id: 'app-1', userId: 'owner-1', organizationId: 'org-1' };
const DATA = { tables: [] };
const CTX = { viewerId: 'u1', formValues: { files: [{ fileId: 'f1' }, { fileId: 'f2' }] }, vars: { categories: [{ name: 'Billing' }, { name: 'Support' }] } };
const gen = (extra = {}) => ({ kind: 'ai_generate', prompt: 'Classify the ticket', output: 'structured', schema: [{ name: 'category', type: 'string' }], resultVar: 'r', ...extra });
const CATEGORY_CHECK = { kind: 'allowedFrom', field: 'category', ref: 'vars.categories', value: 'name' };
const run = async (step, given) => { calls.length = 0; answers = given; return executeDataStep(APP, DATA, step, CTX); };

test('without the fields: one call, the resolved model as is, no follow-up, no checkReport', async () => {
    const r = await run(gen(), [{ category: 'Bananas' }]);
    assert.deepEqual(r, { ok: true, result: { category: 'Bananas' } });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].model, MODEL);
    assert.equal('followUp' in calls[0].args, false);
});

test('temperature goes into the call options of every call; the tier model is not changed', async () => {
    const r = await run(gen({ temperature: 0 }), [{ category: 'x' }]);
    assert.equal(r.ok, true);
    assert.equal(calls[0].model.options.temperature, 0);
    assert.equal(calls[0].model.modelId, 'm-std');
    assert.equal(MODEL.options.temperature, 0.7);
});

test('a failing answer gets a repair round: the model sees its own answer and what failed, then passes', async () => {
    const r = await run(gen({ checks: [CATEGORY_CHECK] }), [{ category: 'Bananas' }, { category: 'billing' }]);
    assert.equal(r.ok, true);
    // The list's own spelling (ignoreCase is the default), as in automations.
    assert.deepEqual(r.result, { category: 'Billing' });
    assert.deepEqual(r.checkReport, { passed: true, repaired: true, fallbackUsed: false, errors: [], rounds: 1 });
    assert.equal(calls.length, 2);
    const [assistant, user] = calls[1].args.followUp;
    assert.deepEqual(assistant, { role: 'assistant', content: JSON.stringify({ category: 'Bananas' }) });
    assert.equal(user.role, 'user');
    assert.match(user.content, /category: the value is not one of the allowed values \(you wrote: "Bananas"\)/);
    assert.doesNotMatch(user.content, /Support/, 'the allowed values are not sent in the repair message');
    assert.deepEqual(calls[1].args.tools, [], 'a repair round offers no tools');
    assert.equal(calls[1].args.user, calls[0].args.user, 'the original request is repeated');
});

test('passing first time: one call and a report', async () => {
    const r = await run(gen({ checks: [CATEGORY_CHECK] }), [{ category: 'Support' }]);
    assert.equal(r.ok, true);
    assert.equal(calls.length, 1);
    assert.deepEqual(r.checkReport, { passed: true, repaired: false, fallbackUsed: false, errors: [], rounds: 0 });
});

test('still failing after repairRounds: the step fails, retryable, with paths and rules but no values', async () => {
    const r = await run(gen({ checks: [CATEGORY_CHECK], repairRounds: 2 }), [{ category: 'Bananas' }]);
    assert.equal(calls.length, 3);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'ai_check_failed');
    assert.equal(r.retryable, true);
    assert.equal(r.error, 'The AI answer did not pass its checks after 2 repair rounds: category: the value is not one of the allowed values');
    assert.doesNotMatch(r.error, /Bananas|Billing/);
});

test('repairRounds 0: checked, never repaired', async () => {
    const r = await run(gen({ checks: [CATEGORY_CHECK], repairRounds: 0 }), [{ category: 'Bananas' }]);
    assert.equal(calls.length, 1);
    assert.equal(r.code, 'ai_check_failed');
    assert.equal(r.error, 'The AI answer did not pass its checks: category: the value is not one of the allowed values');
});

test('a list that is not there fails with the path that names it', async () => {
    const r = await run(gen({ checks: [{ kind: 'allowedFrom', field: 'category', ref: 'vars.nothing' }], repairRounds: 0 }), [{ category: 'x' }]);
    assert.equal(r.code, 'ai_check_failed');
    assert.match(r.error, /the list of allowed values \(vars\.nothing\) is empty: nothing set it before this step/);
});

test('a text answer is checked as { text }', async () => {
    const step = { kind: 'ai_generate', prompt: 'Write a greeting', resultVar: 'g', checks: [{ kind: 'script', field: 'text', script: 'latin' }] };
    const r = await run(step, ['Привет', 'Hello there']);
    assert.equal(r.ok, true);
    assert.equal(r.result.text, 'Hello there');
    assert.equal(calls.length, 2);
    assert.equal(calls[1].args.followUp[0].content, 'Привет');
    assert.equal(r.checkReport.repaired, true);
});

test('ai_extract: the rows are checked as { rows } and a repaired answer is the one written and returned', async () => {
    const step = {
        kind: 'ai_extract', source: { kind: 'formula', expr: 'form.files' }, schema: [{ name: 'sku', type: 'string' }], resultVar: 'x',
        checks: [{ kind: 'items', field: 'rows', sameCountAs: 'form.files' }],
    };
    const r = await run(step, [{ rows: [{ sku: 'A' }] }, { rows: [{ sku: 'A' }, { sku: 'B' }] }]);
    assert.equal(r.ok, true);
    assert.deepEqual(r.result.rows, [{ sku: 'A' }, { sku: 'B' }]);
    assert.equal(r.result.count, 2);
    assert.equal(calls.length, 2);
    assert.match(calls[1].args.followUp[1].content, /rows: it must have as many items as the source list/);
});

test('ai_extract: a repair answer without rows is the "no records" failure', async () => {
    const step = {
        kind: 'ai_extract', source: { kind: 'formula', expr: 'form.files' }, schema: [{ name: 'sku', type: 'string' }],
        checks: [{ kind: 'items', field: 'rows', minItems: 2 }],
    };
    const r = await run(step, [{ rows: [{ sku: 'A' }] }, { nothing: true }]);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'ai_no_output');
});

test('a mocked step (app_run_action / app_run_tests) behaves as before: the mock is the answer, no checks run', () => {
    const res = mockStepResult(gen({ checks: [CATEGORY_CHECK], repairRounds: 3 }), { category: 'Bananas' }, { prompt: 'Classify', helpers: defaultMockHelpers() });
    assert.deepEqual(res, mockStepResult(gen(), { category: 'Bananas' }, { prompt: 'Classify', helpers: defaultMockHelpers() }));
    assert.equal(res.ok, true);
});
