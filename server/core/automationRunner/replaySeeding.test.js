// @typecheck
'use strict';

/**
 * A partial run (▶ Execute step) seeds its upstream data from the recent runs
 * of the automation. A run that used its starter's own connections holds the
 * starter's values, so it seeds nobody else's partial run.
 *
 * Run: node --test core/automationRunner/replaySeeding.test.js
 */

const { test, after } = require('node:test');
const assert = require('node:assert');
const { preloadStubs } = require('../../testUtils/stubRequire');

const RUNS = [
    { id: 'r-caller', version: 1, mode: 'live', startedByUserId: 'starter', connectionsMode: 'caller' },
    { id: 'r-own', version: 1, mode: 'live', startedByUserId: 'owner', connectionsMode: null },
];
const STEPS = {
    'r-caller': [{ runId: 'r-caller', stepId: 's1', stepType: 'set', status: 'success', attempts: 1, output: { v: 'from-starter' } }],
    'r-own': [{ runId: 'r-own', stepId: 's1', stepType: 'set', status: 'success', attempts: 1, output: { v: 'from-owner' } }],
};
preloadStubs(require, { '../../stores/automationStore': {
    getRunsForAutomation: async () => RUNS.map(r => ({ ...r })),
    getRunSteps: async (id) => (STEPS[id] || []).map(s => ({ ...s })),
} });
const { seedReplayState } = require('./replaySeeding');
after(() => { setImmediate(() => process.exit(process.exitCode || 0)); });

const stepIdFor = (row) => row.stepId;

test('the owner\'s builder never replays the starter\'s caller-mode run', async () => {
    const { replayState, runsWindow } = await seedReplayState('a1', 1, stepIdFor, { viewerUserId: 'owner' });
    assert.deepStrictEqual(runsWindow.map(r => r.id), ['r-own']);
    assert.deepStrictEqual(replayState.s1.output, { v: 'from-owner' });
});

test('the starter replays their own run (it is the newest, so it wins)', async () => {
    const { runsWindow, replayState } = await seedReplayState('a1', 1, stepIdFor, { viewerUserId: 'starter' });
    assert.deepStrictEqual(runsWindow.map(r => r.id), ['r-caller', 'r-own']);
    assert.deepStrictEqual(replayState.s1.output, { v: 'from-starter' });
});

test('with no viewer named the caller-mode run is left out', async () => {
    const { runsWindow } = await seedReplayState('a1', 1, stepIdFor, {});
    assert.deepStrictEqual(runsWindow.map(r => r.id), ['r-own']);
});
