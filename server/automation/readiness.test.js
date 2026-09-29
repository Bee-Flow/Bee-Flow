/**
 * automation/readiness: the "Ready to activate?" checklist.
 *
 * Run: cd server && node --test automation/readiness.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { computeReadiness, lastTestOf, stepsCompleteOf } = require('./readiness');
const { validateDefinition } = require('./validate');

const OK_DEF = { trigger: { id: 't1', kind: 'manual' }, steps: [{ id: 's1', type: 'wait', seconds: 1 }], edges: [{ from: 't1', to: 's1' }] };
const NOT_REQUIRED = { required: false, status: 'not_required', expiresAt: null };

test('a complete, described routine without a gate can activate', () => {
    const r = computeReadiness({
        automation: { id: 'a1', version: 3, description: 'Fetches invoices.', definition: OK_DEF },
        validation: validateDefinition(OK_DEF),
        runs: [],
        aiAct: NOT_REQUIRED,
    });
    assert.deepStrictEqual(r.stepsComplete, { ok: true, issues: 0, firstIssue: null });
    assert.strictEqual(r.lastTest, null);
    assert.deepStrictEqual(r.description, { ok: true });
    assert.strictEqual(r.aiAct.status, 'not_required');
    assert.strictEqual(r.canActivate, true);
    assert.strictEqual(r.version, 3);
});

test('incomplete steps are counted and block; the first issue is named', () => {
    const def = { trigger: { id: 't1', kind: 'manual' }, steps: [{ id: 'a', type: 'ai_step' }], edges: [{ from: 't1', to: 'a' }] };
    const r = computeReadiness({ automation: { definition: def }, validation: validateDefinition(def), aiAct: NOT_REQUIRED });
    assert.strictEqual(r.stepsComplete.ok, false);
    assert.ok(r.stepsComplete.issues >= 1);
    assert.ok(r.stepsComplete.firstIssue.code);
    assert.strictEqual(r.canActivate, false);
});

test('a hand-written pinned sample is an issue, like at activation', () => {
    const def = { ...OK_DEF, steps: [{ ...OK_DEF.steps[0], pinnedOutput: { x: 1 }, pinnedSource: 'edited' }] };
    const s = stepsCompleteOf(def, { ok: true, errors: [] });
    assert.strictEqual(s.ok, false);
    assert.strictEqual(s.issues, 1);
    assert.strictEqual(s.firstIssue.code, 'pin.edited_sample_blocks_activation');
    const captured = { ...OK_DEF, steps: [{ ...OK_DEF.steps[0], pinnedOutput: { x: 1 }, pinnedSource: 'captured' }] };
    assert.strictEqual(stepsCompleteOf(captured, { ok: true, errors: [] }).ok, true);
});

test('the AI Act check blocks only when required and not valid', () => {
    const base = { automation: { definition: OK_DEF, description: '' }, validation: { ok: true, errors: [] } };
    assert.strictEqual(computeReadiness({ ...base, aiAct: { required: true, status: 'missing', expiresAt: null } }).canActivate, false);
    assert.strictEqual(computeReadiness({ ...base, aiAct: { required: true, status: 'expired', expiresAt: '2026-01-01T00:00:00.000Z' } }).canActivate, false);
    const valid = computeReadiness({ ...base, aiAct: { required: true, status: 'valid', expiresAt: '2027-01-01T00:00:00.000Z' } });
    assert.strictEqual(valid.canActivate, true, 'a missing description and no test run do not block');
    assert.deepStrictEqual(valid.description, { ok: false });
    assert.strictEqual(valid.aiAct.expiresAt, '2027-01-01T00:00:00.000Z');
});

test('lastTest: the newest finished Test or dry run, live runs and running tests skipped', () => {
    const runs = [
        { id: 'r5', isTest: true, status: 'running', startedAt: '2026-09-28T10:05:00Z' },
        { id: 'r4', isTest: false, mode: 'live', status: 'success', finishedAt: '2026-09-28T10:04:00Z' },
        { id: 'r3', isTest: false, mode: 'dry_run', status: 'error', finishedAt: '2026-09-28T10:03:00Z', version: 7 },
        { id: 'r2', isTest: true, status: 'success', finishedAt: '2026-09-28T10:02:00Z' },
    ];
    assert.deepStrictEqual(lastTestOf(runs), { ok: false, at: '2026-09-28T10:03:00Z', runId: 'r3', status: 'error', version: 7 });
    assert.deepStrictEqual(lastTestOf(runs.slice(3)), { ok: true, at: '2026-09-28T10:02:00Z', runId: 'r2', status: 'success', version: null });
    assert.strictEqual(lastTestOf([runs[1]]), null);
});
