/**
 * compliancePdf — every builder must return real PDF bytes and a stable
 * content hash. Run: node --test server/utils/compliancePdf.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { buildComplianceReport, buildRopaPdf, buildDpiaPdf, buildSoaPdf, buildClauseConformityPdf, buildRiskRegisterPdf, buildPolicyPackPdf, hashData } = require('./compliancePdf');

const reportData = {
    orgName: 'Acme',
    generatedAt: '2026-07-31T10:00:00Z',
    overall: { score: 88, pass: 12, warn: 2, fail: 1, na: 0 },
    gdpr: { score: 90 }, aia: { score: 80 },
    verificationSummary: { automated: { total: 9, pass: 8 }, attestation: { total: 5, pass: 4 }, hybrid: { total: 1, pass: 1 } },
    rows: [
        { regulation: 'GDPR', article: '32', severity: 'critical', verification: 'automated', title: 'Encryption at rest', status: 'pass', details: 'ok', evidence_hash: 'abc123' },
        { regulation: 'AIA', article: '50', severity: 'medium', verification: 'automated', title: 'AI disclosure', status: 'warn', details: '1 agent missing disclosure' },
    ],
};

const ropaData = {
    controller: { name: 'Acme', dpo_name: 'Jane', dpo_email: 'jane@acme.example' },
    legal_bases: ['contract'], data_residency: 'eu',
    generated_at: '2026-07-31T10:00:00Z',
    last_reviewed_at: null,
    scc_confirmed_operators: [{ operator: 'openai' }],
    activities: [{ activity_id: 'a1', name: 'Helper', purpose: 'support', data_categories: ['chat'], data_subjects: ['users'], retention: '365 days', transfers: ['openai'], security_measures: ['TLS'] }],
    processors: [{ operator: 'openai', country_code: 'US', is_eu: false, calls: 3, last_seen: '2026-07-30T00:00:00Z' }],
};

test('report builder returns PDF bytes + the data hash', async () => {
    const { buffer, hash } = await buildComplianceReport(reportData);
    assert.ok(Buffer.isBuffer(buffer) && buffer.length > 500, 'non-trivial buffer');
    assert.strictEqual(buffer.subarray(0, 5).toString(), '%PDF-');
    assert.strictEqual(hash, hashData(reportData));
    assert.match(hash, /^[a-f0-9]{64}$/);
});

test('ropa builder returns PDF bytes', async () => {
    const { buffer, hash } = await buildRopaPdf(ropaData);
    assert.strictEqual(buffer.subarray(0, 5).toString(), '%PDF-');
    assert.strictEqual(hash, hashData(ropaData));
});

test('dpia builder returns PDF bytes and survives sparse rows', async () => {
    const { buffer } = await buildDpiaPdf({
        agentName: 'HR screener',
        dpia: { mode: 'questionnaire', risk_level: 'medium', approved_by: 'u1', approved_at: '2026-07-01T00:00:00Z', answers: { purpose: 'screening', automated_decisions: true }, mitigations: ['PII redaction'] },
    });
    assert.strictEqual(buffer.subarray(0, 5).toString(), '%PDF-');
    const sparse = await buildDpiaPdf({ agentName: 'X', dpia: { mode: 'attestation' } });
    assert.strictEqual(sparse.buffer.subarray(0, 5).toString(), '%PDF-');
});

test('SoA builder renders a 93-row landscape table with page breaks', async () => {
    const rows = Array.from({ length: 93 }, (_, i) => ({
        ref: `A.5.${i + 1}`,
        title: `Control number ${i + 1} with a reasonably long name`,
        applicable: i % 9 === 0 ? 'no' : 'yes',
        source: ['auto', 'connector', 'attest', 'inherited'][i % 4],
        status: ['todo', 'reviewed', 'approved'][i % 3],
        check: i % 4 === 0 ? 'pass (2)' : '—',
        owner: i % 5 === 0 ? 'Jan Janssen' : '—',
        justification: i % 9 === 0
            ? 'Excluded: physical protection inherited from the IaaS provider, verified via their certification.'
            : 'Applies — enforced by the platform and reviewed quarterly.',
    }));
    const data = { orgName: 'Acme', generatedAt: '2026-07-31T10:00:00Z', rows, stats: { total: 93, approved: 31, reviewed: 31, todo: 31, excluded: 10 } };
    const { buffer, hash } = await buildSoaPdf(data);
    assert.strictEqual(buffer.subarray(0, 5).toString(), '%PDF-');
    assert.ok(buffer.length > 5000, 'a 93-row table is a multi-page document');
    assert.strictEqual(hash, hashData({ orgName: data.orgName, rows: data.rows, stats: data.stats }));
});

test('clause conformity builder renders all statuses incl. not_recorded', async () => {
    const data = {
        orgName: 'Acme', generatedAt: '2026-07-31T10:00:00Z',
        clauses: [
            { clause: '4', title: 'Context', status: 'partial', evidence: ['Scope in policy v1'], gap: 'Interested parties external' },
            { clause: '8', title: 'Operation', status: 'in_place', evidence: ['Checks running'] },
            { clause: '9', title: 'Performance evaluation', status: 'not_recorded', evidence: [], gap: 'No audit yet' },
        ],
    };
    const { buffer, hash } = await buildClauseConformityPdf(data);
    assert.strictEqual(buffer.subarray(0, 5).toString(), '%PDF-');
    assert.strictEqual(hash, hashData({ orgName: data.orgName, clauses: data.clauses }));
});

test('risk register builder renders bands and treatments', async () => {
    const rows = [
        { title: 'Admin account takeover', category: 'confidentiality', score: '2×5=10', score_num: 10, status: 'treating', owner: 'Jan', treatments: 'mitigate: enforce MFA', accepted: '—' },
        { title: 'Provider outage', category: 'availability', score: '3×3=9', score_num: 9, status: 'accepted', owner: '—', treatments: '—', accepted: '2026-07-31' },
    ];
    const { buffer } = await buildRiskRegisterPdf({ orgName: 'Acme', generatedAt: '2026-07-31T10:00:00Z', rows, stats: { open: 1, high: 1, accepted: 1, closed: 0 } });
    assert.strictEqual(buffer.subarray(0, 5).toString(), '%PDF-');
});

test('policy pack builder renders markdown bodies per document', async () => {
    const documents = [
        { slug: 'infosec', title: 'Information Security Policy', version: 2, sha256: 'a'.repeat(64), published_at: '2026-07-01T00:00:00Z', body: '# Purpose\n\nProtect information.\n\n## Policy\n\n- Rule one\n- Rule **two**\n' },
        { slug: 'access', title: 'Access Control Policy', version: 1, sha256: 'b'.repeat(64), published_at: '2026-07-02T00:00:00Z', body: '## Scope\n\nEveryone.' },
    ];
    const { buffer, hash } = await buildPolicyPackPdf({ orgName: 'Acme', generatedAt: '2026-07-31T10:00:00Z', documents });
    assert.strictEqual(buffer.subarray(0, 5).toString(), '%PDF-');
    assert.match(hash, /^[a-f0-9]{64}$/);
});
