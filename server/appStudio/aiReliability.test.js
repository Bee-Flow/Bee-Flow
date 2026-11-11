// @typecheck
'use strict';

/**
 * App Studio AI steps: the optional answer-reliability fields `temperature`, `checks` and
 * `repairRounds` (aiReliability.mts) through the spec, canonicalize, the validator and the
 * runner's reader. A step without them is unchanged everywhere.
 *
 * Run: cd server && node --test appStudio/aiReliability.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { STEP_SPECS, ACTION_SPECS, LIMITS } = require('./componentSpecs');
const { canonicalizeAppDefinition } = require('./canonicalize');
const { validateAction } = require('./validate/actions');
const { readAppReliability, withStepTemperature, aiChecksFindings, APP_CHECK_ROOTS, DEFAULT_REPAIR_ROUNDS } = require('./aiReliability.mts');

const RELIABILITY = ['temperature', 'checks', 'repairRounds'];

test('the three fields are on ai_generate and ai_extract (step and bare action), each since: 3', () => {
    for (const kind of ['ai_generate', 'ai_extract']) {
        for (const table of [STEP_SPECS[kind].fields, ACTION_SPECS[kind].fields]) {
            for (const f of RELIABILITY) assert.equal(table[f].since, 3, `${kind}.${f}`);
            assert.equal(table.temperature.type, 'number');
            assert.equal(table.checks.type, 'aiChecks');
            assert.deepEqual([table.repairRounds.type, table.repairRounds.min, table.repairRounds.max], ['int', 0, LIMITS.MAX_AI_REPAIR_ROUNDS]);
            for (const f of RELIABILITY) assert.equal(table[f].default, undefined, `${kind}.${f} has no default that could be written out`);
        }
    }
    assert.equal(STEP_SPECS.kb_query.fields.checks, undefined);
});

const def = (step) => ({
    schemaVersion: 2, meta: { name: 'T' },
    screens: [{ id: 'scr_aaaaaa', name: 'A', sections: [{ id: 'sec_aaaaaa', components: [] }] }],
    actions: { act_seqaaa: { kind: 'sequence', steps: [step] }, act_bareaa: { ...step } },
});
const gen = (extra = {}) => ({ kind: 'ai_generate', prompt: 'Classify', output: 'structured', schema: [{ name: 'category', type: 'string' }], resultVar: 'r', ...extra });

test('canonicalize writes nothing for a step without the fields, and keeps them as written when present', () => {
    const plain = canonicalizeAppDefinition(def(gen())).def;
    for (const f of RELIABILITY) {
        assert.equal(f in plain.actions.act_seqaaa.steps[0], false);
        assert.equal(f in plain.actions.act_bareaa, false);
    }
    const checks = [{ kind: 'allowedFrom', field: 'category', ref: 'vars.categories' }];
    const { def: out, repairs } = canonicalizeAppDefinition(def(gen({ temperature: '0.3', checks, repairRounds: 2 })));
    for (const s of [out.actions.act_seqaaa.steps[0], out.actions.act_bareaa]) {
        assert.equal(s.temperature, 0.3);
        assert.deepEqual(s.checks, checks);
        assert.equal(s.repairRounds, 2);
    }
    assert.ok(!repairs.some((r) => r.code === 'action.field_uncanonicalised'), 'the bare action has a rule for each field');
    const bad = canonicalizeAppDefinition(def(gen({ checks: 'nope' })));
    assert.equal('checks' in bad.def.actions.act_seqaaa.steps[0], false);
    assert.ok(bad.repairs.some((r) => r.code === 'step.field_invalid' && r.path.endsWith('.checks')));
});

function findings(step, over = {}) {
    const out = [];
    const ctx = {
        pushE: (r) => out.push(`E ${r.code} @${r.path}`), pushW: (r) => out.push(`W ${r.code} @${r.path}`),
        screenIds: new Set(['scr_a']), dataTables: new Map(), aiBrowsingEnabled: false, ...over,
    };
    validateAction('act_1', { kind: 'sequence', steps: [step] }, 'actions.act_1', ctx);
    validateAction('act_2', step, 'actions.act_2', ctx);
    return out;
}

test('the validator: valid fields pass on a step and on a bare action', () => {
    assert.deepEqual(findings(gen({
        temperature: 0, repairRounds: LIMITS.MAX_AI_REPAIR_ROUNDS,
        checks: [
            { kind: 'allowedFrom', field: 'category', ref: 'vars.categories', value: 'name' },
            { kind: 'numbersFrom', field: 'category', ref: 'item.lines' },
            { kind: 'script', field: 'category', script: 'latin' },
            { kind: 'items', field: 'category', minItems: 1, sameCountAs: 'form.files' },
            { kind: 'allowedFrom', field: 'category', ref: 'params.allowed' },
        ],
    })), []);
});

test('the validator: out of range, wrong roots and bad shapes are errors at the field', () => {
    const S = 'actions.act_1.steps[0]';
    const A = 'actions.act_2';
    assert.deepEqual(findings(gen({ temperature: 3 })), [`E action.step_field_invalid @${S}.temperature`, `E action.step_field_invalid @${A}.temperature`]);
    assert.deepEqual(findings(gen({ repairRounds: LIMITS.MAX_AI_REPAIR_ROUNDS + 1 })), [`E action.step_field_invalid @${S}.repairRounds`, `E action.step_field_invalid @${A}.repairRounds`]);
    assert.deepEqual(findings(gen({ checks: [{ kind: 'allowedFrom', field: 'category', ref: 'steps.s1.output.list' }] })),
        [`E action.ai_ref_root_invalid @${S}.checks[0].ref`, `E action.ai_ref_root_invalid @${A}.checks[0].ref`]);
    assert.deepEqual(findings(gen({ checks: [{ kind: 'bogus', field: 'x' }] })), [`E action.ai_check_invalid @${S}.checks[0].kind`, `E action.ai_check_invalid @${A}.checks[0].kind`]);
    assert.deepEqual(findings(gen({ checks: {} })), [`E action.step_field_invalid @${S}.checks`, `E action.step_field_invalid @${A}.checks`]);
    // A key nothing reads is a warning, as in automations.
    assert.deepEqual(findings(gen({ checks: [{ kind: 'script', field: 'category', script: 'latin', extra: 1 }] })),
        [`W action.ai_check_key_ignored @${S}.checks[0]`, `W action.ai_check_key_ignored @${A}.checks[0]`]);
});

test('the validator on a human save: a half-filled check is a warning, so the draft saves; publish keeps the error', () => {
    const half = gen({ checks: [{ kind: 'allowedFrom', field: '' }] });
    const S = 'actions.act_1.steps[0].checks[0]';
    const A = 'actions.act_2.checks[0]';
    assert.deepEqual(findings(half, { dataRefsAsWarnings: true }),
        [`W action.ai_check_invalid @${S}.field`, `W action.ai_check_invalid @${S}.ref`, `W action.ai_check_invalid @${A}.field`, `W action.ai_check_invalid @${A}.ref`]);
    assert.deepEqual(findings(half),
        [`E action.ai_check_invalid @${S}.field`, `E action.ai_check_invalid @${S}.ref`, `E action.ai_check_invalid @${A}.field`, `E action.ai_check_invalid @${A}.ref`]);
    // Not a list at all stays an error: canonicalize drops it anyway.
    assert.deepEqual(findings(gen({ checks: 'x' }), { dataRefsAsWarnings: true })[0], 'E action.step_field_invalid @actions.act_1.steps[0].checks');
});

test('aiChecksFindings: the message names the app roots, never the automation ones', () => {
    const [f] = aiChecksFindings('checks', [{ kind: 'numbersFrom', field: 'a', ref: 'trigger.x' }], 'p.checks');
    assert.equal(f.path, 'p.checks[0].ref');
    assert.match(f.message, new RegExp(APP_CHECK_ROOTS.join(', ')));
    assert.doesNotMatch(f.hint, /steps\.s2/);
});

test('readAppReliability: nothing set is inactive and has no temperature', () => {
    const rel = readAppReliability(gen());
    assert.deepEqual(rel, { active: false, checks: [], repairRounds: DEFAULT_REPAIR_ROUNDS });
    const model = { modelId: 'm', options: { temperature: 0.7, maxTokens: 10 } };
    assert.equal(withStepTemperature(model, rel), model, 'the same object: the call is unchanged');
});

test('readAppReliability: unreadable checks are dropped, numbers clamped, defaults filled', () => {
    const rel = readAppReliability(gen({
        temperature: 9, repairRounds: 99,
        checks: [{ kind: 'allowedFrom', field: 'category', ref: 'trigger.x' }, { kind: 'allowedFrom', field: 'category', ref: 'vars.c' }],
    }));
    assert.equal(rel.active, true);
    assert.deepEqual(rel.checks, [{ kind: 'allowedFrom', field: 'category', ref: 'vars.c', ignoreCase: true, allowEmpty: false }]);
    assert.equal(rel.temperature, 2);
    assert.equal(rel.repairRounds, LIMITS.MAX_AI_REPAIR_ROUNDS);
    assert.equal(readAppReliability(gen({ checks: rel.checks, repairRounds: 0 })).repairRounds, 0);
    const model = { modelId: 'm', options: { temperature: 0.7, maxTokens: 10 } };
    const withT = withStepTemperature(model, readAppReliability(gen({ temperature: 0 })));
    assert.deepEqual(withT.options, { temperature: 0, maxTokens: 10 });
    assert.equal(model.options.temperature, 0.7, 'the resolved model is not changed in place');
});
