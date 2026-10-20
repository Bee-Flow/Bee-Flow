/**
 * The specification of an ai_step's reliability settings: field paths, the
 * lenient reader the runner uses, the strict one the builder uses, and the
 * problems the validator shows.
 *
 * Run: cd server && node --test core/automationModel/aiStepReliability.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const R = require('./aiStepReliability');

const ENUM = { field: 'category', ref: 'steps.s1.output.rows', value: 'name' };

// ── constants ────────────────────────────────────────────────────────────────

test('the limits and vocabularies are the contract', () => {
    assert.strictEqual(R.AI_STEP_DEFAULT_TEMPERATURE, 0.2);
    assert.strictEqual(R.AI_STEP_TEMPERATURE_MIN, 0);
    assert.strictEqual(R.AI_STEP_TEMPERATURE_MAX, 2);
    assert.strictEqual(R.MAX_ENUM_FROM, 10);
    assert.strictEqual(R.MAX_CHECKS, 20);
    assert.strictEqual(R.MAX_FALLBACK_FIELDS, 50);
    assert.strictEqual(R.FOREACH_CONCURRENCY_MAX, 1000);
    assert.deepStrictEqual([...R.CHECK_KINDS], ['allowedFrom', 'numbersFrom', 'script', 'items']);
    assert.deepStrictEqual([...R.RUN_PATH_ROOTS], ['trigger', 'steps', 'vars', 'loop']);
    assert.deepStrictEqual([...R.SCRIPTS], ['latin', 'cyrillic', 'greek', 'arabic', 'hebrew', 'han', 'japanese', 'hangul', 'devanagari', 'thai']);
});

test('the module is pure: it requires nothing outside core/automationModel and shared/expr', () => {
    for (const file of ['aiStepReliability.js', 'aiStepReliabilitySpec.js', 'aiStepReliabilityProblems.js']) {
        const source = fs.readFileSync(path.join(__dirname, file), 'utf8');
        for (const m of source.matchAll(/require\('([^']+)'\)/g)) {
            assert.ok(m[1].startsWith('./') || /^\.\.\/\.\.\/shared\/expr\//.test(m[1]), `${file} requires ${m[1]}`);
        }
    }
});

// ── parseFieldPath ───────────────────────────────────────────────────────────

test('parseFieldPath reads names, list suffixes and nested parts', () => {
    assert.deepStrictEqual(R.parseFieldPath('category'), { segments: [{ name: 'category', each: false }] });
    assert.deepStrictEqual(R.parseFieldPath('tags[]'), { segments: [{ name: 'tags', each: true }] });
    assert.deepStrictEqual(R.parseFieldPath('items[].category'), {
        segments: [{ name: 'items', each: true }, { name: 'category', each: false }],
    });
    assert.strictEqual(R.parseFieldPath('a.b.c.d').segments.length, 4);
    assert.ok(R.parseFieldPath('Total (EUR)'), 'a name with spaces and symbols is a name');
    assert.ok(R.parseFieldPath('x'.repeat(100)));
});

test('parseFieldPath refuses everything that is not a field path', () => {
    const bad = [
        '', null, undefined, 42, {}, [], 'a.b.c.d.e', 'a..b', '.a', 'a.', '[]', 'a[]b', 'a[0]', 'a[', 'a]', 'a[][]',
        'x'.repeat(101), `${'a'.repeat(60)}.${'b'.repeat(60)}.${'c'.repeat(60)}.${'d'.repeat(30)}`,
    ];
    for (const p of bad) assert.strictEqual(R.parseFieldPath(p), null, JSON.stringify(p));
});

// ── normalizeAiStepReliability ───────────────────────────────────────────────

test('a plain step reads as defaults and is not active', () => {
    for (const step of [{}, null, undefined, 'x', { type: 'ai_step', prompt: 'p' }]) {
        assert.deepStrictEqual(R.normalizeAiStepReliability(step), {
            temperature: 0.2, enumFrom: [], checks: [], fallback: { kind: 'fail' }, active: false,
        });
    }
});

test('defaults are filled on every entry', () => {
    const n = R.normalizeAiStepReliability({
        enumFrom: [{ field: 'category', ref: 'steps.s1.output.rows' }],
        checks: [
            { kind: 'allowedFrom', field: 'category', ref: 'steps.s1.output.rows', value: 'name' },
            { kind: 'numbersFrom', field: 'summary', ref: 'steps.s2.output.totals' },
            { kind: 'script', field: 'summary', script: 'latin' },
            { kind: 'items', field: 'tags', maxItems: 3 },
        ],
    });
    assert.deepStrictEqual(n.enumFrom, [{ field: 'category', ref: 'steps.s1.output.rows', ignoreCase: true, allowEmpty: false }]);
    assert.deepStrictEqual(n.checks, [
        { kind: 'allowedFrom', field: 'category', ref: 'steps.s1.output.rows', value: 'name', ignoreCase: true, allowEmpty: false },
        { kind: 'numbersFrom', field: 'summary', ref: 'steps.s2.output.totals', tolerance: 0, ignoreUpTo: 0, percent: true, ignoreDates: true },
        { kind: 'script', field: 'summary', script: 'latin', minRatio: 1 },
        { kind: 'items', field: 'tags', maxItems: 3 },
    ]);
    assert.strictEqual(n.active, true);
});

test('given values survive the defaults', () => {
    const n = R.normalizeAiStepReliability({
        temperature: 0.7,
        enumFrom: [{ ...ENUM, ignoreCase: false, allowEmpty: true }],
        checks: [{ kind: 'numbersFrom', field: 's', ref: 'steps.a.output.t', tolerance: 0.5, ignoreUpTo: 10, percent: false, ignoreDates: false }],
    });
    assert.strictEqual(n.temperature, 0.7);
    assert.strictEqual(n.enumFrom[0].ignoreCase, false);
    assert.strictEqual(n.enumFrom[0].allowEmpty, true);
    assert.deepStrictEqual(n.checks[0], { kind: 'numbersFrom', field: 's', ref: 'steps.a.output.t', tolerance: 0.5, ignoreUpTo: 10, percent: false, ignoreDates: false });
});

test('the lenient reader drops what it cannot read and keeps the rest', () => {
    const n = R.normalizeAiStepReliability({
        enumFrom: [
            null, 'category', { field: 'category' }, { ref: 'steps.s1.output.rows' },
            { field: 'a[', ref: 'steps.s1.output.rows' },
            { field: 'category', ref: 'secrets.key' },
            { field: 'category', ref: 'steps.s1.{{x}}' },
            { field: 'category', ref: 'item.rows' },
            { field: 'category', ref: 'steps.s1.output.rows', ignoreCase: 'yes' },
            ENUM,
        ],
        checks: [
            7, { kind: 'nope', field: 'a' }, { kind: 'script', field: 'a', script: 'klingon' },
            { kind: 'script', field: 'a', script: 'latin', minRatio: 3 },
            { kind: 'numbersFrom', field: 'a', ref: 'steps.s1.output.t', tolerance: -1 },
            { kind: 'numbersFrom', field: 'a', ref: 'steps.s1.output.t', ignoreUpTo: 5000 },
            { kind: 'items', field: 'a' },
            { kind: 'items', field: 'a', minItems: 5, maxItems: 1 },
            { kind: 'allowedFrom', field: 'a' },
            { kind: 'script', field: 'ok', script: 'greek' },
        ],
    });
    assert.deepStrictEqual(n.enumFrom.map((e) => e.field), ['category']);
    assert.deepStrictEqual(n.enumFrom[0].value, 'name');
    assert.deepStrictEqual(n.checks.map((c) => c.field), ['ok']);
});

test('lists are capped, temperature is clamped, strings and NaN are not numbers', () => {
    const enumFrom = Array.from({ length: 15 }, (_, i) => ({ field: `f${i}`, ref: 'steps.s1.output.rows' }));
    const checks = Array.from({ length: 30 }, () => ({ kind: 'script', field: 'a', script: 'latin' }));
    const n = R.normalizeAiStepReliability({ enumFrom, checks });
    assert.strictEqual(n.enumFrom.length, 10);
    assert.strictEqual(n.checks.length, 20);
    assert.strictEqual(R.normalizeAiStepReliability({ temperature: 5 }).temperature, 2);
    assert.strictEqual(R.normalizeAiStepReliability({ temperature: -1 }).temperature, 0);
    assert.strictEqual(R.normalizeAiStepReliability({ temperature: 0 }).temperature, 0);
    for (const t of ['0.9', NaN, Infinity, null, {}]) assert.strictEqual(R.normalizeAiStepReliability({ temperature: t }).temperature, 0.2, String(t));
});

test('a reference or item path is trimmed; an empty item path is "not given"', () => {
    const n = R.normalizeAiStepReliability({ enumFrom: [{ field: 'c', ref: '  steps.s1.output.rows ', value: '' }] });
    assert.strictEqual(n.enumFrom[0].ref, 'steps.s1.output.rows');
    assert.ok(!('value' in n.enumFrom[0]));
});

test('active: a list, a check, or a valid fallback; fallback defaults to fail', () => {
    assert.strictEqual(R.normalizeAiStepReliability({ enumFrom: [ENUM] }).active, true);
    assert.strictEqual(R.normalizeAiStepReliability({ checks: [{ kind: 'script', field: 'a', script: 'latin' }] }).active, true);
    assert.strictEqual(R.normalizeAiStepReliability({ fallback: { kind: 'fail' } }).active, true);
    const fb = R.normalizeAiStepReliability({ fallback: { kind: 'value', fields: { category: { kind: 'literal', value: 'Other' } } } });
    assert.strictEqual(fb.active, true);
    assert.deepStrictEqual(fb.fallback, { kind: 'value', fields: { category: { kind: 'literal', value: 'Other' } } });
    // not usable: nothing active, still the default
    for (const bad of [{ kind: 'value' }, { kind: 'value', fields: {} }, { kind: 'maybe' }, 'fail', 3, { kind: 'value', fields: { a: 'Other' } }, { kind: 'value', fields: { 'a.b': { kind: 'literal', value: 1 } } }]) {
        const n = R.normalizeAiStepReliability({ fallback: bad });
        assert.deepStrictEqual(n.fallback, { kind: 'fail' }, JSON.stringify(bad));
        assert.strictEqual(n.active, false, JSON.stringify(bad));
    }
});

test('a fallback keeps its good fields and drops the malformed ones; it is capped', () => {
    const fields = { good: { kind: 'literal', value: 1 }, bad: 'x', 'a.b': { kind: 'literal', value: 2 } };
    assert.deepStrictEqual(R.normalizeAiStepReliability({ fallback: { kind: 'value', fields } }).fallback.fields, { good: { kind: 'literal', value: 1 } });
    const many = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`f${i}`, { kind: 'literal', value: i }]));
    assert.strictEqual(Object.keys(R.normalizeAiStepReliability({ fallback: { kind: 'value', fields: many } }).fallback.fields).length, 50);
});

test('the normalised view does not alias the step', () => {
    const step = { fallback: { kind: 'value', fields: { a: { kind: 'literal', value: { n: 1 } } } }, enumFrom: [ENUM] };
    const n = R.normalizeAiStepReliability(step);
    n.fallback.fields.a.value.n = 99;
    n.enumFrom[0].ref = 'steps.x.y';
    assert.strictEqual(step.fallback.fields.a.value.n, 1);
    assert.strictEqual(step.enumFrom[0].ref, 'steps.s1.output.rows');
});

// ── sanitizeAiStepReliabilityArgs ────────────────────────────────────────────

test('sanitize writes only the keys that were given', () => {
    assert.deepStrictEqual(R.sanitizeAiStepReliabilityArgs({}), { value: {} });
    assert.deepStrictEqual(R.sanitizeAiStepReliabilityArgs(undefined), { value: {} });
    assert.deepStrictEqual(R.sanitizeAiStepReliabilityArgs({ prompt: 'x', temperature: null, enumFrom: null, checks: [], fallback: undefined }), { value: {} });
    assert.deepStrictEqual(R.sanitizeAiStepReliabilityArgs({ enumFrom: [ENUM] }), { value: { enumFrom: [ENUM] } });
});

test('sanitize rounds the temperature to two decimals and accepts the ends', () => {
    assert.strictEqual(R.sanitizeAiStepReliabilityArgs({ temperature: 0.3333 }).value.temperature, 0.33);
    assert.strictEqual(R.sanitizeAiStepReliabilityArgs({ temperature: 0 }).value.temperature, 0);
    assert.strictEqual(R.sanitizeAiStepReliabilityArgs({ temperature: 2 }).value.temperature, 2);
});

test('sanitize keeps given booleans and numbers exactly, and trims paths', () => {
    const r = R.sanitizeAiStepReliabilityArgs({
        enumFrom: [{ field: 'c', ref: ' steps.s1.output.rows ', ignoreCase: false, allowEmpty: true }],
        checks: [{ kind: 'numbersFrom', field: 's', ref: 'steps.a.output.t', tolerance: 0.5, ignoreUpTo: 3, percent: false }],
    });
    assert.deepStrictEqual(r.value.enumFrom, [{ field: 'c', ref: 'steps.s1.output.rows', ignoreCase: false, allowEmpty: true }]);
    assert.deepStrictEqual(r.value.checks, [{ kind: 'numbersFrom', field: 's', ref: 'steps.a.output.t', tolerance: 0.5, ignoreUpTo: 3, percent: false }]);
});

test('sanitize does not alias its input', () => {
    const fields = { a: { kind: 'literal', value: { n: 1 } } };
    const r = R.sanitizeAiStepReliabilityArgs({ fallback: { kind: 'value', fields } });
    r.value.fallback.fields.a.value.n = 5;
    assert.strictEqual(fields.a.value.n, 1);
});

/** One refused call: an error sentence that names the entry, and a hint. */
function refused(args, mention) {
    const r = R.sanitizeAiStepReliabilityArgs(args);
    assert.ok(r.error, `${JSON.stringify(args)} must be refused`);
    assert.ok(r._fixHint, 'carries a hint');
    assert.ok(!('value' in r));
    for (const m of [].concat(mention)) assert.match(r.error, new RegExp(m.replace(/[[\].]/g, '\\$&')), `${r.error} must mention ${m}`);
    return r;
}

test('sanitize: every refusal names the entry and what is allowed', () => {
    refused({ temperature: 3 }, ['temperature', '0 to 2']);
    refused({ temperature: 'hot' }, 'temperature');
    refused({ enumFrom: 'category' }, ['enumFrom', '10']);
    refused({ enumFrom: [ENUM, { field: 'x' }] }, 'enumFrom[1].ref');
    refused({ enumFrom: [{ ref: 'steps.s1.output.rows' }] }, 'enumFrom[0].field');
    refused({ enumFrom: [{ field: 'a[', ref: 'steps.s1.output.rows' }] }, 'enumFrom[0].field');
    refused({ enumFrom: [{ field: 'c', ref: 'secrets.k' }] }, ['enumFrom[0].ref', 'secrets']);
    refused({ enumFrom: [{ field: 'c', ref: 'rows' }] }, ['enumFrom[0].ref', 'trigger, steps, vars, loop']);
    refused({ enumFrom: [{ field: 'c', ref: '{{steps.s1.output.rows}}' }] }, ['enumFrom[0].ref', '{{ }}']);
    refused({ enumFrom: [{ ...ENUM, ignoreCase: 'no' }] }, 'enumFrom[0].ignoreCase');
    refused({ enumFrom: [{ ...ENUM, label: 'x' }] }, ['enumFrom[0]', '"label"']);
    refused({ enumFrom: Array.from({ length: 11 }, () => ENUM) }, ['enumFrom', 'at most 10']);
    refused({ checks: [{ field: 'a' }] }, ['checks[0].kind', 'allowedFrom, numbersFrom, script, items']);
    refused({ checks: [{ kind: 'regex', field: 'a' }] }, ['checks[0].kind', '"regex"']);
    refused({ checks: [{ kind: 'script', script: 'latin' }] }, 'checks[0].field');
    refused({ checks: [{ kind: 'allowedFrom', field: 'a' }] }, 'checks[0].ref');
    refused({ checks: [{ kind: 'numbersFrom', field: 'a', ref: 'steps.s1.output.t', tolerance: -1 }] }, 'checks[0].tolerance');
    refused({ checks: [{ kind: 'numbersFrom', field: 'a', ref: 'steps.s1.output.t', ignoreUpTo: 1001 }] }, ['checks[0].ignoreUpTo', '0 to 1000']);
    refused({ checks: [{ kind: 'script', field: 'a', script: 'klingon' }] }, ['checks[0].script', 'latin, cyrillic']);
    refused({ checks: [{ kind: 'script', field: 'a', script: 'latin', minRatio: 1.5 }] }, ['checks[0].minRatio', '0 to 1']);
    refused({ checks: [{ kind: 'items', field: 'a' }] }, ['checks[0]', 'minItems, maxItems or sameCountAs']);
    refused({ checks: [{ kind: 'items', field: 'a', minItems: 3, maxItems: 1 }] }, 'minItems');
    refused({ checks: [{ kind: 'items', field: 'a', minItems: 1.5 }] }, 'checks[0].minItems');
    refused({ checks: [{ kind: 'items', field: 'a', sameCountAs: 'secrets.x' }] }, 'checks[0].sameCountAs');
    refused({ checks: [{ kind: 'script', field: 'a', script: 'latin', ref: 'steps.s1.output.t' }] }, ['checks[0]', '"ref"']);
    refused({ checks: Array.from({ length: 21 }, () => ({ kind: 'script', field: 'a', script: 'latin' })) }, ['checks', 'at most 20']);
    refused({ fallback: 'fail' }, 'fallback');
    refused({ fallback: { kind: 'maybe' } }, ['fallback.kind', '"fail" or "value"']);
    refused({ fallback: { kind: 'value' } }, 'fallback.fields');
    refused({ fallback: { kind: 'value', fields: {} } }, 'fallback.fields');
    refused({ fallback: { kind: 'value', fields: { a: 'Other' } } }, ['fallback.fields.a', 'binding']);
    refused({ fallback: { kind: 'value', fields: { 'a.b': { kind: 'literal', value: 1 } } } }, 'field name "a.b"');
    refused({ fallback: { kind: 'fail', fields: { a: { kind: 'literal', value: 1 } } } }, 'fallback.fields');
});

test('sanitize: a refusal never echoes data values, only the setting', () => {
    const r = R.sanitizeAiStepReliabilityArgs({ checks: [{ kind: 'script', field: 'summary', script: 'latin', minRatio: 'a very long private sentence' }] });
    assert.ok(r.error);
    assert.ok(!/private sentence/.test(r.error));
});

// ── reliabilityProblems ──────────────────────────────────────────────────────

const problemCodes = (step) => R.reliabilityProblems(step).map((p) => `${p.severity}:${p.code}@${p.path}`);

test('a valid configuration has no problems, and neither does a plain step', () => {
    assert.deepStrictEqual(R.reliabilityProblems({}), []);
    assert.deepStrictEqual(R.reliabilityProblems(null), []);
    assert.deepStrictEqual(R.reliabilityProblems({
        temperature: 0.2,
        enumFrom: [ENUM],
        checks: [{ kind: 'items', field: 'tags', sameCountAs: 'steps.s1.output.rows' }, { kind: 'script', field: 'a', script: 'han', minRatio: 0.5 }],
        fallback: { kind: 'value', fields: { category: { kind: 'literal', value: 'Other' } } },
    }), []);
});

test('problems carry code, path (relative to the step), severity, message and hint', () => {
    const problems = R.reliabilityProblems({
        temperature: 9,
        enumFrom: [{ field: 'a[', ref: 'secrets.k' }],
        checks: [{ kind: 'script', field: 'a', script: 'latin' }, { kind: 'items', field: 'a' }, { kind: 'allowedFrom', field: 'a', ref: 'x' }],
        fallback: { kind: 'value', fields: {} },
    });
    for (const p of problems) {
        assert.ok(p.code.startsWith('ai_step.'), p.code);
        assert.ok(['error', 'warning'].includes(p.severity));
        assert.ok(p.message && p.hint && p.path);
        assert.ok(!/\bat .*\.js:\d+/.test(p.message), 'no stack trace');
    }
    assert.deepStrictEqual(problemCodes({
        temperature: 9,
        enumFrom: [{ field: 'a[', ref: 'secrets.k' }],
        checks: [{ kind: 'script', field: 'a', script: 'latin' }, { kind: 'items', field: 'a' }, { kind: 'allowedFrom', field: 'a', ref: 'x' }],
        fallback: { kind: 'value', fields: {} },
    }), [
        'error:ai_step.temperature_range@temperature',
        'error:ai_step.enum_from_invalid@enumFrom[0].field',
        'error:ai_step.ref_root_invalid@enumFrom[0].ref',
        'error:ai_step.check_invalid@checks[1]',
        'error:ai_step.ref_root_invalid@checks[2].ref',
        'error:ai_step.fallback_invalid@fallback.fields',
    ]);
});

test('problem codes: warnings for what is stored and read by nothing', () => {
    assert.deepStrictEqual(problemCodes({ enumFrom: [{ ...ENUM, extra: 1 }] }), ['warning:ai_step.enum_from_key_ignored@enumFrom[0]']);
    assert.deepStrictEqual(problemCodes({ checks: [{ kind: 'script', field: 'a', script: 'latin', ref: 'steps.s.output.x' }] }), ['warning:ai_step.check_key_ignored@checks[0]']);
    assert.deepStrictEqual(problemCodes({ fallback: { kind: 'fail', fields: { a: { kind: 'literal', value: 1 } } } }), ['warning:ai_step.fallback_key_ignored@fallback.fields']);
    assert.deepStrictEqual(problemCodes({ enumFrom: [ENUM, { ...ENUM, ref: 'steps.s1.output.other' }] }), ['warning:ai_step.enum_from_duplicate_field@enumFrom[1].field']);
});

test('problems: not a list, not an object, and counts over the limits', () => {
    assert.deepStrictEqual(problemCodes({ enumFrom: 'x' }), ['error:ai_step.enum_from_invalid@enumFrom']);
    assert.deepStrictEqual(problemCodes({ checks: {} }), ['error:ai_step.check_invalid@checks']);
    assert.deepStrictEqual(problemCodes({ enumFrom: [3] }), ['error:ai_step.enum_from_invalid@enumFrom[0]']);
    assert.deepStrictEqual(problemCodes({ checks: [3] }), ['error:ai_step.check_invalid@checks[0]']);
    assert.deepStrictEqual(problemCodes({ fallback: [] }), ['error:ai_step.fallback_invalid@fallback']);
    const tooMany = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`f${i}`, { kind: 'literal', value: i }]));
    assert.ok(problemCodes({ fallback: { kind: 'value', fields: tooMany } }).includes('error:ai_step.fallback_invalid@fallback.fields'));
});

test('null and undefined settings are "not set", not problems', () => {
    assert.deepStrictEqual(R.reliabilityProblems({ temperature: null, enumFrom: null, checks: undefined, fallback: null }), []);
});

// ── aiStepCanCallTools ───────────────────────────────────────────────────────

test('a step may call tools when it allows them, lists some, or its agent may use its own', () => {
    assert.strictEqual(R.aiStepCanCallTools({}), false);
    assert.strictEqual(R.aiStepCanCallTools({ allowTools: false, tools: [] }), false);
    assert.strictEqual(R.aiStepCanCallTools({ allowTools: true }), true);
    assert.strictEqual(R.aiStepCanCallTools({ tools: ['gmail_search'] }), true);
    assert.strictEqual(R.aiStepCanCallTools({ agentId: 'agt_1', agentPermissions: { useTools: true } }), true);
    assert.strictEqual(R.aiStepCanCallTools({ agentId: 'agt_1', agentPermissions: { useTools: false } }), false);
    assert.strictEqual(R.aiStepCanCallTools({ agentId: '  ', agentPermissions: { useTools: true } }), false);
    assert.strictEqual(R.aiStepCanCallTools({ agentPermissions: { useTools: true } }), false, 'no agent, nothing to use');
    assert.strictEqual(R.aiStepCanCallTools(null), false);
    assert.strictEqual(R.aiStepCanCallTools({ skillIds: ['s1'] }), true, 'a skill counts, as it does at run time');
    assert.strictEqual(R.aiStepCanCallTools({ skillIds: [] }), false);
    assert.strictEqual(R.aiStepCanCallTools({ agentId: 'agt_1', agentPermissions: { startAutomations: true } }), true);
    assert.strictEqual(R.aiStepCanCallTools({ agentPermissions: { startAutomations: true } }), false, 'no agent, nothing to start from');
});
