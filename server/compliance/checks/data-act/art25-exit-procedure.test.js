/**
 * Data Act Art. 25 exit procedure: relevance gate, document unpublished →
 * fail, published but never exercised → warn, stale attested test → warn,
 * recent real export (portable kinds only) or fresh test → pass, missing
 * tables → warn "not provisioned yet", evidence without personal data.
 *
 * Run: cd server && node --test --test-force-exit compliance/checks/data-act/art25-exit-procedure.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { installResolveStub } = require('../../../testUtils/stubRequire');

const DAY = 86400e3;
const state = { settings: {}, doc: null, docError: null, stamps: [], stampsError: null, lastSql: null, lastParams: null };
const flat = (s) => String(s).replace(/\s+/g, ' ').trim();

const fakeDb = {
    async getAll(sql, params) {
        state.lastSql = flat(sql);
        state.lastParams = params;
        if (state.stampsError) throw state.stampsError;
        return state.stamps;
    },
    async getOne() { return null; },
    async run() { return { rowCount: 0 }; },
    async exec() {},
};
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
    '../../../db': fakeDb,
    '../../../stores/complianceStore': fakeComplianceStore,
    '../../../stores/ismsDocStore': fakeIsmsDocStore,
    '../../dataPortability/exportRegistry': fakeRegistry,
});
const check = require('./art25-exit-procedure');
test.after(() => restore());

const PUBLISHED = { version: 2, title: 'Exit procedure', body: 'Step 1: export everything. Contact dpo@example.org.', sha256: 'abc123', published_at: '2026-03-01T10:00:00Z' };
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();

test.beforeEach(() => {
    state.settings = { framework_relevance: {}, exit_procedure_tested_at: null, exit_procedure_tested_by: null };
    state.doc = PUBLISHED;
    state.docError = null;
    state.stamps = [];
    state.stampsError = null;
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
    assert.equal(state.lastSql, null, 'no evidence query when the document is missing');
    assert.match(r.details, /No published exit-procedure document/);
});

test('missing ISMS or evidence tables → warn "not provisioned yet", never a throw', async () => {
    state.docError = Object.assign(new Error('missing'), { code: '42P01' });
    let r = await check.evaluate('org-1');
    assert.equal(r.status, 'warn');
    assert.match(r.details, /not provisioned yet/);
    assert.equal(r.evidence.documents_provisioned, false);
    state.docError = null;
    state.stampsError = Object.assign(new Error('no such column'), { code: '42703' });
    r = await check.evaluate('org-1');
    assert.equal(r.status, 'warn');
    assert.match(r.details, /not provisioned yet/);
    assert.equal(r.evidence.exports_provisioned, false);
    state.stampsError = new Error('connection reset');
    await assert.rejects(() => check.evaluate('org-1'), /connection reset/, 'other errors surface to the runner');
});

test('the stamp query is org-scoped, filtered on this check id, the export subject and the action, inside the window', async () => {
    await check.evaluate('org-1');
    assert.deepEqual(state.lastParams, ['org-1', 'DATA_ACT-Art25-exit-procedure', 'data_export_performed']);
    assert.match(state.lastSql, /FROM compliance_evidence WHERE organization_id = \$1 AND check_id = \$2 AND subject_type = 'export' AND payload->>'action' = \$3/);
    assert.match(state.lastSql, /INTERVAL '365 days'/);
    assert.match(state.lastSql, /GROUP BY payload->>'kind'/);
});

test('published but never exercised → warn; PDF renders do not count as an export', async () => {
    let r = await check.evaluate('org-1');
    assert.equal(r.status, 'warn');
    assert.match(r.details, /published but never exercised/);
    assert.equal(r.evidence.portable_exports, 0);
    assert.equal(r.evidence.last_export_at, null);
    state.stamps = [{ kind: 'ai_webpages', exports: 3, last_at: iso(2 * DAY) }];
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
    state.stamps = [
        { kind: 'automations', exports: 2, last_at: new Date(Date.now() - 30 * DAY) },
        { kind: 'datatables', exports: '5', last_at: iso(3 * DAY) },
        { kind: 'ai_webpages', exports: 1, last_at: iso(1 * DAY) },
    ];
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
    state.stamps = [{ kind: 'memories', exports: 1, last_at: iso(1 * DAY) }];
    r = await check.evaluate('org-1');
    assert.equal(r.status, 'pass');
    assert.match(r.details, /1 real export\(s\).* and a full export test attested 10 day\(s\) ago/);
});

test('evidence names the document version and hash, never its body, the attester or an e-mail address', async () => {
    state.settings.exit_procedure_tested_at = iso(10 * DAY);
    state.settings.exit_procedure_tested_by = 'dpo@example.org';
    state.stamps = [{ kind: 'automations', exports: 1, last_at: iso(1 * DAY) }];
    const r = await check.evaluate('org-1');
    const blob = JSON.stringify(r);
    assert.ok(!/@/.test(blob), `no e-mail address: ${blob}`);
    assert.ok(!/Step 1/.test(blob), 'document body stays out of the evidence');
    assert.deepEqual(r.evidence.document, { slug: 'exit-procedure', version: 2, sha256: 'abc123', published_at: '2026-03-01T10:00:00Z' });
    assert.equal(r.evidence.tested_by_recorded, true);
});
