// @typecheck
/**
 * CRA Art. 14 clocks: relevance/role gates, empty register, overdue → fail,
 * due-soon / missing preparation → warn, full readiness → pass, store helper
 * preferred over the raw SELECT, and evidence free of personal data. The
 * raw SELECT runs on a real Postgres.
 *
 * Run: cd server && node --test compliance/checks/cra/art14-vuln-reporting-clocks.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { installResolveStub } = require('../../../testUtils/stubRequire');

const { usePglitePool } = require('../../../testUtils/pglitePool');
const { ladderPglite } = require('../../../testUtils/pgliteTemplate');
const { failReads } = require('../../../testUtils/pgliteFaults');
const { insertRow } = require('../../../testUtils/pgliteSeed');

const H = 3600e3;
const state = {
    settings: {},
    listOpenClocks: undefined, // set to a function to exercise the store path
    policyBody: null,
};

// The register runs on the boot ladder's schema on PGlite
// (testUtils/pgliteTemplate.js) behind db.js's pool. The settings, the policy
// text and the store helper are stubbed: they are this check's inputs, with
// stores and tests of their own.
const { pg, close } = usePglitePool(ladderPglite());
const fakeComplianceStore = { async getSettings() { return state.settings; } };
const fakeIncidentStore = {
    get listOpenClocks() { return state.listOpenClocks; },
    async getDeadlineStats() { return { open: 0, overdue_unnotified: 0, nearing_deadline: 0 }; },
};
const fakeIsmsDocStore = {
    async getPublishedBody(orgId, slug) {
        assert.equal(slug, 'incident-response');
        return state.policyBody === null ? null : { body: state.policyBody, version: 1 };
    },
};

const restore = installResolveStub({
    '../../../stores/complianceStore': fakeComplianceStore,
    '../../../stores/incidentStore': fakeIncidentStore,
    '../../../stores/ismsDocStore': fakeIsmsDocStore,
});
const check = require('./art14-vuln-reporting-clocks');
test.after(async () => { restore(); await close(); });

/** @param {...Record<string, any>} rows incident rows of org1 unless they say otherwise */
async function incidents(...rows) {
    for (const r of rows) await insertRow(pg, 'compliance_incidents', { organization_id: 'org1', title: 'x', ...r });
}

const READY = {
    cra_role: 'manufacturer',
    cra_reporting_channel: 'MijnNCSC',
    psirt_contact_email: 'psirt@example.org',
    framework_relevance: { cra: 'relevant' },
};
const GOOD_POLICY = 'Incidents are triaged within 4 hours. Vulnerability reports received via the PSIRT mailbox follow the same flow.';

test.beforeEach(async () => {
    state.settings = { ...READY };
    state.listOpenClocks = undefined;
    state.policyBody = GOOD_POLICY;
    await pg.exec('DELETE FROM compliance_incidents');
});

/** An overdue CRA incident: the verdict says whether the register was read at all. */
const overdueVuln = () => incidents({ kind: 'vulnerability', status: 'open', detected_at: new Date(Date.now() - 100 * H).toISOString() });

function noPersonalData(result) {
    const blob = JSON.stringify(result.evidence) + (result.details || '');
    assert.ok(!/@/.test(blob), `evidence/details must not carry an e-mail address: ${blob}`);
    assert.ok(!/psirt@|example\.org/.test(blob));
}

test('module shape: id, home regulation, cross-framework tags, critical severity', () => {
    assert.equal(check.id, 'CRA-Art14-vuln-reporting-clocks');
    assert.equal(check.regulation, 'CRA');
    assert.equal(check.severity, 'critical');
    assert.equal(check.scope, 'global');
    assert.equal(check.verification, 'automated');
    assert.deepEqual(check.frameworks, [{ regulation: 'NIS2', ref: 'Art. 23' }, { regulation: 'ISO27001', ref: 'A.5.24' }]);
    assert.equal(check.remediationLink, 'admin/compliance/vulnerabilities');
    assert.ok(!check.remediationLink.includes('?'));
});

test('relevance gate: CRA marked not relevant → not_applicable with the relevance marker', async () => {
    state.settings = { ...READY, framework_relevance: { cra: 'not_relevant' } };
    const r = await check.evaluate('org1');
    assert.equal(r.status, 'not_applicable');
    assert.deepEqual(r.evidence, { relevance: 'not_relevant' });
});

test('role gate: a user-only organisation has no Art. 14 duty', async () => {
    state.settings = { ...READY, cra_role: 'user_only' };
    const r = await check.evaluate('org1');
    assert.equal(r.status, 'not_applicable');
    assert.equal(r.evidence.cra_role, 'user_only');
});

test('role gate: an importer/distributor has no Art. 14 reporting clock', async () => {
    state.settings = { ...READY, cra_role: 'distributor' };
    await overdueVuln();
    const r = await check.evaluate('org1');
    assert.equal(r.status, 'not_applicable');
    assert.equal(r.evidence.cra_role, 'distributor');
    assert.match(r.details, /Art\. 19 and 20/);
});

test('role gate: an undeclared role keeps the clocks (the conservative reading)', async () => {
    state.settings = { ...READY, cra_role: null };
    await overdueVuln();
    const r = await check.evaluate('org1');
    assert.equal(r.status, 'fail', 'the register is read and its clocks count');
});

test('empty register with full preparation → pass; only org1\'s open CRA incidents count', async () => {
    const old = new Date(Date.now() - 100 * H).toISOString();
    await incidents(
        { organization_id: 'org2', kind: 'vulnerability', status: 'open', detected_at: old },
        { kind: 'vulnerability', status: 'closed', detected_at: old },
        { kind: 'breach', regimes: ['GDPR'], status: 'open', detected_at: old },
    );
    const r = await check.evaluate('org1');
    assert.equal(r.status, 'pass');
    assert.equal(r.evidence.open_cra_incidents, 0);
    assert.equal(r.evidence.reporting_channel_set, true);
    assert.equal(r.evidence.psirt_contact_set, true);
    assert.equal(r.evidence.procedure_mentions_vulns, true);
    await incidents({ kind: 'security_incident', regimes: ['NIS2', 'CRA'], status: 'open', detected_at: old });
    assert.equal((await check.evaluate('org1')).evidence.open_cra_incidents, 1, 'a CRA-regime incident of another kind counts');
    noPersonalData(r);
});

test('register without the CRA columns yet → warn "not provisioned yet", never a throw', async () => {
    for (const code of ['42703', '42P01']) {
        const undo = await failReads(pg, 'compliance_incidents', code, 'column "early_warning_due_at" does not exist');
        let r;
        try { r = await check.evaluate('org1'); } finally { await undo(); }
        assert.equal(r.status, 'warn');
        assert.match(r.details, /not provisioned yet/);
        assert.equal(r.evidence.registry_provisioned, false);
    }
    // Any other database error is NOT swallowed into a compliance verdict.
    const undo = await failReads(pg, 'compliance_incidents', '08006', 'connection refused');
    try { await assert.rejects(() => check.evaluate('org1'), /connection refused/); } finally { await undo(); }
});

test('an open CRA incident past its 24-hour early warning without a stamp → fail, ids only in the sample', async () => {
    const now = Date.now();
    await incidents(
        { id: 41, kind: 'vulnerability', regimes: ['CRA'], status: 'open', detected_at: new Date(now - 30 * H).toISOString(), exploited_in_wild: true },
    );
    const r = await check.evaluate('org1');
    assert.equal(r.status, 'fail');
    assert.equal(r.evidence.clocks.early_warning.overdue, 1);
    assert.equal(r.evidence.clocks.notification.overdue, 0, '72 h not yet reached');
    assert.equal(r.evidence.actively_exploited, 1);
    assert.deepEqual(Object.keys(r.evidence.overdue_sample[0]).sort(), ['clock', 'due_at', 'id', 'kind']);
    assert.match(r.details, /24-hour early warning/);
    noPersonalData(r);
});

test('stamps stop the clocks: early warning + notification recorded, final report still inside 14 d → pass', async () => {
    const now = Date.now();
    await incidents({
        id: 42, kind: 'security_incident', regimes: ['GDPR', 'CRA'], status: 'authority_notified',
        detected_at: new Date(now - 5 * 24 * H).toISOString(),
        early_warning_sent_at: new Date(now - 5 * 24 * H + 3 * H).toISOString(),
        authority_notified_at: new Date(now - 4 * 24 * H).toISOString(),
        final_report_due_at: new Date(now + 9 * 24 * H).toISOString(),
    });
    const r = await check.evaluate('org1');
    assert.equal(r.status, 'pass');
    assert.equal(r.evidence.clocks.early_warning.sent, 1);
    assert.equal(r.evidence.clocks.notification.sent, 1);
    assert.equal(r.evidence.clocks.final_report.overdue, 0);
});

test('explicit due columns are honoured; an overdue final report → fail', async () => {
    const now = Date.now();
    await incidents({
        id: 43, kind: 'vulnerability', status: 'assessing',
        detected_at: new Date(now - 20 * 24 * H).toISOString(),
        early_warning_due_at: new Date(now - 20 * 24 * H + 24 * H).toISOString(), early_warning_sent_at: new Date(now - 19 * 24 * H).toISOString(),
        authority_notified_at: new Date(now - 18 * 24 * H).toISOString(),
        final_report_due_at: new Date(now - 2 * H).toISOString(), final_report_sent_at: null,
    });
    const r = await check.evaluate('org1');
    assert.equal(r.status, 'fail');
    assert.equal(r.evidence.clocks.final_report.overdue, 1);
    assert.match(r.details, /past the final report \(14 days for a vulnerability/);
});

test('a clock due within 6 hours → warn (partial), not fail', async () => {
    const now = Date.now();
    await incidents({ id: 44, kind: 'vulnerability', status: 'open', detected_at: new Date(now - 20 * H).toISOString() });
    const r = await check.evaluate('org1');
    assert.equal(r.status, 'warn');
    assert.equal(r.evidence.clocks.early_warning.due_soon, 1);
    assert.match(r.details, /within 6 hours/);
});

test('missing preparation → warn: channel, PSIRT contact, procedure — each named, no address leaked', async () => {
    state.settings = { cra_role: 'manufacturer' };
    state.policyBody = 'We handle incidents within 72 hours.'; // published, but silent on vulnerabilities
    const r = await check.evaluate('org1');
    assert.equal(r.status, 'warn');
    assert.equal(r.evidence.reporting_channel_set, false);
    assert.equal(r.evidence.psirt_contact_set, false);
    assert.equal(r.evidence.procedure_mentions_vulns, false);
    assert.match(r.details, /reporting channel/);
    assert.match(r.details, /PSIRT contact/);
    assert.match(r.details, /does not mention vulnerability handling/);
    noPersonalData(r);

    state.settings = { ...READY };
    state.policyBody = null; // nothing published
    const r2 = await check.evaluate('org1');
    assert.equal(r2.status, 'warn');
    assert.equal(r2.evidence.procedure_mentions_vulns, null);
    assert.match(r2.details, /No published incident-response policy/);
});

test('incidentStore.listOpenClocks is preferred when the store ships it, and non-CRA rows are dropped', async () => {
    const now = Date.now();
    let calledWith = null;
    state.listOpenClocks = async (orgId) => {
        calledWith = orgId;
        return [
            { id: 1, kind: 'breach', regimes: ['GDPR'], status: 'open', detected_at: new Date(now - 100 * H).toISOString() }, // GDPR only → ignored here
            { id: 2, kind: 'security_incident', regimes: '["NIS2","CRA"]', status: 'open', detected_at: new Date(now - 100 * H).toISOString() },
            { id: 3, kind: 'vulnerability', status: 'closed', detected_at: new Date(now - 100 * H).toISOString() },
        ];
    };
    const r = await check.evaluate('org9');
    assert.equal(calledWith, 'org9');
    assert.equal(r.evidence.open_cra_incidents, 1);
    assert.equal(r.status, 'fail');
    assert.equal(r.evidence.overdue_sample[0].id, 2);
});

test('_clocksFor falls back to detected_at + legal window when due columns are empty', () => {
    const now = Date.parse('2026-09-14T12:00:00Z');
    const clocks = check._test._clocksFor({ detected_at: '2026-09-14T00:00:00Z' }, now);
    const byName = Object.fromEntries(clocks.map(c => [c.clock, c]));
    assert.equal(new Date(byName.early_warning.due_at).toISOString(), '2026-09-15T00:00:00.000Z');
    assert.equal(new Date(byName.notification.due_at).toISOString(), '2026-09-17T00:00:00.000Z');
    assert.equal(new Date(byName.final_report.due_at).toISOString(), '2026-09-28T00:00:00.000Z');
    assert.equal(byName.early_warning.overdue, false);
    assert.equal(byName.early_warning.due_soon, false);
});

test('_clocksFor: a severe incident\'s final report falls back to one month after the notification, not 14 days', () => {
    const now = Date.parse('2026-09-30T12:00:00Z');
    const final = (row) => check._test._clocksFor(row, now).find(c => c.clock === 'final_report');
    // Not notified yet: from the latest lawful notification (detected + 72 h) — day 15 is not overdue.
    const open = final({ kind: 'security_incident', detected_at: '2026-09-14T00:00:00Z' });
    assert.equal(new Date(open.due_at).toISOString(), '2026-10-17T00:00:00.000Z');
    assert.equal(open.overdue, false);
    // Notified: one calendar month from the stamp.
    const notified = final({ kind: 'breach', detected_at: '2026-09-14T00:00:00Z', authority_notified_at: '2026-09-15T08:00:00Z' });
    assert.equal(new Date(notified.due_at).toISOString(), '2026-10-15T08:00:00.000Z');
    // A vulnerability keeps the 14 days, and is overdue on day 16.
    const vuln = final({ kind: 'vulnerability', detected_at: '2026-09-14T00:00:00Z' });
    assert.equal(new Date(vuln.due_at).toISOString(), '2026-09-28T00:00:00.000Z');
    assert.equal(vuln.overdue, true);
});
