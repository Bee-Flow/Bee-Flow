'use strict';

/**
 * The `code` step through the real validator (validateAction) and canonicalizer: what a builder
 * may write, what it is told when it may not, and that canonicalize keeps the source whole.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { validateAction } = require('./actions');
const { cleanStep } = require('../canonicalize/steps');
const { LIMITS } = require('../componentSpecs');

const P = 'actions.act_1.steps';
const st = (value) => ({ kind: 'static', value });

function run(steps, over = {}) {
    const errors = [];
    const warnings = [];
    const ctx = {
        pushE: (r) => errors.push(r), pushW: (r) => warnings.push(r),
        screenIds: new Set(['scr_a']), dataTables: new Map([['tbl_a', new Set(['name'])]]), aiBrowsingEnabled: false, ...over,
    };
    validateAction('act_1', { kind: 'sequence', steps }, 'actions.act_1', ctx);
    const fmt = (s) => (r) => `${s} ${r.code} @${r.path}`;
    return [...errors.map(fmt('E')), ...warnings.map(fmt('W'))];
}

const code = (extra = {}) => ({ kind: 'code', code: 'function main(inputs) { return inputs.a + 1; }', inputs: { a: st(1) }, resultVar: 'r', ...extra });

test('a valid code step passes, with records inputs and a time limit', () => {
    assert.deepEqual(run([code({ inputs: { rows: { kind: 'records', tableId: 'tbl_a' }, n: st(2) }, timeoutMs: 2000 })]), []);
});

test('code is required, a string, and at most MAX_CODE_STEP_CHARS', () => {
    assert.deepEqual(run([code({ code: undefined })]), [`E action.step_field_required @${P}[0].code`]);
    assert.deepEqual(run([code({ code: 42 })]), [`E action.step_field_invalid @${P}[0].code`]);
    assert.deepEqual(run([code({ code: `return 1;${' '.repeat(LIMITS.MAX_CODE_STEP_CHARS)}` })]), [`E action.code_too_long @${P}[0].code`]);
});

test('a syntax error, a blocked pattern and a bridge are errors to publish and warnings on a draft save', () => {
    const cases = [
        ['function main( {', 'action.code_syntax'],
        ['function main() { return eval("1"); }', 'action.code_blocked'],
        ['async function main(inputs, ctx) { return ctx.http("https://example.com"); }', 'action.code_bridge'],
    ];
    for (const [source, finding] of cases) {
        assert.deepEqual(run([code({ code: source })]), [`E ${finding} @${P}[0].code`], source);
        assert.deepEqual(run([code({ code: source })], { dataRefsAsWarnings: true }), [`W ${finding} @${P}[0].code`], source);
    }
});

test('inputs: at most MAX_CODE_STEP_INPUTS, each a name the code can read, each a valid binding', () => {
    const many = Object.fromEntries(Array.from({ length: LIMITS.MAX_CODE_STEP_INPUTS + 1 }, (_, i) => [`v${i}`, st(i)]));
    assert.deepEqual(run([code({ inputs: many })]), [`E action.code_inputs_invalid @${P}[0].inputs`]);
    assert.deepEqual(run([code({ inputs: { 'bad name': st(1) } })]), [`E action.code_inputs_invalid @${P}[0].inputs`]);
    assert.ok(run([code({ inputs: { a: { kind: 'nope' } } })]).some((f) => f.startsWith('E ') && f.includes(`${P}[0].inputs.a`)));
});

test('no resultVar is a warning, unknown fields an error, timeoutMs in 100..30000', () => {
    assert.deepEqual(run([code({ resultVar: undefined })]), [`W action.code_no_result @${P}[0]`]);
    assert.deepEqual(run([code({ url: 'https://x' })]), [`E action.step_unknown_field @${P}[0].url`]);
    assert.deepEqual(run([code({ timeoutMs: 60000 })]), [`E action.step_field_invalid @${P}[0].timeoutMs`]);
});

test('inside a loop it warns: one sandbox run per row', () => {
    const loop = { kind: 'loop', source: st([1, 2]), steps: [code()] };
    assert.deepEqual(run([loop]), [`W action.code_in_loop @${P}[0].steps`]);
});

test('canonicalize keeps the source whole, leaves absent fields absent and drops a non-string source', () => {
    const notes = [];
    const push = (c, p) => notes.push(`${c} @${p}`);
    const long = `function main() { return 1; }${'\n'.repeat(LIMITS.MAX_STRING)}`;
    assert.deepEqual(cleanStep({ kind: 'code', code: long }, 's', 0, push), { kind: 'code', code: long });
    assert.deepEqual(notes, []);
    assert.deepEqual(cleanStep({ kind: 'code', code: 7, resultVar: 'r' }, 's', 0, push), { kind: 'code', resultVar: 'r' });
    assert.deepEqual(notes, ['step.field_invalid @s.code']);
});
