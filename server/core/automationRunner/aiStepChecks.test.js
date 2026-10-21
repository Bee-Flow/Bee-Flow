/**
 * aiStepChecks: the declarative checks on an ai_step answer, evaluated on the
 * RESTORED output against RAW run data. Synthetic data only.
 *
 * Run: node --test core/automationRunner/aiStepChecks.test.js
 */

'use strict';

const { test, afterEach } = require('node:test');
const assert = require('node:assert');

const { evaluateAnswer, valuesAtPath, errorSummary } = require('./aiStepChecks');
const { resolveLists } = require('./aiStepEnum');

afterEach(() => { delete process.env.AUTOMATION_AI_CHECK_MAX_ERRORS; });

const RUN = () => ({
    steps: {
        src: { output: { cats: [{ id: 'Alpha' }, { id: 'Beta' }], total: 1234.5, rows: [{ n: 5 }, { n: 7 }, { n: 9 }], text: 'Revenue grew 12,5 % to 1.234,50' } },
        syn: { synthesised: true, output: { cats: [{ id: 'Nope' }] } },
    },
    vars: {}, secrets: {},
});

const rel = (checks = []) => ({ checks });
const run = (restored, o = {}) => evaluateAnswer({
    restored, modelOutput: o.modelOutput ?? restored, rel: o.rel || rel(), lists: o.lists || [],
    runState: o.runState || RUN(), mode: o.mode || 'live', ctx: {}, schema: o.schema,
});
const codes = (errors) => errors.map((e) => `${e.code}@${e.path}`);

// ── valuesAtPath ───────────────────────────────────────────────────────────

test('[] expands to every item and names the concrete paths', () => {
    const obj = { items: [{ category: 'a' }, { category: 'b' }], tags: ['x', 'y'], one: 'z' };
    assert.deepStrictEqual(valuesAtPath(obj, 'items[].category').map((v) => [v.path, v.value]), [['items[0].category', 'a'], ['items[1].category', 'b']]);
    assert.deepStrictEqual(valuesAtPath(obj, 'tags[]').map((v) => v.path), ['tags[0]', 'tags[1]']);
    assert.deepStrictEqual(valuesAtPath(obj, 'one').map((v) => v.value), ['z']);
    assert.deepStrictEqual(valuesAtPath(obj, 'nothing[]').map((v) => [v.path, v.value]), [['nothing', undefined]]);
    assert.deepStrictEqual(valuesAtPath(obj, 'a.b.c').map((v) => v.value), [undefined]);
    assert.deepStrictEqual(valuesAtPath(obj, 'bad[[path'), []);
    assert.deepStrictEqual(valuesAtPath({}, 'constructor').map((v) => v.value), [undefined], 'inherited keys are not answers');
});

// ── enumFrom lists and allowedFrom ─────────────────────────────────────────

const catList = (extra = {}) => resolveLists([{ field: 'category', ref: 'steps.src.output.cats', value: 'id', ...extra }], RUN(), { mode: 'live', ctx: {} });

test('a value outside the list is not_allowed; one inside passes', () => {
    assert.deepStrictEqual(run({ category: 'Alpha' }, { lists: catList() }), []);
    assert.deepStrictEqual(codes(run({ category: 'Gamma' }, { lists: catList() })), ['not_allowed@category']);
});

test('a case-insensitive match is rewritten to the list spelling', () => {
    const answer = { category: '  aLpHa ' };
    assert.deepStrictEqual(run(answer, { lists: catList() }), []);
    assert.strictEqual(answer.category, 'Alpha');
    const strict = { category: 'alpha' };
    assert.deepStrictEqual(codes(run(strict, { lists: catList({ ignoreCase: false }) })), ['not_allowed@category']);
    assert.strictEqual(strict.category, 'alpha', 'nothing is rewritten when the answer fails');
});

test('empty values fail unless allowEmpty', () => {
    for (const blank of [null, '', '  ', undefined]) {
        assert.deepStrictEqual(codes(run({ category: blank, other: 1 }, { lists: catList() })), ['missing@category']);
        assert.deepStrictEqual(run({ category: blank, other: 1 }, { lists: catList({ allowEmpty: true }) }), []);
    }
});

test('nested [] paths are checked item by item', () => {
    const lists = resolveLists([{ field: 'items[].category', ref: 'steps.src.output.cats', value: 'id' }], RUN(), { mode: 'live', ctx: {} });
    const answer = { items: [{ category: 'beta' }, { category: 'Gamma' }, { category: 'Alpha' }] };
    assert.deepStrictEqual(codes(run(answer, { lists })), ['not_allowed@items[1].category']);
    assert.strictEqual(answer.items[0].category, 'Beta');
});

test('a list that is not a list is a missing error with its own message', () => {
    const lists = resolveLists([{ field: 'category', ref: 'steps.src.output.total' }], RUN(), { mode: 'live', ctx: {} });
    const [e] = run({ category: 'x' }, { lists });
    assert.strictEqual(e.code, 'missing');
    assert.strictEqual(e.path, 'category');
    assert.strictEqual(e.message, 'the list of allowed values is empty');
});

test('allowedFrom reads its list from run data at check time', () => {
    const check = { kind: 'allowedFrom', field: 'tags[]', ref: 'steps.src.output.cats', value: 'id' };
    assert.deepStrictEqual(run({ tags: ['alpha', 'Beta'] }, { rel: rel([check]) }), []);
    assert.deepStrictEqual(codes(run({ tags: ['Alpha', 'zeta'] }, { rel: rel([check]) })), ['not_allowed@tags[1]']);
    assert.deepStrictEqual(codes(run({ tags: ['Alpha'] }, { rel: rel([{ ...check, ref: 'steps.src.output.total' }]) })), ['missing@tags[]']);
});

test('a check whose list comes from synthesised data is skipped in a dry run only', () => {
    const check = { kind: 'allowedFrom', field: 'category', ref: 'steps.syn.output.cats', value: 'id' };
    assert.deepStrictEqual(run({ category: 'Gamma' }, { rel: rel([check]), mode: 'dry_run' }), []);
    assert.deepStrictEqual(codes(run({ category: 'Gamma' }, { rel: rel([check]), mode: 'live' })), ['not_allowed@category']);
});

// ── numbersFrom ────────────────────────────────────────────────────────────

test('numbersFrom: every number in the text must be in the source', () => {
    const check = (over = {}) => ({ kind: 'numbersFrom', field: 'summary', ref: 'steps.src.output', ...over });
    assert.deepStrictEqual(run({ summary: 'Total 1.234,50, up 12,5 %.' }, { rel: rel([check()]) }), []);
    assert.deepStrictEqual(codes(run({ summary: 'Total 1.234,50, up 14 %.' }, { rel: rel([check()]) })), ['number_not_in_source@summary']);
    assert.deepStrictEqual(run({ summary: 'About 1236' }, { rel: rel([check({ tolerance: 2 })]) }), []);
    assert.deepStrictEqual(run({ summary: 'Chapter 2 and 3' }, { rel: rel([check({ ignoreUpTo: 10 })]) }), []);
    assert.deepStrictEqual(codes(run({ summary: 'Chapter 2 and 3' }, { rel: rel([check()]) })), ['number_not_in_source@summary']);
});

test('numbersFrom walks [] paths and checks JSON numbers directly', () => {
    const check = { kind: 'numbersFrom', field: 'rows[].value', ref: 'steps.src.output.rows' };
    assert.deepStrictEqual(codes(run({ rows: [{ value: 5 }, { value: 6 }, { value: 'is 9' }] }, { rel: rel([check]) })), ['number_not_in_source@rows[1].value']);
    assert.deepStrictEqual(run({ rows: [{ other: 'x' }] }, { rel: rel([check]) }), [], 'no text, nothing to verify');
});

// ── script ─────────────────────────────────────────────────────────────────

test('script: the letters must be in the script, placeholders and digits do not count', () => {
    const check = (over = {}) => ({ kind: 'script', field: 'title', script: 'latin', ...over });
    assert.deepStrictEqual(run({ title: 'Quarterly summary, 2025 [person_1]' }, { rel: rel([check()]) }), []);
    assert.deepStrictEqual(codes(run({ title: 'Quarterly сводка' }, { rel: rel([check()]) })), ['wrong_script@title']);
    assert.deepStrictEqual(run({ title: 'Quarterly сводка' }, { rel: rel([check({ minRatio: 0.5 })]) }), []);
    assert.deepStrictEqual(run({ title: '1234 - 5 %' }, { rel: rel([check()]) }), [], 'no letters passes');
    assert.deepStrictEqual(run({ title: 'сводка' }, { rel: rel([check({ script: 'cyrillic' })]) }), []);
    assert.deepStrictEqual(run({ title: 'こんにちは世界ー' }, { rel: rel([check({ script: 'japanese' })]) }), []);
    assert.deepStrictEqual(codes(run({ title: 'こんにちは' }, { rel: rel([check({ script: 'han' })]) })), ['wrong_script@title']);
});

test('script reads text anywhere inside a list or record', () => {
    const check = { kind: 'script', field: 'body', script: 'latin' };
    assert.deepStrictEqual(codes(run({ body: { a: ['fine', 'сводка'] } }, { rel: rel([check]) })), ['wrong_script@body']);
});

// ── items ──────────────────────────────────────────────────────────────────

test('items: list, min, max and same count as a source list', () => {
    const check = (over = {}) => ({ kind: 'items', field: 'rows', ...over });
    assert.deepStrictEqual(codes(run({ rows: 'no' }, { rel: rel([check()]) })), ['not_a_list@rows']);
    assert.deepStrictEqual(codes(run({}, { rel: rel([check()]) })), ['not_a_list@rows']);
    assert.deepStrictEqual(codes(run({ rows: [1] }, { rel: rel([check({ minItems: 2 })]) })), ['too_few_items@rows']);
    assert.deepStrictEqual(codes(run({ rows: [1, 2, 3] }, { rel: rel([check({ maxItems: 2 })]) })), ['too_many_items@rows']);
    assert.deepStrictEqual(run({ rows: [1, 2, 3] }, { rel: rel([check({ sameCountAs: 'steps.src.output.rows' })]) }), []);
    assert.deepStrictEqual(codes(run({ rows: [1, 2] }, { rel: rel([check({ sameCountAs: 'steps.src.output.rows' })]) })), ['count_mismatch@rows']);
    assert.deepStrictEqual(run({ rows: [1, 2] }, { rel: rel([check({ sameCountAs: 'steps.syn.output.cats' })]), mode: 'dry_run' }), [], 'synthetic count skipped in a dry run');
});

// ── schema_type and no_answer ──────────────────────────────────────────────

const SCHEMA = {
    type: 'object',
    properties: { name: { type: 'string' }, n: { type: 'integer' }, ok: { type: 'boolean' }, list: { type: 'array' }, rec: { type: 'object' }, maybe: { type: ['string', 'null'] } },
    required: ['name'],
};

test('schema_type: declared types and required fields', () => {
    assert.deepStrictEqual(run({ name: 'a', n: 3, ok: true, list: [], rec: {}, maybe: null }, { schema: SCHEMA }), []);
    assert.deepStrictEqual(codes(run({ n: 3 }, { schema: SCHEMA })), ['schema_type@name']);
    assert.deepStrictEqual(codes(run({ name: 1, n: 2.5, ok: 'yes', list: {}, rec: [] }, { schema: SCHEMA })),
        ['schema_type@name', 'schema_type@n', 'schema_type@ok', 'schema_type@list', 'schema_type@rec']);
});

test('a null, empty or non-object answer is no_answer', () => {
    for (const bad of [null, undefined, '']) assert.deepStrictEqual(codes(run(bad, { schema: SCHEMA })), ['no_answer@']);
    assert.deepStrictEqual(codes(run('just text', { schema: SCHEMA })), ['no_answer@']);
});

// ── messages and model values ──────────────────────────────────────────────

test('modelValue is what the MODEL wrote; the message holds the rule and no data', () => {
    const modelOutput = { category: '[person_7]', note: 'x' };
    const restored = { category: 'Jan de Vries', note: 'x' };
    const [e] = run(restored, { modelOutput, lists: catList() });
    assert.strictEqual(e.code, 'not_allowed');
    assert.strictEqual(e.modelValue, '[person_7]');
    assert.doesNotMatch(e.message, /Jan|person_7|Alpha|Beta/);
    assert.match(e.message, /allowed values/);
});

test('modelValue is truncated to 200 characters; a missing value has none', () => {
    const long = 'z'.repeat(500);
    assert.strictEqual(run({ category: long }, { lists: catList() })[0].modelValue.length, 200);
    assert.strictEqual(run({ category: '' }, { lists: catList() })[0].modelValue, '');
});

test('errors are capped (AUTOMATION_AI_CHECK_MAX_ERRORS) and summarised without values', () => {
    process.env.AUTOMATION_AI_CHECK_MAX_ERRORS = '3';
    const lists = resolveLists([{ field: 'tags[]', ref: 'steps.src.output.cats', value: 'id' }], RUN(), { mode: 'live', ctx: {} });
    const errors = run({ tags: Array.from({ length: 10 }, (_, i) => `bad${i}`) }, { lists });
    assert.strictEqual(errors.length, 3);
    process.env.AUTOMATION_AI_CHECK_MAX_ERRORS = '0';
    const all = run({ tags: Array.from({ length: 10 }, (_, i) => `bad${i}`) }, { lists });
    assert.strictEqual(all.length, 10);
    const summary = errorSummary(all);
    assert.strictEqual(summary.split('; ').length, 5, 'at most five items');
    assert.match(summary, /^tags\[0\]: the value is not one of the allowed values/);
    assert.doesNotMatch(summary, /bad\d/);
});
