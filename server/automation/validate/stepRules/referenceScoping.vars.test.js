// @typecheck
'use strict';

/**
 * A `vars.<name>` nothing sets (owner report 2026-11-04): an AI step's answer
 * check took its allowed values from `vars.prioriteitOpties`, nothing in the
 * flow set it, every run failed with "the list of allowed values is empty",
 * and validation let it through: the reference pass skipped the `vars` root.
 *
 * Now: a read of a variable that no writer sets (varsWriters.mts) is a
 * warning `ref.unknown_var`; when it is the list of allowed values of an AI
 * step (enumFrom, an allowedFrom check) the step can never pass, which is an
 * ERROR `ai_check.list_unset` (a completeness code: a draft saves, go-live
 * refuses). A Solution variable the caller names (`knownVarNames`) counts.
 *
 * Run: node --test automation/validate/stepRules/referenceScoping.vars.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { validateDefinition } = require('../../validate');

const all = (v) => [...v.errors, ...v.warnings];
const withCode = (v, code) => all(v).filter(f => f.code === code);

const SCHEMA = { type: 'object', properties: { prioriteit: { type: 'string' }, summary: { type: 'string' } } };

/** form → ai step (the owner's flow, cut down). */
function def(ai, more = {}) {
    const trigger = { id: 'trg', type: 'trigger', kind: 'manual' };
    const step = { id: 'ai1', type: 'ai_step', prompt: 'Beoordeel deze klacht', outputSchema: SCHEMA, ...ai };
    return { trigger, steps: [step], edges: [{ from: 'trg', to: 'ai1' }], ...more };
}
const CHECK = { kind: 'allowedFrom', field: 'prioriteit', ref: 'vars.prioriteitOpties' };

test('an allowedFrom check on a variable nothing sets is ai_check.list_unset: an error that names the step, the field and the ways out', () => {
    const v = validateDefinition(def({ checks: [CHECK] }));
    const [e] = withCode(v, 'ai_check.list_unset');
    assert.ok(e, JSON.stringify(all(v)));
    assert.strictEqual(e.severity, 'error');
    assert.strictEqual(e.path, 'steps[ai1].checks[0].ref');
    assert.match(e.message, /Step ai1: the allowed values for "prioriteit" come from vars\.prioriteitOpties, but nothing in this automation sets it/);
    assert.match(e.message, /can never pass/);
    assert.match(e.hint, /Edit data \(set\) step before this one/);
    assert.strictEqual(v.ok, false);
    assert.deepStrictEqual(withCode(v, 'ref.unknown_var'), [], 'one finding per binding');
});

test('the same list on enumFrom is the same error', () => {
    const v = validateDefinition(def({ enumFrom: [{ field: 'prioriteit', ref: 'vars.prioriteitOpties' }] }));
    assert.deepStrictEqual(withCode(v, 'ai_check.list_unset').map(e => e.path), ['steps[ai1].enumFrom[0].ref']);
});

test('a draft saves with it (a warning blocked at activate); activation refuses', () => {
    const draft = validateDefinition(def({ checks: [CHECK] }), { stage: 'draft' });
    const [w] = withCode(draft, 'ai_check.list_unset');
    assert.strictEqual(draft.ok, true);
    assert.strictEqual(w.blockedAt, 'activate');
});

test('a declared variable, a flowlet\'s variable or a Solution variable the caller names is set: nothing is said', () => {
    for (const [d, opts] of [
        [def({ checks: [CHECK] }, { vars: { prioriteitOpties: ['Laag', 'Hoog'] } }), {}],
        [def({ checks: [CHECK] }), { knownVarNames: new Set(['prioriteitOpties']) }],
    ]) {
        const v = validateDefinition(d, opts);
        assert.deepStrictEqual([...withCode(v, 'ai_check.list_unset'), ...withCode(v, 'ref.unknown_var')], []);
    }
    const layered = {
        ...def({ checks: [CHECK] }),
        layers: { f: { trigger: { id: 'li', type: 'trigger', kind: 'layer_input', params: [] }, steps: [{ id: 'out', type: 'layer_output', fields: {} }], edges: [{ from: 'li', to: 'out' }], vars: { prioriteitOpties: [] } } },
    };
    assert.deepStrictEqual(withCode(validateDefinition(layered), 'ai_check.list_unset'), []);
});

test('a Solution name list that lacks the variable still reports it', () => {
    const v = validateDefinition(def({ checks: [CHECK] }), { knownVarNames: new Set(['other']) });
    assert.strictEqual(withCode(v, 'ai_check.list_unset').length, 1);
});

test('other reads of an unset variable are a warning ref.unknown_var: a ref, a template, an expression, the prompt, a numbersFrom check', () => {
    const v = validateDefinition(def({
        prompt: 'Use {{vars.toon}} please',
        inputs: { a: { kind: 'ref', path: 'vars.apiBase' }, b: { kind: 'template', value: 'Hi {{vars.groet}}' }, c: { kind: 'expr', value: 'vars.limit + 1' } },
        checks: [{ kind: 'numbersFrom', field: 'summary', ref: 'vars.cijfers' }],
    }));
    const found = withCode(v, 'ref.unknown_var');
    assert.ok(found.every(f => f.severity === 'warning'));
    const named = found.map(f => /reads vars\.(\w+)/.exec(f.message)?.[1]).sort();
    assert.deepStrictEqual(named, ['apiBase', 'cijfers', 'groet', 'limit', 'toon']);
    assert.match(found[0].message, /^Step ai1 reads vars\.\w+, but nothing in this automation sets it/);
    assert.match(found[0].hint, /Bind the value directly/);
    assert.match(found[0].hint, /Solution variable/);
    assert.deepStrictEqual(withCode(v, 'ai_check.list_unset'), []);
});

test('a condition reading an unset variable warns; reading a declared one does not', () => {
    const cond = (vars) => ({
        trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
        steps: [
            { id: 'c1', type: 'condition', expr: 'vars.drempel > 3' },
            { id: 'a', type: 'set', fields: { x: { kind: 'literal', value: 1 } } },
            { id: 'b', type: 'set', fields: { x: { kind: 'literal', value: 2 } } },
        ],
        edges: [{ from: 'trg', to: 'c1' }, { from: 'c1', to: 'a', label: 'true' }, { from: 'c1', to: 'b', label: 'false' }],
        ...(vars ? { vars } : {}),
    });
    assert.strictEqual(withCode(validateDefinition(cond()), 'ref.unknown_var').length, 1);
    assert.strictEqual(withCode(validateDefinition(cond({ drempel: 3 })), 'ref.unknown_var').length, 0);
});
