// @typecheck strict
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { checkStoredLiveSite, canAdminCms, requireAdmin } = require('./cmsShared');
const { readGate } = require('../auth/gateMeta');

/** @param {(id: string) => Promise<{ id: string } | null>} getProject */
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

/**
 * Runs requireAdmin against a session and reports how it answered.
 * @param {any} session
 */
function gate(session) {
    /** @type {{ status: number | null, passed: boolean }} */
    const out = { status: null, passed: false };
    const res = { status(/** @type {number} */ n) { out.status = n; return this; }, json() { return this; } };
    requireAdmin(/** @type {any} */ ({ session }), /** @type {any} */ (res), () => { out.passed = true; });
    return out;
}

test('the admin gate refuses a session that holds only the all permission', () => {
    const onlyAll = { user: { id: 'u1', role: 'user', permissions: ['all'] }, isAdmin: false };
    assert.deepStrictEqual(gate(onlyAll), { status: 403, passed: false });
});

test('the admin gate lets a platform admin through, by role or by session flag', () => {
    assert.strictEqual(gate({ user: { id: 'u1', role: 'admin' } }).passed, true);
    assert.strictEqual(gate({ user: { id: 'u2', role: 'user' }, isAdmin: true }).passed, true);
});

test('the admin gate answers 401 without a session user', () => {
    assert.deepStrictEqual(gate(null), { status: 401, passed: false });
});

test('the admin gate is the tagged platform gate', () => {
    const meta = readGate(requireAdmin);
    assert.strictEqual(meta?.axis, 'platform');
    assert.strictEqual(meta?.kind, 'superAdmin');
});

test('canAdminCms: a token owner who is a platform admin passes, one who only holds all does not', async () => {
    assert.strictEqual(await canAdminCms({ isAdmin: true, user: { id: 'u1', role: 'admin' } }), true);
    assert.strictEqual(await canAdminCms({ isAdmin: false, user: { id: 'u2', role: 'user' } }), false);
    assert.strictEqual(await canAdminCms({}), false);
});
