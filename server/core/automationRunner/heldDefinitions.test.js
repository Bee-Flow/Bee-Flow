/**
 * The definition a journey keeps across a pause (./heldDefinitions.js): asked of the feature that started it through
 * a runner port, and nothing when no feature holds one. A fake port is registered the way boot registers the real
 * one (./featurePorts.js), so nothing is mocked.
 *
 * Run: cd server && node --test core/automationRunner/heldDefinitions.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { heldDefinitionOf } = require('./heldDefinitions');
const { registerRunnerPorts, hasRunnerPort } = require('./featurePorts');

const PAUSED = { id: 'leg-2', rootRunId: 'leg-1', automationId: 'a1' };

test('without a feature that holds definitions, a journey continues as any other', async () => {
    assert.strictEqual(hasRunnerPort('heldDefinitions'), false);
    assert.strictEqual(await heldDefinitionOf(PAUSED), null);
    assert.strictEqual(await heldDefinitionOf(null), null);
});

test('the feature is asked with the paused run, and what it holds is what the journey continues on', async () => {
    const asked = [];
    const held = { trigger: { id: 'trg' }, steps: [], edges: [] };
    registerRunnerPorts({ heldDefinitions: { definitionOf: async (run) => { asked.push(run); return run.rootRunId === 'leg-1' ? held : null; } } });
    assert.strictEqual(await heldDefinitionOf(PAUSED), held);
    assert.strictEqual(await heldDefinitionOf({ id: 'other', automationId: 'a1' }), null, 'a journey the feature did not start');
    assert.deepStrictEqual(asked.map((r) => r.id), ['leg-2', 'other']);
});

test('an answer that is no definition counts as none', async () => {
    for (const answer of [undefined, 'text', 7, ['steps']]) {
        registerRunnerPorts({ heldDefinitions: { definitionOf: async () => answer } });
        assert.strictEqual(await heldDefinitionOf(PAUSED), null, JSON.stringify(answer));
    }
});

test('a feature that knows the journey but cannot vouch for its copy stops it: the error goes up', async () => {
    registerRunnerPorts({ heldDefinitions: { definitionOf: async () => { throw new Error('The stored plan is not the one that was approved.'); } } });
    await assert.rejects(heldDefinitionOf(PAUSED), /not the one that was approved/);
});
