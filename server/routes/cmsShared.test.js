// @typecheck
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { checkStoredLiveSite } = require('./cmsShared');

function deps(getProject) {
    const calls = { cleared: 0, warned: 0 };
    return {
        calls,
        deps: {
            getProject,
            clearLive: async () => { calls.cleared++; },
            log: { warn: () => { calls.warned++; } },
        },
    };
}

test('a project that exists keeps the live pointer', async () => {
    const { deps: d, calls } = deps(async () => ({ id: 'pj_abcd' }));
    assert.strictEqual(await checkStoredLiveSite('pj_abcd', d), 'pj_abcd');
    assert.strictEqual(calls.cleared, 0);
});

test('a project the store says is gone clears the pointer', async () => {
    const { deps: d, calls } = deps(async () => null);
    assert.strictEqual(await checkStoredLiveSite('pj_abcd', d), null);
    assert.strictEqual(calls.cleared, 1);
});

test('a transient read error never clears the pointer (#225)', async () => {
    const { deps: d, calls } = deps(async () => { throw new Error('pool timeout'); });
    assert.strictEqual(await checkStoredLiveSite('pj_abcd', d), 'pj_abcd');
    assert.strictEqual(calls.cleared, 0);
    assert.strictEqual(calls.warned, 1);
});
