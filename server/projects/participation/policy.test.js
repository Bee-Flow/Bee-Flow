/**
 * projects/participation/policy.js — the organisation's switch and the
 * person's opt-out, with configStore injected.
 *
 * Proven:
 *   - the defaults (§7.1), the env default for the org switch, clamping of
 *     every number, and a debounce ceiling never below one quiet period;
 *   - thresholds per sensitivity; comments need both switches;
 *   - answers are memoised for 30 s and a save drops the memo;
 *   - an unreadable policy means "the AI does not join on its own", an
 *     unreadable preference is an opt-out, and neither is memoised.
 *
 * Run: cd server && node --test projects/participation/policy.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
    makePolicy, normalizeOrgPolicy, normalizeUserPreference, thresholdFor, autoAllowedOn,
    DEFAULT_ORG_POLICY, CONFIG_KEY_PREFIX, USER_KEY_PREFIX,
} = require('./policy');

function world(initial = {}) {
    const blobs = { ...initial };
    const reads = [];
    let clock = 1_000_000;
    let failing = false;
    const policy = makePolicy({
        getConfig: async (key) => { reads.push(key); if (failing) throw new Error('db down'); return blobs[key] ?? null; },
        setConfig: async (key, value) => { blobs[key] = value; return true; },
        now: () => clock,
        env: {},
    });
    return { policy, blobs, reads, tick: (ms) => { clock += ms; }, fail: (on) => { failing = on; } };
}

test('the defaults, and an operator can flip the org switch default', () => {
    assert.deepStrictEqual(normalizeOrgPolicy(null, { env: {} }), { ...DEFAULT_ORG_POLICY });
    assert.strictEqual(normalizeOrgPolicy(null, { env: { BEEFLOW_AI_AUTO_DEFAULT: '0' } }).autoAllowed, false);
    assert.strictEqual(normalizeOrgPolicy(null, { env: { BEEFLOW_AI_AUTO_DEFAULT: 'off' } }).autoAllowed, false);
    assert.strictEqual(normalizeOrgPolicy({ autoAllowed: true }, { env: { BEEFLOW_AI_AUTO_DEFAULT: '0' } }).autoAllowed, true, 'a saved choice wins');
    assert.deepStrictEqual(normalizeUserPreference(null), { autoJoinOnMyMessages: true });
    assert.deepStrictEqual(normalizeUserPreference({ autoJoinOnMyMessages: 'false' }), { autoJoinOnMyMessages: true }, 'only a boolean counts');
});

test('every number is clamped; the switches only take booleans', () => {
    const p = normalizeOrgPolicy({
        autoAllowed: 'false', sensitivity: 'reckless', cooldownMinutes: 0, maxAutoPerChatHour: 10_000,
        quietSeconds: 600, maxDebounceSeconds: 30, maxGatesPerOrgDay: null, unansweredMinutes: '7', extra: 'dropped',
    }, { env: {} });
    assert.strictEqual(p.autoAllowed, true, 'the string "false" is not a switch position');
    assert.strictEqual(p.sensitivity, 'balanced');
    assert.strictEqual(p.cooldownMinutes, 1, 'the cooldown cannot be switched off');
    assert.strictEqual(p.maxAutoPerChatHour, 30);
    assert.strictEqual(p.maxDebounceSeconds, 600, 'never below one quiet period');
    assert.strictEqual(p.maxGatesPerOrgDay, DEFAULT_ORG_POLICY.maxGatesPerOrgDay, 'absent is the default, not the minimum');
    assert.strictEqual(p.unansweredMinutes, 7);
    assert.ok(!('extra' in p));
});

test('thresholds and surfaces', () => {
    assert.strictEqual(thresholdFor({ sensitivity: 'conservative' }), 0.85);
    assert.strictEqual(thresholdFor({ sensitivity: 'balanced' }), 0.75);
    assert.strictEqual(thresholdFor({ sensitivity: 'eager' }), 0.6);
    assert.strictEqual(thresholdFor(null), 0.75);
    assert.strictEqual(autoAllowedOn({ autoAllowed: true, commentsAutoAllowed: false }, 'chat'), true);
    assert.strictEqual(autoAllowedOn({ autoAllowed: true, commentsAutoAllowed: false }, 'comment'), false);
    assert.strictEqual(autoAllowedOn({ autoAllowed: false, commentsAutoAllowed: true }, 'comment'), false, 'the org switch is the master');
});

test('memoised for 30 s per org, dropped on save', async () => {
    const w = world({ [`${CONFIG_KEY_PREFIX}org1`]: { autoAllowed: false } });
    assert.strictEqual((await w.policy.resolveOrgPolicy('org1')).autoAllowed, false);
    await w.policy.resolveOrgPolicy('org1');
    assert.strictEqual(w.reads.length, 1, 'the second read is memoised');
    w.tick(31_000);
    await w.policy.resolveOrgPolicy('org1');
    assert.strictEqual(w.reads.length, 2);

    const saved = await w.policy.saveOrgPolicy('org1', { autoAllowed: true, alwaysAllowed: false, commentsAutoAllowed: true, cooldownMinutes: 10 }, { updatedBy: 'olga' });
    assert.strictEqual(saved.cooldownMinutes, 10);
    assert.strictEqual(w.blobs[`${CONFIG_KEY_PREFIX}org1`].updatedBy, 'olga');
    assert.strictEqual((await w.policy.resolveOrgPolicy('org1')).alwaysAllowed, false, 'read fresh after the save');
    assert.strictEqual(await w.policy.isOrgPolicyConfigured('org1'), true);
    assert.strictEqual(await w.policy.isOrgPolicyConfigured('org2'), false);
    assert.deepStrictEqual(await w.policy.resolveOrgPolicy(null), normalizeOrgPolicy(null, { env: {} }), 'no org: the default, no read');
});

test('unknown narrows: an unreadable policy stops auto, an unreadable preference is an opt-out', async () => {
    const w = world();
    w.fail(true);
    const policy = await w.policy.resolveOrgPolicy('org9');
    assert.strictEqual(policy.autoAllowed, false);
    assert.strictEqual(policy.commentsAutoAllowed, false);
    assert.strictEqual(policy.unavailable, true);
    assert.deepStrictEqual(await w.policy.resolveUserPreference('ann'), { autoJoinOnMyMessages: false, unavailable: true });
    w.fail(false);
    assert.strictEqual((await w.policy.resolveOrgPolicy('org9')).autoAllowed, true, 'the failure was not memoised');
    assert.deepStrictEqual(await w.policy.resolveUserPreference('ann'), { autoJoinOnMyMessages: true });
    assert.deepStrictEqual(await w.policy.resolveUserPreference(null), { autoJoinOnMyMessages: false });
});

test('a person opts out and back in', async () => {
    const w = world();
    assert.deepStrictEqual(await w.policy.saveUserPreference('bob', { autoJoinOnMyMessages: false }), { autoJoinOnMyMessages: false });
    assert.strictEqual(w.blobs[`${USER_KEY_PREFIX}bob`].autoJoinOnMyMessages, false);
    assert.deepStrictEqual(await w.policy.resolveUserPreference('bob'), { autoJoinOnMyMessages: false });
    await w.policy.saveUserPreference('bob', { autoJoinOnMyMessages: true });
    assert.deepStrictEqual(await w.policy.resolveUserPreference('bob'), { autoJoinOnMyMessages: true }, 'the save dropped the memo');
});
