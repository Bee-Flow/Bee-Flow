/**
 * compliance/deadlines — the clock list behind GET /deadlines.
 *
 * Pure module test: every store is injected through `build(orgId, { deps })`,
 * `now` is pinned, so the states and percentages below are arithmetic facts.
 *
 * Run: cd server && node --test --test-force-exit compliance/deadlines.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const deadlines = require('./deadlines');

const NOW = Date.parse('2026-09-14T12:00:00Z');
const H = 3600 * 1000;
const D = 24 * H;
const at = (ms) => new Date(ms).toISOString();

function deps(over = {}) {
    return {
        dsrStore: { listOpenWithDeadlines: async () => [] },
        incidentStore: { listOpenClocks: async () => [] },
        obligationStore: { listObligations: async () => [] },
        aiActAssessmentStore: { listForOrg: async () => [] },
        ...over,
    };
}

test('clockState: overdue → pct 1; urgent within the kind window; ok beyond; none without a due date', () => {
    assert.deepEqual(deadlines.clockState('dsr', NOW - 1, NOW - 10 * D, NOW), { state: 'overdue', pct: 1 });
    assert.equal(deadlines.clockState('dsr', NOW + 4 * D, NOW - 26 * D, NOW).state, 'urgent');
    assert.equal(deadlines.clockState('dsr', NOW + 6 * D, NOW - 24 * D, NOW).state, 'ok');
    assert.equal(deadlines.clockState('incident', NOW + 23 * H, NOW - 49 * H, NOW).state, 'urgent');
    assert.equal(deadlines.clockState('incident', NOW + 25 * H, NOW - 47 * H, NOW).state, 'ok');
    assert.equal(deadlines.clockState('cra_early_warning', NOW + 5 * H, NOW - 19 * H, NOW).state, 'urgent');
    assert.equal(deadlines.clockState('cra_early_warning', NOW + 7 * H, NOW - 17 * H, NOW).state, 'ok');
    assert.equal(deadlines.clockState('cra_full_report', NOW + 23 * H, NOW, NOW).state, 'urgent');
    assert.equal(deadlines.clockState('obligation', NOW + 6 * D, NOW, NOW).state, 'urgent');
    assert.equal(deadlines.clockState('attestation_expiry', NOW + 29 * D, NOW, NOW).state, 'urgent');
    assert.deepEqual(deadlines.clockState('dsr', null, NOW, NOW), { state: 'none', pct: 0 });
    // half-way through a 30-day window
    assert.equal(deadlines.clockState('dsr', NOW + 15 * D, NOW - 15 * D, NOW).pct, 0.5);
});

test('DSR rows become "#id · type" items — no e-mail anywhere, target is the request', async () => {
    const out = await deadlines.build('org1', {
        now: NOW,
        deps: deps({
            dsrStore: {
                listOpenWithDeadlines: async () => [
                    { id: 2038, request_type: 'access', status: 'pending', channel: 'public_form', identity_status: 'unverified',
                      created_at: at(NOW - 26 * D), due_at: at(NOW + 4 * D), extended_until: null, subject_email: 'jan@example.org' },
                    { id: 2040, request_type: 'deletion', status: 'in_progress', created_at: at(NOW - 40 * D), started_at: at(NOW - 39 * D),
                      due_at: at(NOW + 50 * D), extended_until: at(NOW + 50 * D) },
                ],
            },
        }),
    });
    assert.equal(out.complete, true);
    assert.equal(out.items.length, 2);
    const first = out.items[0];
    assert.equal(first.id, 'dsr:2038');
    assert.equal(first.kind, 'dsr');
    assert.equal(first.ref, '#2038');
    assert.equal(first.title, 'Access request');
    assert.equal(first.state, 'urgent');
    assert.equal(first.meta.article, 'GDPR Art. 12(3)');
    assert.equal(first.meta.extended, false);
    assert.equal(first.target, '/app/admin/compliance/dsr/2038');
    assert.equal(out.items[1].meta.extended, true);
    assert.equal(out.items[1].state, 'ok');
    assert.ok(!JSON.stringify(out).includes('jan@example.org'), 'the subject e-mail never leaves the store');
});

test('incident rows: GDPR breach → one authority clock; CRA vulnerability → early-warning + full-report clocks, stamped ones dropped', async () => {
    const detected = NOW - 20 * H;
    const out = await deadlines.build('org1', {
        now: NOW,
        deps: deps({
            incidentStore: {
                listOpenClocks: async () => [
                    { id: 7, kind: 'breach', regimes: ['GDPR'], title: 'Laptop lost', severity: 'high', status: 'open',
                      detected_at: at(detected), deadline_at: at(detected + 72 * H), authority_notified_at: null },
                    { id: 8, kind: 'vulnerability', regimes: '["CRA"]', title: 'CVE-2026-1 in parser', status: 'open',
                      detected_at: at(detected), deadline_at: at(detected + 24 * H),
                      early_warning_due_at: at(detected + 24 * H), early_warning_sent_at: null,
                      final_report_due_at: at(detected + 72 * H), final_report_sent_at: null },
                    { id: 9, kind: 'vulnerability', regimes: ['CRA'], title: 'Reported one', status: 'early_warning_sent',
                      detected_at: at(detected), deadline_at: at(detected + 24 * H),
                      early_warning_due_at: at(detected + 24 * H), early_warning_sent_at: at(NOW - H),
                      final_report_due_at: at(detected + 72 * H), final_report_sent_at: null },
                    { id: 10, kind: 'breach', regimes: ['GDPR'], title: 'Notified', detected_at: at(detected),
                      deadline_at: at(detected + 72 * H), authority_notified_at: at(NOW - H) },
                ],
            },
        }),
    });
    const kinds = out.items.map(i => `${i.kind}:${i.ref}`).sort();
    assert.deepEqual(kinds, [
        'cra_early_warning:INC-8', 'cra_full_report:INC-8', 'cra_full_report:INC-9', 'incident:INC-7',
    ]);
    const early = out.items.find(i => i.id === 'cra_early_warning:8');
    assert.equal(early.state, 'urgent', '4 h left on a 6 h window');
    assert.equal(early.target, '/app/admin/compliance/incidents/8');
    assert.equal(early.meta.stage, 'early_warning');
    const breach = out.items.find(i => i.id === 'incident:7');
    assert.equal(breach.state, 'ok', '52 h left on the 72 h clock');
    assert.deepEqual(breach.meta.regimes, ['GDPR']);
    // a stringified regimes column is tolerated
    assert.deepEqual(out.items.find(i => i.id === 'cra_full_report:8').meta.regimes, ['CRA']);
});

test('obligations and expiring AI Act attestations join the list; empty_kinds names what is absent', async () => {
    const out = await deadlines.build('org1', {
        now: NOW,
        deps: deps({
            obligationStore: {
                listObligations: async (orgId, opts) => {
                    assert.equal(opts.openOnly, true);
                    return [{ id: 3, kind: 'internal_audit', title: 'Internal audit 2026', due_at: at(NOW - D), created_at: at(NOW - 300 * D), recur_months: 12 }];
                },
            },
            aiActAssessmentStore: {
                listForOrg: async () => [
                    { target_kind: 'automation', target_id: 'auto-1', outcome: 'transparency', attested_at: at(NOW - 350 * D), expires_at: at(NOW + 15 * D) },
                    { target_kind: 'agent', target_id: 'ag-1', outcome: 'minimal', attested_at: at(NOW - D), expires_at: null },
                ],
            },
        }),
    });
    assert.deepEqual(out.items.map(i => i.id), ['obligation:3', 'attestation_expiry:automation:auto-1']);
    assert.equal(out.items[0].state, 'overdue');
    assert.equal(out.items[0].pct, 1);
    assert.equal(out.items[1].state, 'urgent');
    assert.equal(out.items[1].ref, 'Automation');
    assert.equal(out.items[0].target, '/app/admin/compliance/training', 'an obligation opens Training & competence');
    assert.equal(out.items[1].target, '/app/admin/compliance/frameworks?tab=per_automation');
    assert.deepEqual(out.empty_kinds, ['dsr', 'incident', 'cra_early_warning', 'cra_full_report']);
});

test('sorted overdue → urgent → ok, then by due date; a failing source flags complete:false but keeps the rest', async () => {
    const warn = console.warn;
    console.warn = () => {};
    let out;
    try {
        out = await deadlines.build('org1', {
            now: NOW,
            deps: deps({
                dsrStore: {
                    listOpenWithDeadlines: async () => [
                        { id: 1, request_type: 'access', created_at: at(NOW - 20 * D), due_at: at(NOW + 10 * D) },
                        { id: 2, request_type: 'access', created_at: at(NOW - 31 * D), due_at: at(NOW - D) },
                        { id: 3, request_type: 'access', created_at: at(NOW - 28 * D), due_at: at(NOW + 2 * D) },
                        { id: 4, request_type: 'access', created_at: at(NOW - 25 * D), due_at: at(NOW + 5 * D) },
                    ],
                },
                incidentStore: { listOpenClocks: async () => { throw new Error('db down'); } },
            }),
        });
    } finally { console.warn = warn; }
    assert.equal(out.complete, false);
    assert.deepEqual(out.items.map(i => i.id), ['dsr:2', 'dsr:3', 'dsr:4', 'dsr:1']);
    assert.deepEqual(out.items.map(i => i.state), ['overdue', 'urgent', 'urgent', 'ok']);
    assert.equal(out.generated_at, new Date(NOW).toISOString());
});

test('KINDS and URGENT_BELOW_MS are the contract the client reads', () => {
    assert.deepEqual(deadlines.KINDS, ['dsr', 'incident', 'cra_early_warning', 'cra_full_report', 'obligation', 'attestation_expiry']);
    assert.equal(deadlines.URGENT_BELOW_MS.dsr, 5 * D);
    assert.equal(deadlines.URGENT_BELOW_MS.cra_early_warning, 6 * H);
});
