/**
 * The stage engine's pure rules: the status machine, eligibility (design
 * 6.2), the approval matrix (6.6, D19) and the plan hash.
 *
 * Run: cd server && node --test projects/stages/model.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
    STATUSES, ACTIVE_STATUSES, canTransition, assertTransition, isActiveStatus, isTerminalStatus,
    eligibleForStage, needsApproval, stableStringify, planHash, hashOf,
} = require('./model');
const { ACTIVE_STATUSES: STORE_ACTIVE } = require('../../stores/solutionStage/deployments');

test('the active set is the store lock set, compensating included', () => {
    assert.deepStrictEqual([...ACTIVE_STATUSES].sort(), [...STORE_ACTIVE].sort());
    assert.ok(isActiveStatus('compensating'));
    assert.ok(!isActiveStatus('awaiting_approval'));
    assert.ok(isTerminalStatus('rejected') && isTerminalStatus('succeeded_with_warnings'));
});

test('the status machine', () => {
    const allowed = [
        ['awaiting_approval', 'approved'], ['awaiting_approval', 'rejected'], ['awaiting_approval', 'cancelled'],
        ['queued', 'preparing'], ['approved', 'preparing'], ['preparing', 'committing'],
        ['preparing', 'compensating'], ['committing', 'converging'], ['committing', 'compensating'],
        ['converging', 'succeeded'], ['converging', 'succeeded_with_warnings'],
        ['succeeded_with_warnings', 'converging'], ['compensating', 'failed'],
    ];
    for (const [from, to] of allowed) assert.ok(canTransition(from, to), `${from} → ${to}`);
    const refused = [
        ['awaiting_approval', 'preparing'], ['queued', 'committing'], ['converging', 'compensating'],
        ['succeeded', 'converging'], ['failed', 'queued'], ['compensating', 'succeeded'], ['nope', 'queued'],
    ];
    for (const [from, to] of refused) assert.ok(!canTransition(from, to), `${from} ↛ ${to}`);
    for (const s of STATUSES) assert.ok(!canTransition(s, 'awaiting_approval'), `nothing returns to awaiting_approval (${s})`);
    assert.throws(() => assertTransition('succeeded', 'preparing'), (e) => e.status === 409 && e.code === 'invalid_transition');
    assert.doesNotThrow(() => assertTransition('queued', 'preparing'));
});

const clean = { id: 'rel_1', channel: 'pipeline', gate: { blocked: false } };

test('eligibility: UAT takes any clean pipeline release', () => {
    assert.deepStrictEqual(eligibleForStage({ stage: 'uat', release: clean }), { ok: true, code: null });
    assert.strictEqual(eligibleForStage({ stage: 'uat', release: { ...clean, gate: { blocked: true } } }).code, 'release_blocked');
    assert.strictEqual(eligibleForStage({ stage: 'uat', release: { ...clean, gate: null } }).code, 'release_blocked');
    assert.strictEqual(eligibleForStage({ stage: 'uat', release: { ...clean, channel: 'gallery' } }).code, 'release_not_pipeline');
    assert.strictEqual(eligibleForStage({ stage: 'uat', release: null }).code, 'release_not_found');
    assert.strictEqual(eligibleForStage({ stage: 'dev', release: clean }).code, 'stage_invalid');
    assert.strictEqual(eligibleForStage({ stage: 'uat', kind: 'teleport', release: clean }).code, 'kind_invalid');
});

test('eligibility: PRD needs the release tested in UAT; a rollback needs a PRD success', () => {
    assert.strictEqual(eligibleForStage({ stage: 'prd', release: clean }).code, 'release_not_in_uat');
    assert.ok(eligibleForStage({ stage: 'prd', release: clean, testedInUat: true }).ok);
    assert.strictEqual(eligibleForStage({ stage: 'prd', kind: 'rollback', release: clean, testedInUat: true }).code, 'rollback_target_invalid');
    assert.ok(eligibleForStage({ stage: 'prd', kind: 'rollback', release: clean, succeededInPrd: true }).ok);
    assert.strictEqual(eligibleForStage({ stage: 'prd', release: { ...clean, gate: { blocked: true } }, testedInUat: true }).code, 'release_blocked');
});

test('eligibility: a redeploy re-applies the current release; authority is the owner and run-as', () => {
    assert.ok(eligibleForStage({ stage: 'uat', kind: 'redeploy', release: clean, currentReleaseId: 'rel_1' }).ok);
    assert.strictEqual(eligibleForStage({ stage: 'uat', kind: 'redeploy', release: clean, currentReleaseId: 'rel_0' }).code, 'redeploy_target_invalid');
    assert.strictEqual(eligibleForStage({ stage: 'uat', release: clean, actorId: 'bob', solutionOwnerId: 'alice' }).code, 'solution_owner_only');
    assert.strictEqual(eligibleForStage({ stage: 'uat', release: clean, actorId: 'alice', solutionOwnerId: 'alice', runAsUserId: 'carol' }).code, 'run_as_mismatch');
    assert.ok(eligibleForStage({ stage: 'uat', kind: 'settings', actorId: 'alice', solutionOwnerId: 'alice' }).ok);
    assert.ok(eligibleForStage({ stage: 'prd', kind: 'remove' }).ok);
});

test('needsApproval matrix (a PRD redeploy under the gate needs approval)', () => {
    const gate = { requiresApproval: true, rollbackNeedsApproval: false };
    const cases = [
        ['prd', 'deploy', gate, true],
        ['prd', 'redeploy', gate, true],
        ['prd', 'settings', gate, true],
        ['prd', 'remove', gate, true],
        ['prd', 'rollback', gate, false],
        ['prd', 'rollback', { requiresApproval: true, rollbackNeedsApproval: true }, true],
        ['prd', 'deploy', { requiresApproval: false }, false],
        ['prd', 'rollback', { requiresApproval: false, rollbackNeedsApproval: true }, false],
        ['uat', 'deploy', gate, false],
        ['uat', 'redeploy', { requiresApproval: true, rollbackNeedsApproval: true }, false],
    ];
    for (const [stage, kind, settings, want] of cases) {
        assert.strictEqual(needsApproval({ stage, kind, settings }), want, `${stage} ${kind} ${JSON.stringify(settings)}`);
    }
    // A stage row carries its own settings.
    assert.strictEqual(needsApproval({ stage: { stage: 'prd', requiresApproval: true }, kind: 'redeploy' }), true);
    assert.strictEqual(needsApproval({ stage: { stage: 'prd', requiresApproval: false }, kind: 'deploy' }), false);
});

test('stableStringify and planHash are stable under key order', () => {
    assert.strictEqual(stableStringify({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: undefined } }), '{"a":{"d":[1,{"y":2,"z":1}]},"b":1}');
    const a = {
        kind: 'deploy', release: { id: 'rel_1', seq: 1 },
        parts: [{ ref: 'aut_1', action: 'create', drift: false }],
        data: [], referenceRows: [], knowledge: [],
        bindings: { missing: [], orphaned: [] }, variables: { missing: ['x'], invalid: [] },
        settingsVersion: 3, from: { releaseId: 'rel_0', seq: 0 },
    };
    const b = {
        from: { seq: 0, releaseId: 'rel_0' }, settingsVersion: 3,
        variables: { invalid: [], missing: ['x'] }, bindings: { orphaned: [], missing: [] },
        knowledge: [], referenceRows: [], data: [],
        parts: [{ drift: false, action: 'create', ref: 'aut_1' }],
        release: { seq: 1, id: 'rel_1' }, kind: 'deploy',
        readiness: [{ code: 'not hashed' }],
    };
    assert.strictEqual(planHash(a), planHash(b));
    assert.match(planHash(a), /^sha256:[0-9a-f]{64}$/);
    assert.notStrictEqual(planHash(a), planHash({ ...a, settingsVersion: 4 }));
    assert.notStrictEqual(planHash(a), planHash({ ...a, from: null }));
    assert.notStrictEqual(planHash(a), planHash({ ...a, parts: [{ ref: 'aut_1', action: 'replace', drift: false }] }));
    assert.strictEqual(hashOf({ x: 1, y: 2 }), hashOf({ y: 2, x: 1 }));
    // A removal that also deletes the data is another plan: an approval for one never admits the other.
    const rm = { kind: 'remove', parts: [], settingsVersion: 3 };
    assert.notStrictEqual(planHash({ ...rm, deleteData: false }), planHash({ ...rm, deleteData: true }));
    assert.strictEqual(planHash(rm), planHash({ ...rm, deleteData: null }));
});
