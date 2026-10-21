/**
 * Builder tools: the reliability settings of an ai_step (temperature,
 * enumFrom, checks, fallback, askOnce) and forEach.concurrency.
 *
 * The rules that matter:
 *   - a plain AI step is byte-identical to what it was: no new keys unless a
 *     setting was given;
 *   - a refused setting names the entry and the allowed values, and nothing is
 *     added;
 *   - a patch lands on exactly the object an add would have produced;
 *   - the run data the settings read is checked against the draft like an input.
 *
 * Run: cd server && node --test automation/builderTools/stepBuilders/aiStepReliability.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { applyAddAi } = require('./index');
const { applyUpdateStep } = require('../stepEditing');
const { sanitizeForEach } = require('../bindings');
const { TOOL_SCHEMAS } = require('../../builderTools');
const { projectToolSchemas } = require('../schemaProjection');
const { validateDefinition } = require('../../validate');

const SCHEMA = { type: 'object', properties: { category: { type: 'string' }, summary: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } } };

const draft = () => ({
    trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
    steps: [{ id: 's1', type: 'integration_action', tool: 'gmail_search', inputs: {} }],
    edges: [{ from: 'trg', to: 's1' }],
});

const SETTINGS = {
    temperature: 0.4,
    enumFrom: [{ field: 'category', ref: 'steps.s1.output.rows', value: 'name' }],
    checks: [
        { kind: 'numbersFrom', field: 'summary', ref: 'steps.s1.output.totals', tolerance: 0.01 },
        { kind: 'items', field: 'tags', minItems: 1, maxItems: 5 },
    ],
    fallback: { kind: 'value', fields: { category: { kind: 'literal', value: 'Other' } } },
    askOnce: { ttlSeconds: 120, acrossRuns: true },
};

const add = (extra = {}) => applyAddAi(draft(), { prompt: 'Pick the category', outputSchema: SCHEMA, ...extra });

// ── a plain step is unchanged ────────────────────────────────────────────────

test('a plain ai_step gains no key', () => {
    const { added } = add();
    for (const k of ['temperature', 'enumFrom', 'checks', 'fallback', 'askOnce']) assert.ok(!(k in added), k);
});

test('nothing, null or an empty list adds nothing', () => {
    const { added } = add({ temperature: null, enumFrom: [], checks: null, fallback: undefined, askOnce: false });
    for (const k of ['temperature', 'enumFrom', 'checks', 'fallback', 'askOnce']) assert.ok(!(k in added), k);
});

// ── add ──────────────────────────────────────────────────────────────────────

test('every setting is written as given', () => {
    const { added, error } = add(SETTINGS);
    assert.ifError(error);
    assert.strictEqual(added.temperature, 0.4);
    assert.deepStrictEqual(added.enumFrom, SETTINGS.enumFrom);
    assert.deepStrictEqual(added.checks, SETTINGS.checks);
    assert.deepStrictEqual(added.fallback, SETTINGS.fallback);
    assert.deepStrictEqual(added.askOnce, { acrossRuns: true, ttlSeconds: 120 });
});

test('the temperature is rounded to two decimals', () => {
    assert.strictEqual(add({ temperature: 0.3333 }).added.temperature, 0.33);
    assert.strictEqual(add({ temperature: 0 }).added.temperature, 0);
});

test('askOnce goes through the same normaliser as an app action', () => {
    assert.strictEqual(add({ askOnce: true }).added.askOnce, true);
    assert.strictEqual(add({ askOnce: {} }).added.askOnce, true, 'an object with nothing recognised still means "once"');
    assert.deepStrictEqual(add({ askOnce: { ttlSeconds: 30, junk: 1 } }).added.askOnce, { ttlSeconds: 30 });
    assert.ok(!('askOnce' in add({ askOnce: 'yes' }).added));
});

test('a bare fallback value is wrapped as a literal, like an input', () => {
    const { added, error } = add({ fallback: { kind: 'value', fields: { category: 'Other', rank: 3 } } });
    assert.ifError(error);
    assert.deepStrictEqual(added.fallback.fields, {
        category: { kind: 'literal', value: 'Other' },
        rank: { kind: 'literal', value: 3 },
    });
});

test('a fallback value is checked like an input: a root that does not exist is refused', () => {
    const r = add({ fallback: { kind: 'value', fields: { category: { kind: 'ref', path: 'foo.bar' } } } });
    assert.ok(r.error);
    assert.match(r.error, /fallback\.fields\.category/);
    assert.equal(r.added, undefined);
});

test('a list the settings read gets the reference check an input gets, named by its field', () => {
    const missing = 'steps.s1.output.results[*].zzz';
    const r = add({
        enumFrom: [{ field: 'category', ref: missing }],
        checks: [{ kind: 'allowedFrom', field: 'category', ref: missing }, { kind: 'items', field: 'tags', sameCountAs: missing }],
    });
    assert.ifError(r.error);
    const w = r._warnings.join('\n');
    assert.match(w, /enumFrom\[0\]\.ref/);
    assert.match(w, /checks\[0\]\.ref/);
    assert.match(w, /checks\[1\]\.sameCountAs/);
});

test('a loop variable nothing binds is refused; one the forEach binds is kept', () => {
    const unbound = add({ enumFrom: [{ field: 'category', ref: 'loop.batch.options' }] });
    assert.ok(unbound.error);
    assert.match(unbound.error, /loop\.batch/);
    const bound = add({
        forEach: { overRef: 'steps.s1.output.results', itemVar: 'batch' },
        enumFrom: [{ field: 'category', ref: 'loop.batch.options' }],
    });
    assert.ifError(bound.error);
    assert.strictEqual(bound.added.enumFrom[0].ref, 'loop.batch.options');
});

test('notes about repaired paths ride along as warnings', () => {
    const r = add({ enumFrom: [{ field: 'category', ref: 'steps.s1.output.rows' }] });
    assert.ok(Array.isArray(r._warnings) && r._warnings.some((w) => /enumFrom\[0\]\.ref/.test(w)), JSON.stringify(r._warnings));
});

// ── refusals ─────────────────────────────────────────────────────────────────

test('an invalid setting is refused with a hint, and the step is not added', () => {
    const cases = [
        [{ temperature: 5 }, /temperature/],
        [{ enumFrom: [{ field: 'category' }] }, /enumFrom\[0\]\.ref/],
        [{ enumFrom: [{ field: 'category', ref: 'secrets.key' }] }, /secrets/],
        [{ checks: [{ kind: 'script', field: 'summary', script: 'klingon' }] }, /latin, cyrillic/],
        [{ checks: [{ kind: 'regex', field: 'summary' }] }, /allowedFrom, numbersFrom, script, items/],
        [{ checks: [{ kind: 'items', field: 'tags' }] }, /minItems, maxItems or sameCountAs/],
        [{ fallback: { kind: 'value', fields: {} } }, /fallback\.fields/],
        [{ fallback: { kind: 'maybe' } }, /"fail" or "value"/],
    ];
    for (const [extra, pattern] of cases) {
        const d = draft();
        const r = applyAddAi(d, { prompt: 'p', ...extra });
        assert.ok(r.error, JSON.stringify(extra));
        assert.match(r.error, pattern);
        assert.ok(r._fixHint, 'carries its own hint');
        assert.equal(r.added, undefined);
        assert.strictEqual(d.steps.length, 1, 'nothing was appended');
    }
});

// ── forEach.concurrency ──────────────────────────────────────────────────────

test('forEach.concurrency is kept when it is a whole number from 1 to 1000', () => {
    for (const concurrency of [1, 4, 1000, '8']) {
        const { forEach, error } = sanitizeForEach({ overRef: 'steps.s1.output.results', itemVar: 'r', concurrency }, draft(), undefined);
        assert.ifError(error);
        assert.strictEqual(forEach.concurrency, Number(concurrency));
    }
    const none = sanitizeForEach({ overRef: 'steps.s1.output.results', concurrency: null }, draft(), undefined);
    assert.ok(!('concurrency' in none.forEach));
});

test('forEach.concurrency outside that range is refused in one sentence', () => {
    for (const concurrency of [0, -1, 1001, 2.5, 'many']) {
        const { error } = sanitizeForEach({ overRef: 'steps.s1.output.results', concurrency }, draft(), undefined);
        assert.strictEqual(error, 'forEach.concurrency must be an integer between 1 and 1000.', String(concurrency));
    }
});

test('an AI step per item keeps its concurrency', () => {
    const { added, error } = add({ forEach: { overRef: 'steps.s1.output.results', itemVar: 'r', maxIterations: 50, concurrency: 6 } });
    assert.ifError(error);
    assert.deepStrictEqual(added.forEach, { overRef: 'steps.s1.output.results', itemVar: 'r', maxIterations: 50, concurrency: 6 });
});

// ── update_step ──────────────────────────────────────────────────────────────

/** A plain step in a draft, patched with `patch`; returns the stored step. */
function patched(patch) {
    const d = draft();
    const { added } = applyAddAi(d, { prompt: 'Pick the category', outputSchema: SCHEMA });
    const r = applyUpdateStep(d, { stepId: added.id, patch }, {});
    return { r, step: d.steps.find((s) => s.id === added.id), id: added.id };
}

test('a patch lands on exactly what an add would have written', () => {
    const addedStep = add(SETTINGS).added;
    const { r, step } = patched(SETTINGS);
    assert.ifError(r.error);
    for (const k of ['temperature', 'enumFrom', 'checks', 'fallback', 'askOnce']) {
        assert.deepStrictEqual(step[k], addedStep[k], k);
        assert.strictEqual(JSON.stringify(step[k]), JSON.stringify(addedStep[k]), `${k} is byte-identical`);
    }
});

test('a patch rounds, rebuilds askOnce and canonicalises like the add path', () => {
    assert.strictEqual(patched({ temperature: 0.3333 }).step.temperature, 0.33);
    assert.strictEqual(patched({ askOnce: {} }).step.askOnce, true);
    assert.deepStrictEqual(patched({ askOnce: { ttlSeconds: 30, junk: 1 } }).step.askOnce, { ttlSeconds: 30 });
});

test('null clears a setting, and so does an empty list', () => {
    const d = draft();
    const { added } = applyAddAi(d, { prompt: 'p', outputSchema: SCHEMA, ...SETTINGS });
    for (const patch of [{ temperature: null }, { enumFrom: null }, { checks: [] }, { fallback: null }, { askOnce: null }]) {
        const r = applyUpdateStep(d, { stepId: added.id, patch }, {});
        assert.ifError(r.error);
        const key = Object.keys(patch)[0];
        assert.ok(!(key in d.steps.find((s) => s.id === added.id)), `${key} cleared`);
    }
});

test('an unusable value passes through unchanged so the validator reports it by name', () => {
    const { r, step } = patched({ temperature: 9, checks: [{ kind: 'script', field: 'summary', script: 'klingon' }] });
    assert.ifError(r.error);
    assert.strictEqual(step.temperature, 9);
    assert.deepStrictEqual(step.checks, [{ kind: 'script', field: 'summary', script: 'klingon' }]);
    const res = validateDefinition({ trigger: { id: 'trg', kind: 'manual' }, steps: [step], edges: [{ from: 'trg', to: step.id }] }, {});
    const codes = (res.errors || []).map((e) => e.code);
    assert.ok(codes.includes('ai_step.temperature_range'));
    assert.ok(codes.includes('ai_step.check_invalid'));
});

test('a patch can set forEach.concurrency, and refuses a bad one', () => {
    const ok = patched({ forEach: { overRef: 'steps.s1.output.results', itemVar: 'r', concurrency: 3 } });
    assert.ifError(ok.r.error);
    assert.strictEqual(ok.step.forEach.concurrency, 3);
    const bad = patched({ forEach: { overRef: 'steps.s1.output.results', itemVar: 'r', concurrency: 0 } });
    assert.match(bad.r.error, /forEach\.concurrency must be an integer between 1 and 1000/);
});

test('askOnce is patchable on an AI step, and still refused where nothing reads it', () => {
    const d = draft();
    d.steps.push({ id: 'w1', type: 'wait', seconds: 5 });
    const { added } = applyAddAi(d, { prompt: 'p' });
    assert.ifError(applyUpdateStep(d, { stepId: added.id, patch: { askOnce: true } }, {}).error);
    assert.match(applyUpdateStep(d, { stepId: 'w1', patch: { askOnce: true } }, {}).error, /not patchable on a wait step/);
});

// ── the tool surface ─────────────────────────────────────────────────────────

const tool = (name) => TOOL_SCHEMAS.find((t) => t.function.name === name).function;

test('builder_add_ai_step offers the new settings with the right types', () => {
    const p = tool('builder_add_ai_step').parameters.properties;
    assert.strictEqual(p.temperature.type, 'number');
    assert.strictEqual(p.enumFrom.type, 'array');
    assert.strictEqual(p.checks.type, 'array');
    assert.strictEqual(p.fallback.type, 'object');
    assert.strictEqual(p.askOnce.type, undefined, 'true or an object: no type list, providers differ on them');
    assert.ok(p.forEach.properties.concurrency, 'forEach.concurrency');
    assert.deepStrictEqual(p.fallback.properties.kind.enum, ['fail', 'value']);
    assert.deepStrictEqual(p.checks.items.properties.kind.enum, ['allowedFrom', 'numbersFrom', 'script', 'items']);
    assert.strictEqual(p.checks.items.properties.script.enum.length, 10);
});

test('the list entries are closed, so the grammar cannot invent keys', () => {
    const p = tool('builder_add_ai_step').parameters.properties;
    assert.strictEqual(p.enumFrom.items.additionalProperties, false);
    assert.strictEqual(p.checks.items.additionalProperties, false);
    assert.deepStrictEqual(p.enumFrom.items.required, ['field', 'ref']);
    assert.deepStrictEqual(p.checks.items.required, ['kind', 'field']);
});

test('the descriptions teach the doctrine and carry one generic example each', () => {
    const p = tool('builder_add_ai_step').parameters.properties;
    assert.match(p.enumFrom.description, /SHOWN to the model AND checked/);
    assert.match(p.enumFrom.description, /field:"category",ref:"steps\.s1\.output\.rows",value:"name"/);
    assert.match(p.checks.description, /never sent to the model/);
    assert.match(p.checks.description, /ONE automatic repair round/);
    assert.match(p.checks.description, /kind:"numbersFrom",field:"summary",ref:"steps\.s2\.output\.totals"/);
    assert.match(p.fallback.description, /kind:"value",fields:\{category:\{kind:"literal",value:"Other"\}/);
    assert.match(p.fallback.description, /WHOLE answer/);
    assert.match(p.fallback.properties.fields.description, /every field a later step reads/);
    assert.match(p.askOnce.description, /"Answers from AI steps"/);
    assert.match(p.forEach.properties.concurrency.description, /AI step without tools/);
});

test('the tool text carries no prices and no placeholder tags', () => {
    const text = JSON.stringify(tool('builder_add_ai_step').parameters.properties);
    assert.ok(!/[€$£]\s?\d|\[(confirm|source|todo)\]/i.test(text));
});

test('builder_update_step lists the new keys for an ai_step, and data extraction mentions concurrency', () => {
    const d = tool('builder_update_step').parameters.properties.patch.description;
    for (const k of ['temperature', 'enumFrom', 'checks', 'fallback', 'askOnce']) assert.match(d, new RegExp(k));
    assert.match(tool('builder_add_data_extraction').description, /forEach\.concurrency/);
    assert.ok(tool('builder_add_data_extraction').parameters.properties.forEach.properties.concurrency);
    assert.ok(!tool('builder_add_notification').parameters.properties.forEach.properties.concurrency, 'a step that cannot use it is not offered it');
});

test('the lean menu hides the settings from the small band', () => {
    const lean = projectToolSchemas(TOOL_SCHEMAS, { variant: 'lean' }).find((t) => t.function.name === 'builder_add_ai_step').function.parameters.properties;
    for (const k of ['temperature', 'enumFrom', 'checks', 'fallback', 'askOnce']) assert.ok(!(k in lean), k);
});
