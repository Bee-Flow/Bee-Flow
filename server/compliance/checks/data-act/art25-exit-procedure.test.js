// @typecheck
/**
 * Data Act Art. 25 exit procedure: relevance gate, document unpublished →
 * fail, published but never exercised → warn, stale attested test → warn,
 * recent real export (portable kinds only) or fresh test → pass, missing
 * tables → warn "not provisioned yet", evidence without personal data. The
 * export stamps are read from a real Postgres.
 *
 * Run: cd server && node --test compliance/checks/data-act/art25-exit-procedure.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { installResolveStub } = require('../../../testUtils/stubRequire');

const { usePglitePool } = require('../../../testUtils/pglitePool');
const { ladderPglite } = require('../../../testUtils/pgliteTemplate');
const { failReads } = require('../../../testUtils/pgliteFaults');
const { insertRow } = require('../../../testUtils/pgliteSeed');

const DAY = 86400e3;
const state = { settings: {}, doc: null, docError: null };

// The export stamps are read from compliance_evidence on the boot ladder's
// schema on PGlite (testUtils/pgliteTemplate.js) behind db.js's pool. The
// settings, the published document and the export registry are stubbed: they
// are this check's inputs, with stores and tests of their own.
const { pg, close } = usePglitePool(ladderPglite());
const fakeComplianceStore = { async getSettings() { return state.settings; } };
const fakeIsmsDocStore = {
    async getPublishedBody(orgId, slug) {
        assert.equal(orgId, 'org-1');
        assert.equal(slug, 'exit-procedure');
        if (state.docError) throw state.docError;
        return state.doc;
    },
};
const fakeRegistry = { portableKinds: () => ['automations', 'datatables', 'cms_sites', 'memories'] };

const restore = installResolveStub({
    '../../../stores/complianceStore': fakeComplianceStore,
    '../../../stores/ismsDocStore': fakeIsmsDocStore,
    '../../dataPortability/exportRegistry': fakeRegistry,
});
const check = require('./art25-exit-procedure');
test.after(async () => { restore(); await close(); });

/**
 * `n` export stamps of `kind`, the newest `msAgo` old.
 * @param {string} kind @param {number} n @param {number} msAgo @param {Record<string, unknown>} [over]
 */
async function stamps(kind, n, msAgo, over = {}) {
    for (let i = 0; i < n; i++) {
        await insertRow(pg, 'compliance_evidence', {
            organization_id: 'org-1', check_id: 'DATA_ACT-Art25-exit-procedure', subject_type: 'export',
            payload: { action: 'data_export_performed', kind }, payload_hash: 'h', hash: 'h',
            captured_at: new Date(Date.now() - msAgo - i * DAY).toISOString(), ...over,
        });
    }
}

const PUBLISHED = { version: 2, title: 'Exit procedure', body: 'Step 1: export everything. Contact dpo@example.org.', sha256: 'abc123', published_at: '2026-03-01T10:00:00Z' };
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();

test.beforeEach(async () => {
    state.settings = { framework_relevance: {}, exit_procedure_tested_at: null, exit_procedure_tested_by: null };
    state.doc = PUBLISHED;
    state.docError = null;
    await pg.exec('DELETE FROM compliance_evidence');
});

test('module shape and the DORA re-tag', () => {
    assert.equal(check.id, 'DATA_ACT-Art25-exit-procedure');
    assert.equal(check.regulation, 'DATA_ACT');
    assert.equal(check.severity, 'high');
    assert.equal(check.verification, 'hybrid');
    assert.deepEqual(check.frameworks, [{ regulation: 'DORA', ref: 'Art. 28(8)' }]);
    assert.equal(check.remediationLink, 'admin/compliance/policies');
    assert.equal(check.titleKey, 'compliance.check_data_act_exit_procedure_title');
    assert.equal(check._test.DOC_SLUG, 'exit-procedure');
    assert.equal(check._test.STAMP_ACTION, 'data_export_performed');
});

test('relevance gate', async () => {
    state.settings.framework_relevance = { data_act: 'not_relevant' };
    const r = await check.evaluate('org-1');
    assert.equal(r.status, 'not_applicable');
    assert.deepEqual(r.evidence, { relevance: 'not_relevant' });
});

test('document not published (or seed missing) → fail before anything else is read', async () => {
    state.doc = null;
    const r = await check.evaluate('org-1');
    assert.equal(r.status, 'fail');
    assert.deepEqual(r.evidence.document, { slug: 'exit-procedure', published: false });
    assert.match(r.details, /No published exit-procedure document/);
});

test('missing ISMS or evidence tables → warn "not provisioned yet", never a throw', async () => {
    state.docError = Object.assign(new Error('missing'), { code: '42P01' });
    let r = await check.evaluate('org-1');
    assert.equal(r.status, 'warn');
    assert.match(r.details, /not provisioned yet/);
    assert.equal(r.evidence.documents_provisioned, false);
    state.docError = null;
    let undo = await failReads(pg, 'compliance_evidence', '42703', 'no such column');
    try { r = await check.evaluate('org-1'); } finally { await undo(); }
    assert.equal(r.status, 'warn');
    assert.match(r.details, /not provisioned yet/);
    assert.equal(r.evidence.exports_provisioned, false);
    undo = await failReads(pg, 'compliance_evidence', '08006', 'connection reset');
    try {
        await assert.rejects(() => check.evaluate('org-1'), /connection reset/, 'other errors surface to the runner');
    } finally { await undo(); }
});

test('only this org\'s export stamps of this check, subject and action, inside the window, count', async () => {
    await stamps('automations', 1, 2 * DAY, { organization_id: 'org-2' });
    await stamps('automations', 1, 2 * DAY, { check_id: 'OTHER-check' });
    await stamps('automations', 1, 2 * DAY, { subject_type: 'file' });
    await stamps('automations', 1, 2 * DAY, { payload: { action: 'something_else', kind: 'automations' } });
    await stamps('automations', 1, 400 * DAY);
    let r = await check.evaluate('org-1');
    assert.equal(r.evidence.portable_exports, 0);
    await stamps('datatables', 2, 2 * DAY);
    r = await check.evaluate('org-1');
    assert.equal(r.evidence.portable_exports, 2);
    assert.deepEqual(r.evidence.exports_by_kind, { datatables: 2 }, 'grouped by kind');
});

test('published but never exercised → warn; PDF renders do not count as an export', async () => {
    let r = await check.evaluate('org-1');
    assert.equal(r.status, 'warn');
    assert.match(r.details, /published but never exercised/);
    assert.equal(r.evidence.portable_exports, 0);
    assert.equal(r.evidence.last_export_at, null);
    await stamps('ai_webpages', 3, 2 * DAY);
    r = await check.evaluate('org-1');
    assert.equal(r.status, 'warn');
    assert.equal(r.evidence.render_only_exports, 3);
    assert.equal(r.evidence.portable_exports, 0);
    assert.match(r.details, /3 PDF render\(s\) do not count/);
});

test('published, attested test older than a year and no export → warn (stale)', async () => {
    state.settings.exit_procedure_tested_at = iso(400 * DAY);
    state.settings.exit_procedure_tested_by = 'user-7';
    const r = await check.evaluate('org-1');
    assert.equal(r.status, 'warn');
    assert.equal(r.evidence.test_age_days, 400);
    assert.equal(r.evidence.tested_by_recorded, true);
    assert.match(r.details, /last attested export test is 400 days old/);
});

test('a real export of a portable kind within the window → pass, with the latest timestamp', async () => {
    await stamps('automations', 2, 30 * DAY);
    await stamps('datatables', 5, 3 * DAY);
    await stamps('ai_webpages', 1, 1 * DAY);
    const r = await check.evaluate('org-1');
    assert.equal(r.status, 'pass');
    assert.equal(r.evidence.portable_exports, 7);
    assert.equal(r.evidence.render_only_exports, 1);
    assert.deepEqual(r.evidence.exports_by_kind, { automations: 2, datatables: 5, ai_webpages: 1 });
    assert.equal(r.evidence.last_export_at.slice(0, 10), iso(3 * DAY).slice(0, 10), 'the render does not move the last-export marker');
    assert.match(r.details, /Exit procedure v2 is published and exercised: 7 real export\(s\)/);
});

test('a fresh attested test alone → pass; both → both named', async () => {
    state.settings.exit_procedure_tested_at = iso(10 * DAY);
    let r = await check.evaluate('org-1');
    assert.equal(r.status, 'pass');
    assert.match(r.details, /a full export test attested 10 day\(s\) ago/);
    await stamps('memories', 1, 1 * DAY);
    r = await check.evaluate('org-1');
    assert.equal(r.status, 'pass');
    assert.match(r.details, /1 real export\(s\).* and a full export test attested 10 day\(s\) ago/);
});

test('evidence names the document version and hash, never its body, the attester or an e-mail address', async () => {
    state.settings.exit_procedure_tested_at = iso(10 * DAY);
    state.settings.exit_procedure_tested_by = 'dpo@example.org';
    await stamps('automations', 1, 1 * DAY);
    const r = await check.evaluate('org-1');
    const blob = JSON.stringify(r);
    assert.ok(!/@/.test(blob), `no e-mail address: ${blob}`);
    assert.ok(!/Step 1/.test(blob), 'document body stays out of the evidence');
    assert.deepEqual(r.evidence.document, { slug: 'exit-procedure', version: 2, sha256: 'abc123', published_at: '2026-03-01T10:00:00Z' });
    assert.equal(r.evidence.tested_by_recorded, true);
});
