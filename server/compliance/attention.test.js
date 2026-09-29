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

test('per-source rows produce one item per subject; check ids with parentheses are URL-encoded in the target', async () => {
    const out = await attention.build('org1', {
        now: NOW,
        deps: deps({
            frameworkPolicy: { activeRegulations: async () => new Set(['AIA', 'NIS2']) },
            complianceStore: {
                getSettings: async () => ({}),
                getLatestPerCheck: async () => [
                    { check_id: 'AIA-Art50-ai-disclosure', status: 'warn', scope_id: 'agent-1', details: 'no disclosure', run_at: at(NOW - H) },
                    { check_id: 'AIA-Art50-ai-disclosure', status: 'warn', scope_id: 'agent-2', details: 'no disclosure', run_at: at(NOW) },
                    { check_id: 'NIS2-Art21(2)(j)-admin-mfa', status: 'fail', run_at: at(NOW) },
                    { check_id: 'NIS2-Art21(2)-policy-coverage', status: 'warn', run_at: at(NOW - 3 * H) },
                ],
            },
        }),
    });
    assert.deepEqual(out.items.map(i => i.id), [
        'check:NIS2-Art21(2)(j)-admin-mfa:global',
        'check:AIA-Art50-ai-disclosure:agent-2',
        'check:AIA-Art50-ai-disclosure:agent-1',
        'check:NIS2-Art21(2)-policy-coverage:global',
    ], 'fail first, then severity, then newest');
    assert.equal(out.items[0].action.target, '/app/admin/security/users', 'remediation links leave the hub');
    assert.equal(out.items[1].meta.scope_id, 'agent-2');
    assert.equal(out.items[3].action.type, 'open_fix');
    assert.equal(out.items[3].action.target, `/app/admin/compliance/nis2/${encodeURIComponent('NIS2-Art21(2)-policy-coverage')}`,
        'no remediation link → the check row in its framework page, id passed through encodeURIComponent (parentheses are legal path chars)');
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
    assert.equal(out.items.find(i => i.code === 'cra_early_warning_due').action.target, '/app/admin/compliance/incidents/8');
    assert.equal(out.items.find(i => i.code === 'soa_todo').action.target, '/app/admin/compliance/soa');
    assert.deepEqual(out.items.find(i => i.code === 'cra_early_warning_due').meta.frameworks, [{ regulation: 'CRA', ref: 'Art. 14(2)(a)' }]);
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
