// @typecheck strict
/**
 * varsWriters: which `vars.<name>` a definition sets (its own vars and its
 * flowlets' vars; no step writes them), which ones an expression reads, and
 * the builder's refusal for a name nothing sets.
 *
 * Run: cd server && node --test automation/validate/varsWriters.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { varsWrittenBy, varsReadByExpr, unsetVarProblem, describeUnsetVar, unsetVarFix } from './varsWriters.mts';

const require = createRequire(import.meta.url);
const { tryParseExpr } = require('./refPaths');

const sorted = (/** @type {Set<string>} */ s) => [...s].sort();
const tok = (/** @type {Array<string|number>} */ ...keys) => keys.map((key) => ({ type: 'prop', key }));

test('varsWrittenBy: the root vars and every flowlet\'s vars, nothing else', () => {
    const def = {
        vars: { apiBase: 'https://x', prioriteiten: ['Laag', 'Hoog'] },
        steps: [
            // A set step writes its OWN output, never vars.
            { id: 's1', type: 'set', fields: { prioriteitOpties: { kind: 'literal', value: ['Laag'] } } },
            { id: 'l1', type: 'loop', itemVar: 'row', body: [] },
        ],
        layers: { enrich: { vars: { region: 'eu' }, steps: [] }, bare: { steps: [] }, broken: null },
    };
    assert.deepEqual(sorted(varsWrittenBy(def)), ['apiBase', 'prioriteiten', 'region']);
});

test('varsWrittenBy: anything that is not a plain object sets nothing', () => {
    for (const def of [null, undefined, 'x', 7, [], { vars: ['a'] }, { vars: 'a' }, { layers: [{ vars: { a: 1 } }] }]) {
        assert.deepEqual(sorted(varsWrittenBy(def)), [], JSON.stringify(def));
    }
});

test('varsReadByExpr: dotted and bracketed reads, nested ones too; text and members are not reads', () => {
    const read = (/** @type {string} */ src) => {
        const { ast, error } = tryParseExpr(src);
        assert.ok(!error, src);
        return varsReadByExpr(ast);
    };
    assert.deepEqual(read('vars.limit > 3 && vars["drempel waarde"] < 9'), ['limit', 'drempel waarde']);
    assert.deepEqual(read('steps.s1.output[vars.idx]'), ['idx']);
    assert.deepEqual(read('"vars.limit" == steps.s1.output.vars.x'), []);
});

test('unsetVarProblem: a name nothing sets is a sure problem; a declared one, another root or no draft is none', () => {
    const def = { vars: { known: 1 }, layers: { f: { vars: { inLayer: 1 } } } };
    assert.deepEqual(unsetVarProblem(def, tok('vars', 'prioriteitOpties'), true), { kind: 'unset-var', sure: true, name: 'prioriteitOpties', list: true });
    assert.equal(unsetVarProblem(def, tok('vars', 'known', 0)), null);
    assert.equal(unsetVarProblem(def, tok('vars', 'inLayer')), null);
    assert.equal(unsetVarProblem(def, tok('steps', 's1', 'output')), null);
    assert.equal(unsetVarProblem(def, tok('vars')), null);
    assert.equal(unsetVarProblem(undefined, tok('vars', 'x')), null);
});

test('describeUnsetVar names the binding and the ways out, for a list and for a value', () => {
    const list = describeUnsetVar({ kind: 'unset-var', sure: true, name: 'prioriteitOpties', list: true }, 'vars.prioriteitOpties');
    assert.match(list, /^"vars\.prioriteitOpties" reads vars\.prioriteitOpties, which nothing in this automation sets/);
    assert.match(list, /every answer would fail its check/);
    assert.match(list, /Edit data \(set\) step before this one/);
    assert.match(list, /steps\.<that step id>\.output\.<field>/);
    assert.match(list, /a list an earlier step already returns/);
    const value = describeUnsetVar({ kind: 'unset-var', sure: true, name: 'apiBase', list: false }, 'vars.apiBase');
    assert.match(value, /resolves to nothing at every run/);
    assert.match(value, /kind:"literal"/);
    assert.equal(unsetVarFix('x').startsWith('No step can set vars.x.'), true);
});
