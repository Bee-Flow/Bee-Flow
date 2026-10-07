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
const { installResolveStub } = require('../testUtils/stubRequire');

// The store's pure clock rule (nextOpenDeadline, REGIME_CLOCKS), loaded over a
// db double so no pool is opened; only the pure functions are used.
const restoreDb = installResolveStub({
    '../db': { run: async () => ({ rows: [], rowCount: 0 }), getOne: async () => null, getAll: async () => [], exec: async () => {} },
});
const incidentStore = require('../stores/incidentStore');
restoreDb();

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
        'cra_early_warning:INC-8', 'cra_full_report:INC-8', 'cra_full_report:INC-9',
        'cra_notification:INC-8', 'cra_notification:INC-9', 'incident:INC-7',
    ]);
    // The 72 h vulnerability notification is listed until it is stamped (Art. 14(2)(b)).
    const notification = out.items.find(i => i.id === 'cra_notification:8');
    assert.equal(notification.due_at, at(detected + 72 * H));
    assert.equal(notification.meta.article, 'CRA Art. 14(2)(b)');
    assert.equal(notification.meta.stage, 'notification');
    // The final report is point (c), not the 72 h notification of point (b).
    assert.equal(out.items.find(i => i.id === 'cra_full_report:8').meta.article, 'CRA Art. 14(2)(c)');
    assert.equal(out.items.find(i => i.id === 'incident:7').meta.article, 'GDPR Art. 33');
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

test('a CRA severe incident cites Art. 14(4)(a)-(c), gets its 72 h notification and no GDPR-labelled item', async () => {
    const detected = NOW - 30 * H;
    const out = await deadlines.build('org1', {
        now: NOW,
        deps: deps({
            incidentStore: {
                listOpenClocks: async () => [
                    { id: 21, kind: 'security_incident', regimes: ['CRA'], title: 'Build server compromised', status: 'early_warning_sent',
                      detected_at: at(detected), deadline_at: at(detected + 72 * H),
                      early_warning_due_at: at(detected + 24 * H), early_warning_sent_at: at(detected + 10 * H),
                      final_report_due_at: at(detected + 33 * D), final_report_sent_at: null, authority_notified_at: null },
                    { id: 22, kind: 'breach', regimes: ['CRA'], title: 'Notified one', status: 'authority_notified',
                      detected_at: at(detected), deadline_at: at(detected + 31 * D),
                      early_warning_due_at: at(detected + 24 * H), early_warning_sent_at: null,
                      final_report_due_at: at(detected + 31 * D), final_report_sent_at: null, authority_notified_at: at(NOW - H) },
                ],
            },
        }),
    });
    const ids = out.items.map(i => i.id).sort();
    assert.deepEqual(ids, ['cra_early_warning:22', 'cra_full_report:21', 'cra_full_report:22', 'cra_notification:21'],
        'no "incident" item for a CRA-only row; the notified row has no notification item');
    assert.equal(out.items.find(i => i.id === 'cra_notification:21').meta.article, 'CRA Art. 14(4)(b)');
    assert.equal(out.items.find(i => i.id === 'cra_notification:21').state, 'ok', '42 h left on the 72 h clock');
    assert.equal(out.items.find(i => i.id === 'cra_full_report:21').meta.article, 'CRA Art. 14(4)(c)');
    assert.equal(out.items.find(i => i.id === 'cra_early_warning:22').meta.article, 'CRA Art. 14(4)(a)');
});

test('the authority item cites the regimes it covers, and its due date is their own clock', async () => {
    const detected = NOW - 10 * H;
    const row = (id, regimes, extra = {}) => ({
        id, kind: 'security_incident', regimes, title: `Row ${id}`, status: 'open', detected_at: at(detected),
        deadline_at: at(detected + 24 * H), authority_notified_at: null, ...extra,
    });
    const out = await deadlines.build('org1', {
        now: NOW,
        deps: deps({
            incidentStore: {
                nextOpenDeadline: incidentStore.nextOpenDeadline,
                REGIME_CLOCKS: incidentStore.REGIME_CLOCKS,
                listOpenClocks: async () => [
                    row(31, ['NIS2'], { early_warning_due_at: at(detected + 24 * H) }),
                    row(32, ['DORA'], { customer_notice_due_at: at(detected + 4 * H), deadline_at: at(detected + 4 * H) }),
                    row(33, ['GDPR', 'NIS2'], { early_warning_due_at: at(detected + 24 * H) }),
                    // GDPR + CRA vulnerability: deadline_at is the CRA 24 h early
                    // warning, but the GDPR Art. 33 clock is 72 h.
                    row(34, ['GDPR', 'CRA'], { kind: 'vulnerability', early_warning_due_at: at(detected + 24 * H),
                        final_report_due_at: at(detected + 14 * D) }),
                ],
            },
        }),
    });
    const incident = (id) => out.items.find(i => i.id === `incident:${id}`);
    assert.equal(incident(31).meta.article, 'NIS2 Art. 23(4)');
    assert.equal(incident(31).due_at, at(detected + 24 * H), 'the NIS2 early warning');
    assert.equal(incident(32).meta.article, 'DORA Art. 30(3)(b)');
    assert.equal(incident(32).due_at, at(detected + 4 * H), 'the stored DORA customer notice');
    assert.equal(incident(33).meta.article, 'GDPR Art. 33 · NIS2 Art. 23(4)');
    assert.equal(incident(34).meta.article, 'GDPR Art. 33');
    assert.deepEqual(incident(34).meta.regimes, ['GDPR']);
    assert.equal(incident(34).due_at, at(detected + 72 * H), 'the GDPR 72 h clock, not the CRA early warning');
    assert.equal(out.items.find(i => i.id === 'cra_early_warning:34').due_at, at(detected + 24 * H), 'which is its own item');
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
    // The 12-month expiry is Bee Flow's review interval, not a statutory
    // clock: no article is cited (the UI drops a null article).
    assert.equal(out.items[1].meta.article, null);
    assert.deepEqual(out.empty_kinds, ['dsr', 'incident', 'cra_early_warning', 'cra_notification', 'cra_full_report']);
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
    assert.deepEqual(deadlines.KINDS, ['dsr', 'incident', 'cra_early_warning', 'cra_notification', 'cra_full_report', 'obligation', 'attestation_expiry']);
    assert.equal(deadlines.URGENT_BELOW_MS.dsr, 5 * D);
    assert.equal(deadlines.URGENT_BELOW_MS.cra_early_warning, 6 * H);
    assert.equal(deadlines.URGENT_BELOW_MS.cra_notification, 24 * H);
});
