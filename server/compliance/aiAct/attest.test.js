/**
 * compliance/aiAct/attest: one attestation = register row + allow-listed
 * evidence + event, whoever records it (the hub or the automation's page).
 *
 * Run: cd server && node --test compliance/aiAct/attest.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { attest, EVIDENCE_CHECK_ID } = require('./attest');

function deps() {
    const out = { rows: [], evidence: [], events: [] };
    out.deps = {
        store: { record: async (orgId, kind, id, input) => { const row = { orgId, kind, id, ...input, attested_at: '2026-09-28T10:00:00.000Z' }; out.rows.push(row); return row; } },
        complianceStore: { addEvidence: async (e) => { out.evidence.push(e); } },
        events: { EVENTS: { AI_ACT_ATTESTED: 'ai_act_attested' }, emit: (name, p) => out.events.push({ name, p }) },
        now: () => new Date('2026-09-28T10:00:00Z'),
    };
    return out;
}

test('records the outcome, and the evidence names no answers, titles or people', async () => {
    const d = deps();
    const { row, result } = await attest({
        orgId: 'org-1', kind: 'automation', id: 'a1', actorId: 'u1',
        signals: { contains_ai: true, customer_facing: true },
        answers: { art50: { interacts: 'yes' }, art5: { answer: 'no' } },
    }, d.deps);
    assert.strictEqual(result.outcome, 'transparency');
    assert.strictEqual(row.outcome, 'transparency');
    assert.strictEqual(new Date(row.expiresAt).toISOString(), '2027-09-28T10:00:00.000Z');
    assert.strictEqual(d.evidence.length, 1);
    assert.strictEqual(d.evidence[0].check_id, EVIDENCE_CHECK_ID);
    assert.deepStrictEqual(Object.keys(d.evidence[0].payload).sort(), ['actor', 'attested_at', 'outcome', 'target_id', 'target_kind']);
    assert.deepStrictEqual(d.events.map(e => e.name), ['ai_act_attested']);
});

test('the register leaves "not applicable" without expiry; validMonths gives it one', async () => {
    const d = deps();
    const na = await attest({ orgId: 'o', kind: 'automation', id: 'a', actorId: null, signals: { contains_ai: false }, answers: {} }, d.deps);
    assert.strictEqual(na.row.expiresAt, null);
    const d2 = deps();
    const na12 = await attest({ orgId: 'o', kind: 'automation', id: 'a', actorId: null, signals: { contains_ai: false }, answers: {}, validMonths: 12 }, d2.deps);
    assert.strictEqual(na12.result.outcome, 'not_applicable');
    assert.strictEqual(new Date(na12.row.expiresAt).toISOString(), '2027-09-28T10:00:00.000Z');
});

test('a failing evidence write or event does not fail the attestation', async () => {
    const d = deps();
    d.deps.complianceStore.addEvidence = async () => { throw new Error('chain down'); };
    d.deps.events.emit = () => { throw new Error('bus down'); };
    const { row } = await attest({ orgId: 'o', kind: 'agent', id: 'g', actorId: 'u', signals: { contains_ai: true }, answers: {} }, d.deps);
    assert.strictEqual(row.outcome, 'minimal');
});

test('source and evidence go into the register row, never into the evidence chain', async () => {
    const d = deps();
    await attest({
        orgId: 'o', kind: 'automation', id: 'a', actorId: 'bee', signals: { contains_ai: true }, answers: {},
        source: 'auto', evidence: { v: 1, questions: { usesAi: { answer: 'yes', evidence: [{ code: 'ai_act.uses_ai.steps', params: { steps: [{ label: 'Draft' }] } }] } } },
    }, d.deps);
    assert.strictEqual(d.rows[0].source, 'auto');
    assert.strictEqual(d.rows[0].evidence.v, 1);
    assert.ok(!JSON.stringify(d.evidence).includes('Draft'));
    assert.deepStrictEqual(Object.keys(d.evidence[0].payload).sort(), ['actor', 'attested_at', 'outcome', 'target_id', 'target_kind']);
});
