'use strict';

/**
 * compliance/evidence/writeFailures — a swallowed evidence write must not stay
 * invisible.
 *
 * The chain verifier can prove that the rows present are unaltered; it cannot
 * see a row that never arrived (the sequence is allocated inside the same
 * transaction, so a failed append leaves no gap). This module is the counter
 * that makes those visible, and `verifyChain` is the report that carries them.
 *
 * Run: cd server && node --test --test-force-exit compliance/evidence/writeFailures.test.js
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

const wf = require('./writeFailures');
const { verifyChain } = require('./chain');

beforeEach(() => wf._reset());

const ROW = {
    organization_id: 'orgA',
    check_id: 'GDPR-Art15-dsr-access',
    subject_type: 'dsr_request',
    subject_id: '42',
};

test('no failure → no summary (the client renders nothing, never a zero)', () => {
    assert.strictEqual(wf.writeFailureSummary('orgA'), null);
});

test('a rejection is counted with an allow-listed entry, and the error TEXT is dropped', () => {
    const err = new Error('duplicate key value violates unique constraint "…" — jan@example.org');
    err.code = '23505';
    wf.recordWriteFailure(ROW, err);

    const s = wf.writeFailureSummary('orgA');
    assert.strictEqual(s.count, 1);
    assert.strictEqual(s.recent.length, 1);
    assert.deepStrictEqual(Object.keys(s.recent[0]).sort(), ['at', 'check_id', 'error_type', 'subject_id', 'subject_type']);
    assert.strictEqual(s.recent[0].check_id, 'GDPR-Art15-dsr-access');
    assert.strictEqual(s.recent[0].subject_type, 'dsr_request');
    assert.strictEqual(s.recent[0].subject_id, '42');
    assert.strictEqual(s.recent[0].error_type, '23505', 'the SQLSTATE, not the sentence it came in');
    // BFSF-441: nothing of the message survives anywhere in the summary.
    const asText = JSON.stringify(s);
    assert.ok(!asText.includes('jan@example.org'));
    assert.ok(!asText.includes('duplicate key'));
});

test('an error without a code falls back to its class, never its message', () => {
    wf.recordWriteFailure(ROW, new TypeError('addEvidence is not a function on payload for person@example.org'));
    const s = wf.writeFailureSummary('orgA');
    assert.strictEqual(s.recent[0].error_type, 'TypeError');
    assert.ok(!JSON.stringify(s).includes('person@example.org'));
});

test('failures are per organisation and never leak across tenants', () => {
    wf.recordWriteFailure({ ...ROW, organization_id: 'orgA' }, new Error('a'));
    wf.recordWriteFailure({ ...ROW, organization_id: 'orgB' }, new Error('b'));
    wf.recordWriteFailure({ ...ROW, organization_id: 'orgB' }, new Error('b'));
    assert.strictEqual(wf.writeFailureSummary('orgA').count, 1);
    assert.strictEqual(wf.writeFailureSummary('orgB').count, 2);
    assert.strictEqual(wf.writeFailureSummary('orgC'), null);
});

test('the counter is bounded — a failing database cannot grow it without limit', () => {
    for (let i = 0; i < wf.MAX_ENTRIES_PER_ORG + 25; i++) wf.recordWriteFailure(ROW, new Error('x'));
    const s = wf.writeFailureSummary('orgA');
    assert.strictEqual(s.count, wf.MAX_ENTRIES_PER_ORG + 25, 'the count is the truth');
    assert.ok(s.recent.length <= 10, 'the sample is capped');
    assert.ok(s.first_at <= s.last_at);
});

test('recordWriteFailure never throws — it runs inside a rejection handler', () => {
    assert.doesNotThrow(() => wf.recordWriteFailure(null, null));
    assert.doesNotThrow(() => wf.recordWriteFailure(undefined, new Error('x')));
    // A row with no org still lands somewhere rather than vanishing.
    assert.ok(wf.writeFailureSummary('unknown').count >= 1);
});

// ── the report an operator actually reads ────────────────────────────────

const emptyDb = {
    getOne: async () => ({ rows_total: 0, chained_rows: 0, pre_chain_rows: 0, pre_chain_invalid: 0, latest_captured_at: null }),
    getAll: async () => [],
};

test('verifyChain carries the write failures beside the walk, without flipping ok', async () => {
    const clean = await verifyChain('orgA', { db: emptyDb });
    assert.strictEqual(clean.ok, true);
    assert.strictEqual(clean.write_failures, null);

    wf.recordWriteFailure(ROW, Object.assign(new Error('nope'), { code: '55P03' }));
    const report = await verifyChain('orgA', { db: emptyDb });
    assert.strictEqual(report.ok, true, 'the chain itself is intact — an incomplete trail is not a broken one');
    assert.strictEqual(report.write_failures.count, 1);
    assert.strictEqual(report.write_failures.recent[0].error_type, '55P03');
    assert.strictEqual((await verifyChain('orgB', { db: emptyDb })).write_failures, null, 'org-scoped');
});

test('the not-provisioned report carries them too', async () => {
    const missingColumns = {
        getOne: async () => { const e = new Error('column "seq" does not exist'); e.code = '42703'; throw e; },
        getAll: async () => [],
    };
    wf.recordWriteFailure(ROW, new Error('x'));
    const report = await verifyChain('orgA', { db: missingColumns });
    assert.strictEqual(report.ok, null, 'still "unknown", never "broken"');
    assert.strictEqual(report.reason, 'columns_missing');
    assert.strictEqual(report.write_failures.count, 1);
});
