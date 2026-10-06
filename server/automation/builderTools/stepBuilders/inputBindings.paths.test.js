/**
 * Required-input binding notes and patches, with the shared path grammar.
 *
 * boundInputNote told the fan-out envelope (`output` / `item`) of a bound
 * path apart with `/^loop\.[^.]+\.(output|item)\./`, so a bracketed field
 * after it (`loop.r.output["file name"]`) printed "undefined has: …". And the
 * one-edit `_suggestedPatch` addressed the input as `inputs.<key>`, which for
 * a key with a dot (`e.mail`) is a different, nested slot; it now uses the
 * canonical writer (`inputs["e.mail"]`), which suggestedPatch.js reads.
 *
 * Run: cd server && node --test automation/builderTools/stepBuilders/inputBindings.paths.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { boundInputNote, requiredInputError } = require('./inputBindings');
const { applyPatchOps } = require('../suggestedPatch');

test('the envelope half of a bound fan-out path is read with the shared grammar', () => {
    const res = { source: 'fanout', itemFields: ['path'], outputFields: ['file name', 'content'] };
    const note = boundInputNote({ key: 'name', path: 'loop.r.output["file name"]', from: 'forEach' }, res, { overRef: 'steps.rd.output.results', itemVar: 'r' });
    assert.match(note, /output has: /);
    assert.doesNotMatch(note, /undefined/);
});

test('the one-edit patch addresses an input with a dot in its name as one key', () => {
    const graph = { trigger: { id: 'trg', kind: 'manual' }, steps: [{ id: 'up', type: 'integration_action', tool: 'crm_find' }], edges: [{ from: 'trg', to: 'up' }] };
    const candidates = [{ key: 'e.mail', path: 'steps.up.output["e.mail"]', why: 'upstream-same-name', stepId: 'up', tool: 'crm_find' }];
    const res = requiredInputError('nextcloud_read_file', ['e.mail'], null, candidates, graph, {});
    assert.ok(res._suggestedPatch, JSON.stringify(res));
    const op = res._suggestedPatch.ops[0];
    assert.strictEqual(op.path, 'inputs["e.mail"]');
    const { args, skipped } = applyPatchOps({ inputs: {} }, res._suggestedPatch);
    assert.deepStrictEqual(skipped, []);
    assert.deepStrictEqual(args.inputs, { 'e.mail': { kind: 'ref', path: 'steps.up.output["e.mail"]' } });
});
