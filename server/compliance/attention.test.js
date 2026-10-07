/**
 * compliance/attention — the "Needs attention" list behind GET /attention.
 *
 * Every store is injected; `now` is pinned. Run:
 *   cd server && node --test --test-force-exit compliance/attention.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const attention = require('./attention');

const NOW = Date.parse('2026-09-14T12:00:00Z');
const H = 3600 * 1000;
const D = 24 * H;
const at = (ms) => new Date(ms).toISOString();

const DEFS = {
    'GDPR-Art28-subprocessors': {
        id: 'GDPR-Art28-subprocessors', regulation: 'GDPR', article: '28', severity: 'high', verification: 'automated',
        titleKey: 'compliance.check_subprocessors_title', remediationLink: 'admin/compliance/ropa', autoFixId: null,
        frameworks: [{ regulation: 'GDPR', ref: 'Art. 28' }, { regulation: 'ISO27001', ref: 'A.5.20' }],
    },
    'GDPR-Art32-dlp-enabled': {
        id: 'GDPR-Art32-dlp-enabled', regulation: 'GDPR', article: '32', severity: 'critical', verification: 'automated',
        titleKey: 'compliance.check_dlp_title', autoFixId: 'enable_dlp', frameworks: [{ regulation: 'GDPR', ref: 'Art. 32' }],
    },
    'NIS2-Art21(2)(j)-admin-mfa': {
        id: 'NIS2-Art21(2)(j)-admin-mfa', regulation: 'NIS2', article: '21(2)(j)', severity: 'high', verification: 'automated',
        titleKey: 'compliance.check_nis2_admin_mfa_title', remediationLink: 'admin/security/users', frameworks: [{ regulation: 'NIS2', ref: 'Art. 21(2)(j)' }],
    },
    'NIS2-Art21(2)-policy-coverage': {
        id: 'NIS2-Art21(2)-policy-coverage', regulation: 'NIS2', article: '21(2)', severity: 'medium', verification: 'hybrid',
        titleKey: 'compliance.check_nis2_policy_coverage_title', frameworks: [{ regulation: 'NIS2', ref: 'Art. 21(2)' }],
    },
    'AIA-Art50-ai-disclosure': {
        id: 'AIA-Art50-ai-disclosure', regulation: 'AIA', article: '50', severity: 'medium', verification: 'hybrid', scope: 'per-source',
        titleKey: 'compliance.check_disclosure_title', frameworks: [{ regulation: 'AIA', ref: 'Art. 50' }],
    },
};
const TITLES = {
    'compliance.check_subprocessors_title': 'Sub-processor register',
    'compliance.check_dlp_title': 'DLP enabled',
    'compliance.check_nis2_admin_mfa_title': 'Admin MFA',
    'compliance.check_disclosure_title': 'AI disclosure to users',
};

function deps(over = {}) {
    return {
        complianceStore: { getLatestPerCheck: async () => [], getSettings: async () => ({ breach_recipients: ['dpo'] }) },
        registry: { get: (id) => DEFS[id] || null, getAll: () => Object.values(DEFS) },
        frameworkPolicy: { activeRegulations: async () => new Set(['GDPR', 'AIA', 'ISO27001']) },
        dsrStore: { listOpenWithDeadlines: async () => [] },
        incidentStore: { listOpenClocks: async () => [] },
        soaStore: { getStats: async () => ({ total: 93, approved: 93, todo: 0 }) },
        obligationStore: { listObligations: async () => [] },
        aiActAssessmentStore: { listForOrg: async () => [] },
        titles: TITLES,
        ...over,
    };
}

test('check rows: fail/warn of ACTIVE regulations only; auto_fix when the check has an autoFixId, else open_fix on the remediation link', async () => {
    const out = await attention.build('org1', {
        now: NOW,
        deps: deps({
            complianceStore: {
                getSettings: async () => ({ breach_recipients: ['x'] }),
                getLatestPerCheck: async () => [
                    { check_id: 'GDPR-Art28-subprocessors', status: 'warn', details: 'openai not confirmed', run_at: at(NOW - H) },
                    { check_id: 'GDPR-Art32-dlp-enabled', status: 'fail', details: 'DLP off', run_at: at(NOW - 2 * H) },
                    { check_id: 'NIS2-Art21(2)(j)-admin-mfa', status: 'fail', details: 'no mfa', run_at: at(NOW) }, // NIS2 not active
                    { check_id: 'AIA-Art50-ai-disclosure', status: 'pass', run_at: at(NOW) },
                ],
            },
        }),
    });
    assert.equal(out.complete, true);
    assert.deepEqual(out.items.map(i => i.id), ['check:GDPR-Art32-dlp-enabled:global', 'check:GDPR-Art28-subprocessors:global']);
    const dlp = out.items[0];
    assert.equal(dlp.source, 'check');
    assert.equal(dlp.code, 'GDPR-Art32-dlp-enabled');
    assert.equal(dlp.status, 'fail');
    assert.equal(dlp.title, 'DLP enabled');
    assert.deepEqual(dlp.action, {
        type: 'auto_fix', label_key: 'compliance.attention_action_auto_fix',
        target: '/app/admin/compliance/gdpr/GDPR-Art32-dlp-enabled', auto_fix_id: 'enable_dlp',
    });
    const sub = out.items[1];
    assert.equal(sub.action.type, 'open_fix');
    assert.equal(sub.action.target, '/app/admin/compliance/ropa');
    assert.equal(sub.action.label_key, 'compliance.attention_action_open_fix');
    assert.deepEqual(sub.meta.frameworks, [{ regulation: 'GDPR', ref: 'Art. 28' }, { regulation: 'ISO27001', ref: 'A.5.20' }]);
    assert.equal(sub.meta.verification, 'automated');
    assert.equal(sub.meta.detail, 'openai not confirmed');
    assert.equal(out.total, 2);
    assert.deepEqual(out.tail, []);
});

test('per-source rows collapse into one item per check; check ids with parentheses are URL-encoded in the target', async () => {
    const out = await attention.build('org1', {
        now: NOW,
        deps: deps({
            frameworkPolicy: { activeRegulations: async () => new Set(['AIA', 'NIS2']) },
            complianceStore: {
                getSettings: async () => ({}),
                getLatestPerCheck: async () => [
                    { check_id: 'AIA-Art50-ai-disclosure', status: 'warn', scope_type: 'per-source', scope_id: 'agent-1', details: 'no disclosure', run_at: at(NOW - H) },
                    { check_id: 'AIA-Art50-ai-disclosure', status: 'fail', scope_type: 'per-source', scope_id: 'agent-2', details: 'no disclosure', run_at: at(NOW), evidence: { link: '/app/agents/agent-2' } },
                    { check_id: 'AIA-Art50-ai-disclosure', status: 'warn', scope_type: 'per-source', scope_id: 'agent-3', details: 'no disclosure', run_at: at(NOW - 2 * H) },
                    { check_id: 'NIS2-Art21(2)(j)-admin-mfa', status: 'fail', run_at: at(NOW - H) },
                    { check_id: 'NIS2-Art21(2)-policy-coverage', status: 'warn', run_at: at(NOW - 3 * H) },
                ],
            },
        }),
    });
    assert.deepEqual(out.items.map(i => i.id), [
        'check:NIS2-Art21(2)(j)-admin-mfa:global',
        'check:AIA-Art50-ai-disclosure:subjects',
        'check:NIS2-Art21(2)-policy-coverage:global',
    ], 'three agents are one item, carrying the worst status');
    assert.equal(out.total, 3, 'attention_open counts the check once, not once per subject');
    const agents = out.items[1];
    assert.equal(agents.status, 'fail');
    assert.equal(agents.meta.subject_count, 3);
    assert.deepEqual(agents.meta.subjects.map(s => s.scope_id), ['agent-2', 'agent-1', 'agent-3'], 'failing first, then newest');
    assert.equal(agents.meta.subjects[0].link, '/app/agents/agent-2');
    assert.equal(agents.meta.detail, '3 subjects need attention, 1 of them failing.');
    assert.equal(out.items[0].action.target, '/app/admin/security/users', 'remediation links leave the hub');
    assert.equal(out.items[2].action.type, 'open_fix');
    assert.equal(out.items[2].action.target, `/app/admin/compliance/nis2/${encodeURIComponent('NIS2-Art21(2)-policy-coverage')}`,
        'no remediation link → the check row in its framework page, id passed through encodeURIComponent (parentheses are legal path chars)');
});

test('a single open subject keeps its own id, detail and deep link; the noun comes from the check', async () => {
    const defs = { ...DEFS, 'GDPR-Art30-project-personal-data': {
        id: 'GDPR-Art30-project-personal-data', regulation: 'GDPR', article: '30', severity: 'medium', verification: 'hybrid',
        scope: 'per-source', subjectNoun: 'projects', frameworks: [{ regulation: 'GDPR', ref: '30' }],
    } };
    const make = (rows) => deps({
        registry: { get: (id) => defs[id] || null, getAll: () => Object.values(defs) },
        complianceStore: { getSettings: async () => ({}), getLatestPerCheck: async () => rows },
    });
    const one = await attention.build('org1', { now: NOW, deps: make([
        { check_id: 'GDPR-Art30-project-personal-data', status: 'warn', scope_type: 'per-source', scope_id: 'project:p1', details: 'no record', run_at: at(NOW), evidence: { link: '/app/projects/p1' } },
    ]) });
    assert.equal(one.items[0].id, 'check:GDPR-Art30-project-personal-data:project:p1');
    assert.equal(one.items[0].meta.detail, 'no record');
    assert.equal(one.items[0].meta.link, '/app/projects/p1');
    const two = await attention.build('org1', { now: NOW, deps: make([
        { check_id: 'GDPR-Art30-project-personal-data', status: 'warn', scope_type: 'per-source', scope_id: 'project:p1', run_at: at(NOW) },
        { check_id: 'GDPR-Art30-project-personal-data', status: 'warn', scope_type: 'per-source', scope_id: 'project:p2', run_at: at(NOW) },
    ]) });
    assert.equal(two.items[0].meta.detail, '2 projects need attention.');
    assert.equal(two.items[0].meta.link, null, 'a collapsed item has no single deep link');
});

test('a finding an admin acknowledged is hidden while unchanged and comes back when it changes', async () => {
    const findingState = require('./findingState');
    const row = { check_id: 'GDPR-Art28-subprocessors', status: 'warn', details: 'x', run_at: at(NOW), evidence: { unconfirmed: 1 } };
    const state = { check_id: row.check_id, scope_key: 'global', fingerprint: findingState.fingerprintOf(row), state: 'acknowledged' };
    const make = (rows, states) => deps({
        complianceStore: { getSettings: async () => ({}), getLatestPerCheck: async () => rows, listFindingStates: async () => states },
    });
    const hidden = await attention.build('org1', { now: NOW, deps: make([row], [state]) });
    assert.equal(hidden.total, 0);
    const worse = await attention.build('org1', { now: NOW, deps: make([{ ...row, evidence: { unconfirmed: 2 } }], [state]) });
    assert.equal(worse.total, 1, 'one more unconfirmed operator re-opens it');
    const snoozedOut = await attention.build('org1', { now: NOW, deps: make([row], [{ ...state, state: 'snoozed', until: at(NOW - H) }]) });
    assert.equal(snoozedOut.total, 1, 'an expired snooze holds nothing');
    const unreadable = await attention.build('org1', { now: NOW, deps: deps({
        complianceStore: { getSettings: async () => ({}), getLatestPerCheck: async () => [row], listFindingStates: async () => { throw new Error('42P01'); } },
    }) });
    assert.equal(unreadable.total, 1, 'unreadable states show every finding');
    assert.equal(unreadable.complete, true);
});

test('register findings: DSR overdue / due soon / unverified > 7 d, incident clock without recipients, CRA early warning, SoA todo, obligations, expired attestation', async () => {
    const out = await attention.build('org1', {
        now: NOW, limit: 50,
        deps: deps({
            complianceStore: { getLatestPerCheck: async () => [], getSettings: async () => ({ breach_recipients: [] }) },
            dsrStore: {
                listOpenWithDeadlines: async () => [
                    { id: 1, request_type: 'access', identity_status: 'verified_manual', created_at: at(NOW - 32 * D), due_at: at(NOW - 2 * D) },
                    { id: 2, request_type: 'deletion', identity_status: 'unverified', created_at: at(NOW - 27 * D), due_at: at(NOW + 3 * D) },
                    { id: 3, request_type: 'access', identity_status: 'verified', created_at: at(NOW - 2 * D), due_at: at(NOW + 28 * D) },
                ],
            },
            incidentStore: {
                listOpenClocks: async () => [
                    { id: 7, kind: 'breach', regimes: ['GDPR'], title: 'Lost laptop', detected_at: at(NOW - H), deadline_at: at(NOW + 71 * H), authority_notified_at: null },
                    { id: 8, kind: 'vulnerability', regimes: ['CRA'], title: 'CVE', detected_at: at(NOW - 20 * H), deadline_at: at(NOW + 4 * H),
                      early_warning_due_at: at(NOW + 4 * H), early_warning_sent_at: null },
                ],
            },
            soaStore: { getStats: async () => ({ total: 93, approved: 9, todo: 61 }) },
            obligationStore: { listObligations: async () => [{ id: 3, kind: 'internal_audit', title: 'Internal audit', due_at: at(NOW - 3 * D) }] },
            aiActAssessmentStore: { listForOrg: async () => [{ target_kind: 'automation', target_id: 'a1', outcome: 'transparency', expires_at: at(NOW - D) }] },
        }),
    });
    const codes = out.items.map(i => i.code);
    assert.deepEqual(codes, [
        'incident_no_breach_recipients',  // fail · critical · detected 1 h ago (newest of the two criticals)
        'dsr_overdue',                    // fail · critical · created 32 d ago
        'obligation_overdue',             // fail · high
        'cra_early_warning_due',          // warn · critical
        'dsr_due_soon',                   // warn · high
        'ai_act_attestation_expired',     // warn · medium · expired yesterday
        'dsr_identity_unverified',        // warn · medium · created 27 d ago
        'soa_todo',                       // warn · medium · no timestamp
    ], 'fail before warn, then severity, then newest');
    assert.ok(!codes.includes('dsr:3'), 'a fresh, verified DSR is not a finding');
    const dsr2 = out.items.filter(i => i.id.startsWith('register:dsr:2:')).map(i => i.code).sort();
    assert.deepEqual(dsr2, ['dsr_due_soon', 'dsr_identity_unverified']);
    for (const it of out.items) {
        assert.equal(it.source, 'register');
        assert.equal(it.action.type, 'navigate');
        assert.equal(it.action.label_key, 'compliance.attention_action_navigate');
    }
    assert.equal(out.items.find(i => i.code === 'dsr_overdue').action.target, '/app/admin/compliance/dsr/1');
    // Art. 12(3) is one calendar month (two further on extension), not 30 / +60 days.
    assert.match(out.items.find(i => i.code === 'dsr_overdue').meta.detail, /one month from receipt, or the extended deadline\) passed 2 day\(s\) ago/);
    assert.match(out.items.find(i => i.code === 'dsr_due_soon').meta.detail, /by two further months/);
    assert.equal(out.items.find(i => i.code === 'cra_early_warning_due').action.target, '/app/admin/compliance/incidents/8');
    assert.equal(out.items.find(i => i.code === 'soa_todo').action.target, '/app/admin/compliance/soa');
    // The ISMS obligations live on Training & competence, not behind an audits tab.
    assert.equal(out.items.find(i => i.code === 'obligation_overdue').action.target, '/app/admin/compliance/training');
    // The attestation target keeps its tab (the client aliases it once that tab moves).
    assert.equal(out.items.find(i => i.code === 'ai_act_attestation_expired').action.target, '/app/admin/compliance/frameworks?tab=per_automation');
    assert.deepEqual(out.items.find(i => i.code === 'cra_early_warning_due').meta.frameworks, [{ regulation: 'CRA', ref: 'Art. 14(2)(a)' }]);
    // An expired self-assessment cites the classification its outcome rests
    // on (Art. 50 for transparency), not the GPAI-provider article 53.
    assert.deepEqual(out.items.find(i => i.code === 'ai_act_attestation_expired').meta.frameworks, [{ regulation: 'AIA', ref: 'Art. 50' }]);
});

test('a CRA severe incident\'s early warning cites Art. 14(4)(a); a vulnerability\'s Art. 14(2)(a)', async () => {
    const out = await attention.build('org1', {
        now: NOW, limit: 50,
        deps: deps({
            complianceStore: { getLatestPerCheck: async () => [], getSettings: async () => ({ breach_recipients: ['dpo@example.org'] }) },
            incidentStore: {
                listOpenClocks: async () => [
                    { id: 8, kind: 'vulnerability', regimes: ['CRA'], detected_at: at(NOW - 20 * H), early_warning_due_at: at(NOW + 4 * H), early_warning_sent_at: null },
                    { id: 9, kind: 'security_incident', regimes: ['CRA'], detected_at: at(NOW - 20 * H), early_warning_due_at: at(NOW + 4 * H), early_warning_sent_at: null },
                ],
            },
        }),
    });
    const early = (id) => out.items.find(i => i.id === `register:incident:${id}:cra_early_warning`);
    assert.deepEqual(early(8).meta.frameworks, [{ regulation: 'CRA', ref: 'Art. 14(2)(a)' }]);
    assert.match(early(8).meta.detail, /actively exploited vulnerability.*Art\. 14\(2\)\(a\)/);
    assert.deepEqual(early(9).meta.frameworks, [{ regulation: 'CRA', ref: 'Art. 14(4)(a)' }]);
    assert.match(early(9).meta.detail, /severe incident.*Art\. 14\(4\)\(a\)/);
    assert.doesNotMatch(early(9).meta.detail, /vulnerability/, 'a severe incident is not an exploited vulnerability');
});

test('an expired AI Act self-assessment cites the article its outcome rests on', async () => {
    const refFor = async (outcome) => {
        const out = await attention.build('org1', {
            now: NOW, limit: 50,
            deps: deps({
                complianceStore: { getLatestPerCheck: async () => [], getSettings: async () => ({}) },
                aiActAssessmentStore: { listForOrg: async () => [{ target_kind: 'agent', target_id: 'g1', outcome, expires_at: at(NOW - D) }] },
            }),
        });
        return out.items.find(i => i.code === 'ai_act_attestation_expired').meta.frameworks[0].ref;
    };
    assert.equal(await refFor('prohibited'), 'Art. 5');
    assert.equal(await refFor('high_risk'), 'Art. 6');
    assert.equal(await refFor('transparency'), 'Art. 50');
    // minimal / not applicable: an Art. 6 "not high-risk" classification.
    assert.equal(await refFor('minimal'), 'Art. 6');
    assert.equal(await refFor(null), 'Art. 6');
});

test('limit splits items from tail; warn_tail_count counts the warns beyond the fold', async () => {
    const rows = [];
    for (let i = 0; i < 8; i++) {
        rows.push({ id: 100 + i, request_type: 'access', identity_status: 'verified', created_at: at(NOW - 27 * D), due_at: at(NOW + 3 * D) });
    }
    rows.push({ id: 200, request_type: 'access', identity_status: 'verified', created_at: at(NOW - 40 * D), due_at: at(NOW - D) });
    const out = await attention.build('org1', { now: NOW, limit: 3, deps: deps({ dsrStore: { listOpenWithDeadlines: async () => rows } }) });
    assert.equal(out.items.length, 3);
    assert.equal(out.total, 9);
    assert.equal(out.tail.length, 6);
    assert.equal(out.warn_tail_count, 6);
    assert.equal(out.fail_tail_count, 0);
    assert.equal(out.items[0].code, 'dsr_overdue');
    assert.deepEqual(Object.keys(out.tail[0]).sort(), ['id', 'severity', 'status', 'title']);
    assert.ok(!('_at' in out.items[0]), 'internal sort key is stripped');
});

test('a source that throws marks complete:false and keeps the other findings', async () => {
    const warn = console.warn;
    console.warn = () => {};
    let out;
    try {
        out = await attention.build('org1', {
            now: NOW,
            deps: deps({
                soaStore: { getStats: async () => { throw new Error('boom'); } },
                obligationStore: { listObligations: async () => [{ id: 1, title: 'Audit', due_at: at(NOW - D) }] },
            }),
        });
    } finally { console.warn = warn; }
    assert.equal(out.complete, false);
    assert.deepEqual(out.items.map(i => i.code), ['obligation_overdue']);
});

test('titles and details never carry an e-mail address (BFSF-441)', async () => {
    const out = await attention.build('org1', {
        now: NOW,
        deps: deps({
            complianceStore: {
                getSettings: async () => ({}),
                getLatestPerCheck: async () => [
                    { check_id: 'GDPR-Art28-subprocessors', status: 'warn', details: 'Operator confirmed by jan.jansen@klant.nl on Monday', run_at: at(NOW) },
                ],
            },
        }),
    });
    const json = JSON.stringify(out);
    assert.ok(!/@klant\.nl/.test(json));
    assert.equal(out.items[0].meta.detail, 'Operator confirmed by [e-mail] on Monday');
    assert.equal(attention.scrubEmails('a@b.co, c.d+e@f.org'), '[e-mail], [e-mail]');
    assert.equal(attention.scrubEmails(null), null);
});

test('limit is clamped to 0…50 and defaults to 5', async () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({ id: i, request_type: 'access', identity_status: 'verified', created_at: at(NOW - 27 * D), due_at: at(NOW + D) }));
    const d = deps({ dsrStore: { listOpenWithDeadlines: async () => rows } });
    assert.equal((await attention.build('o', { now: NOW, deps: d })).items.length, 5);
    assert.equal((await attention.build('o', { now: NOW, deps: d, limit: 500 })).items.length, 50);
    assert.equal((await attention.build('o', { now: NOW, deps: d, limit: -3 })).items.length, 0);
    assert.equal((await attention.build('o', { now: NOW, deps: d, limit: 'abc' })).items.length, 5);
});
