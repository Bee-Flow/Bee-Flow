'use strict';

/**
 * Finding states — the pure rules: which slot a decision belongs to, what the
 * fingerprint covers, and when a decision stops holding.
 *
 * Run: cd server && node --test compliance/findingState.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');

const fs = require('./findingState');

const NOW = Date.parse('2026-09-29T12:00:00Z');

test('a row without a scope id is the global slot', () => {
    assert.strictEqual(fs.scopeKeyOf({ scope_id: null }), 'global');
    assert.strictEqual(fs.scopeKeyOf({ scope_id: '' }), 'global');
    assert.strictEqual(fs.scopeKeyOf({ scope_id: 'project:abc' }), 'project:abc');
});

test('the fingerprint ignores what moves on every run and keeps what was found', () => {
    const a = { status: 'warn', evidence: { orphan_memories: 3, heartbeat_age_hours: 2, heartbeat: '2026-09-29', last_run_at: 'x' } };
    const b = { status: 'warn', evidence: { orphan_memories: 3, heartbeat_age_hours: 9, heartbeat: '2026-09-29', last_run_at: 'y' } };
    assert.strictEqual(fs.fingerprintOf(a), fs.fingerprintOf(b));
    const worse = { status: 'warn', evidence: { orphan_memories: 4 } };
    assert.notStrictEqual(fs.fingerprintOf(a), fs.fingerprintOf(worse), 'one more is a different finding');
    const failing = { status: 'fail', evidence: { orphan_memories: 3 } };
    assert.notStrictEqual(fs.fingerprintOf(a), fs.fingerprintOf(failing), 'warn → fail always re-opens');
});

test('a check can name its own stable subset', () => {
    const def = { fingerprintOf: (ev) => (ev.offenders || []).map(o => o.project_id).sort() };
    const a = { status: 'warn', evidence: { offenders: [{ project_id: 'p1', count: 2 }], total: 2 } };
    const b = { status: 'warn', evidence: { offenders: [{ project_id: 'p1', count: 5 }], total: 5 } };
    const c = { status: 'warn', evidence: { offenders: [{ project_id: 'p1' }, { project_id: 'p2' }] } };
    assert.strictEqual(fs.fingerprintOf(a, def), fs.fingerprintOf(b, def));
    assert.notStrictEqual(fs.fingerprintOf(a, def), fs.fingerprintOf(c, def));
    const throwing = { fingerprintOf: () => { throw new Error('boom'); } };
    assert.strictEqual(typeof fs.fingerprintOf(a, throwing), 'string', 'a broken fingerprintOf falls back, never throws');
});

test('a decision holds only for an open row with the same fingerprint and an unexpired date', () => {
    const row = { check_id: 'C', scope_id: null, status: 'warn', evidence: { n: 1 } };
    const state = { check_id: 'C', scope_key: 'global', fingerprint: fs.fingerprintOf(row), state: 'acknowledged' };
    assert.strictEqual(fs.applies(state, row, null, NOW), true);
    assert.strictEqual(fs.applies(state, { ...row, evidence: { n: 2 } }, null, NOW), false, 'changed → re-opened');
    assert.strictEqual(fs.applies(state, { ...row, status: 'pass' }, null, NOW), false, 'a passing row holds nothing');
    const snoozed = { ...state, state: 'snoozed', until: '2026-09-30T00:00:00Z' };
    assert.strictEqual(fs.applies(snoozed, row, null, NOW), true);
    assert.strictEqual(fs.applies(snoozed, row, null, Date.parse('2026-10-01T00:00:00Z')), false, 'the snooze ran out');
    assert.strictEqual(fs.applies(null, row, null, NOW), false);
});

test('states are indexed per check and slot, and the public shape never carries the fingerprint', () => {
    const row = { check_id: 'C', scope_id: 'project:1', status: 'fail', evidence: {} };
    const stored = { check_id: 'C', scope_key: 'project:1', fingerprint: fs.fingerprintOf(row), state: 'accepted_risk', reason: 'legal hold', actor_id: 'dpo' };
    const idx = fs.indexStates([stored, { check_id: 'C', scope_key: 'global', fingerprint: 'x', state: 'snoozed' }]);
    assert.strictEqual(fs.stateFor(idx, row), stored);
    assert.strictEqual(fs.stateFor(idx, { ...row, scope_id: 'project:2' }), null);
    const pub = fs.publicState(stored, row, null, NOW);
    assert.deepStrictEqual(Object.keys(pub).sort(), ['active', 'actor_id', 'reason', 'state', 'until', 'updated_at']);
    assert.strictEqual(pub.active, true);
});
