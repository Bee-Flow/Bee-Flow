'use strict';

/**
 * routes/compliance/isoAuditPack — the auditor hand-over bundle.
 *
 * The property under test: an artefact that could NOT be built is recorded in
 * the bundle, and is distinguishable from an artefact that is legitimately
 * absent because the register is empty. An evidence pack whose gaps cannot be
 * told apart from its failures is not evidence.
 *
 * Run: cd server && node --test --test-force-exit routes/compliance/isoAuditPack.test.js
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const JSZip = require('jszip');

const { installResolveStub } = require('../../testUtils/stubRequire');

const state = {
    soaThrows: null,
    clauseThrows: null,
    chainThrows: null,
    risks: [],
    policyDocs: [],
    soaEvidence: [],
    evidence: [],
};

const pdfStub = (name) => async () => ({ buffer: Buffer.from(`%PDF ${name}`), hash: `sha-${name}` });

const STUBS = {
    '../../stores/complianceStore': {
        getLatestPerCheck: async () => [],
        addEvidence: async (row) => { state.evidence.push(row); return { id: 1 }; },
    },
    '../../stores/soaStore': {
        listEntries: async () => { if (state.soaThrows) throw state.soaThrows; return []; },
        getStats: async () => ({ applicable: 0 }),
    },
    '../../stores/ismsDocStore': {
        listDocs: async () => state.policyDocs,
        getPublishedBody: async (_o, slug) => ({ title: slug, version: 1, sha256: 'x', published_at: null, body: 'b' }),
    },
    '../../stores/userStore': {
        getOrganization: async (id) => ({ id, name: 'Org A' }),
        getUser: async () => null,
    },
    '../../compliance/iso/controls': { CONTROLS: [{ ref: 'A.5.1', titleKey: 'k', bucket: 'organisational' }] },
    '../../compliance/registry': { get: () => null },
    '../../compliance/score': { computeScore: () => 100, REGULATIONS: ['GDPR'] },
    '../../db': { getAll: async () => { if (state.chainThrows) throw state.chainThrows; return []; } },
    '../../auth/permissions': {
        requireAuth: (req, _res, next) => next(),
        requirePermission: () => (req, _res, next) => next(),
    },
    './shared': {
        resolveOrgId: async () => 'orgA',
        REGULATION_KEY: { GDPR: 'gdpr' },
        computeVerificationSummary: () => ({}),
        _riskStore: () => ({
            listRisks: async () => state.risks,
            listTreatments: async () => [],
            getStats: async () => ({ open: state.risks.length }),
        }),
        _recordSoaEvidence: async (orgId, subjectId, payload) => { state.soaEvidence.push({ orgId, subjectId, payload }); },
        _buildClauseConformity: async () => { if (state.clauseThrows) throw state.clauseThrows; return [{ clause: '4', title: 'Context' }]; },
    },
    '../../utils/compliancePdf': {
        buildComplianceReport: pdfStub('report'),
        buildClauseConformityPdf: pdfStub('clauses'),
        buildSoaPdf: pdfStub('soa'),
        buildRiskRegisterPdf: pdfStub('risks'),
        buildPolicyPackPdf: pdfStub('policies'),
    },
    '../../i18n/defaults/en': { GUI_DEFAULTS: {} },
};

const restore = installResolveStub(STUBS);
const router = require('./isoAuditPack');

const app = express();
app.use('/api/compliance', router);
let server;
let base;

before(async () => {
    await new Promise((r) => { server = app.listen(0, r); });
    base = `http://127.0.0.1:${server.address().port}/api/compliance`;
});
after(async () => {
    if (server) await new Promise((r) => server.close(r));
    restore();
});

beforeEach(() => {
    state.soaThrows = null;
    state.clauseThrows = null;
    state.chainThrows = null;
    state.risks = [];
    state.policyDocs = [];
    state.soaEvidence = [];
    state.evidence = [];
});

async function fetchBundle() {
    const res = await fetch(`${base}/iso/evidence-bundle.zip`);
    assert.strictEqual(res.status, 200, 'the bundle is still produced');
    const zip = await JSZip.loadAsync(Buffer.from(await res.arrayBuffer()));
    const readme = await zip.file('README.txt').async('string');
    const manifest = JSON.parse(await zip.file('manifest.json').async('string'));
    return { zip, readme, manifest, names: Object.keys(zip.files) };
}

test('a clean export declares itself complete and carries no failures', async () => {
    const { manifest, readme, names } = await fetchBundle();
    assert.strictEqual(manifest.complete, true);
    assert.deepStrictEqual(manifest.failed, []);
    assert.ok(names.includes('statement-of-applicability.pdf'));
    assert.ok(names.includes('evidence-chain.json'));
    assert.match(readme, /Complete: every artefact in this bundle was built successfully\./);
});

test('an artefact that could not be READ is recorded, not silently dropped', async () => {
    const err = new Error('relation "compliance_soa" does not exist');
    err.code = '42P01';
    state.soaThrows = err;

    const { manifest, readme, names } = await fetchBundle();

    assert.ok(!names.includes('statement-of-applicability.pdf'), 'the artefact really is missing');
    assert.strictEqual(manifest.complete, false);
    assert.deepStrictEqual(manifest.failed, [
        { file: 'statement-of-applicability.pdf', reason: 'build_failed', error_type: '42P01' },
    ]);
    // The human-readable half has to say it too — an auditor reads the README.
    assert.match(readme, /INCOMPLETE — 1 artefact\(s\) could not be built/);
    assert.match(readme, /statement-of-applicability\.pdf {2}build_failed \(42P01\)/);
    // Everything else still shipped: the bundle is produced, not abandoned.
    assert.ok(names.includes('compliance-report.pdf'));
    assert.ok(names.includes('evidence-chain.json'));
    // ...and the chain records that this export was partial.
    const stamp = state.soaEvidence.find(e => e.subjectId === 'evidence-bundle.zip');
    assert.strictEqual(stamp.payload.complete, false);
    assert.deepStrictEqual(stamp.payload.failed, [{ file: 'statement-of-applicability.pdf', reason: 'build_failed' }]);
});

test('the error text never reaches the bundle — only its class', async () => {
    // A Postgres error routinely quotes the row value that broke it; BFSF-441
    // says none of that may travel to an external auditor.
    const err = new Error('duplicate key value violates unique constraint: jan@example.org');
    err.code = '23505';
    state.clauseThrows = err;

    const { manifest, readme } = await fetchBundle();
    const asText = JSON.stringify(manifest) + readme;
    assert.ok(!asText.includes('jan@example.org'));
    assert.ok(!asText.includes('duplicate key'));
    assert.deepStrictEqual(manifest.failed, [
        { file: 'isms-clause-conformity.pdf', reason: 'build_failed', error_type: '23505' },
    ]);
});

test('an EMPTY register is not a failure — the two states stay distinguishable', async () => {
    // No risks and no published policies: those artefacts are absent by
    // definition, and must not be reported as failures.
    const { manifest, names } = await fetchBundle();
    assert.ok(!names.includes('risk-register.pdf'));
    assert.ok(!names.includes('isms-policy-pack.pdf'));
    assert.deepStrictEqual(manifest.failed, [], 'nothing to report — the registers are simply empty');
    assert.strictEqual(manifest.complete, true);

    // With content they appear, which is what makes the distinction meaningful.
    state.risks = [{ id: 1, title: 'r', likelihood: 2, impact: 3, score: 6, status: 'open' }];
    state.policyDocs = [{ slug: 'isms-policy', status: 'published', current_version: 1 }];
    const second = await fetchBundle();
    assert.ok(second.names.includes('risk-register.pdf'));
    assert.ok(second.names.includes('isms-policy-pack.pdf'));
});

test('every failing artefact is listed, and the failures accumulate', async () => {
    state.soaThrows = new Error('soa down');
    state.clauseThrows = new Error('clauses down');
    state.chainThrows = new Error('chain down');
    const { manifest, names } = await fetchBundle();
    assert.deepStrictEqual(manifest.failed.map(f => f.file).sort(), [
        'evidence-chain.json', 'isms-clause-conformity.pdf', 'statement-of-applicability.pdf',
    ]);
    for (const f of manifest.failed) assert.strictEqual(f.error_type, 'Error', 'no code → the class');
    assert.ok(names.includes('compliance-report.pdf'), 'the bundle is still produced');
});
