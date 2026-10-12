/**
 * CRA Art. 14 clocks: relevance/role gates, empty register, overdue → fail,
 * due-soon / missing preparation → warn, full readiness → pass, store helper
 * preferred over the raw SELECT, and evidence free of personal data.
 *
 * Run: cd server && node --test --test-force-exit compliance/checks/cra/art14-vuln-reporting-clocks.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { installResolveStub } = require('../../../testUtils/stubRequire');

const H = 3600e3;
const state = {
    settings: {},
    rows: [],
    queryError: null,
    listOpenClocks: undefined, // set to a function to exercise the store path
    policyBody: null,
    lastSql: null,
    lastParams: null,
};

const fakeDb = {
    async getAll(sql, params) {
        state.lastSql = String(sql).replace(/\s+/g, ' ').trim();
        state.lastParams = params;
        if (state.queryError) throw state.queryError;
        return state.rows;
    },
    async getOne() { return null; },
    async run() { return { rowCount: 0, rows: [] }; },
    async exec() {},
};
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
    '../../../db': fakeDb,
    '../../../stores/complianceStore': fakeComplianceStore,
    '../../../stores/incidentStore': fakeIncidentStore,
    '../../../stores/ismsDocStore': fakeIsmsDocStore,
});
const check = require('./art14-vuln-reporting-clocks');
test.after(() => restore());

const READY = {
    cra_role: 'manufacturer',
    cra_reporting_channel: 'MijnNCSC',
    psirt_contact_email: 'psirt@example.org',
    framework_relevance: { cra: 'relevant' },
};
const GOOD_POLICY = 'Incidents are triaged within 4 hours. Vulnerability reports received via the PSIRT mailbox follow the same flow.';

test.beforeEach(() => {
    state.settings = { ...READY };
    state.rows = [];
    state.queryError = null;
    state.listOpenClocks = undefined;
    state.policyBody = GOOD_POLICY;
    state.lastSql = null;
});

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
    assert.equal(state.lastSql, null, 'no query when not relevant');
});

test('role gate: a user-only organisation has no Art. 14 duty', async () => {
    state.settings = { ...READY, cra_role: 'user_only' };
    const r = await check.evaluate('org1');
    assert.equal(r.status, 'not_applicable');
    assert.equal(r.evidence.cra_role, 'user_only');
});

test('role gate: an importer/distributor has no Art. 14 reporting clock', async () => {
    state.settings = { ...READY, cra_role: 'distributor' };
    const r = await check.evaluate('org1');
    assert.equal(r.status, 'not_applicable');
    assert.equal(r.evidence.cra_role, 'distributor');
    assert.match(r.details, /Art\. 19 and 20/);
    assert.equal(state.lastSql, null, 'the register is not queried for a distributor');
});

test('role gate: an undeclared role keeps the clocks (the conservative reading)', async () => {
    state.settings = { ...READY, cra_role: null };
    const r = await check.evaluate('org1');
    assert.notEqual(r.status, 'not_applicable');
    assert.notEqual(state.lastSql, null);
});

test('empty register with full preparation → pass; the SELECT is org-scoped and CRA-filtered', async () => {
    const r = await check.evaluate('org1');
    assert.equal(r.status, 'pass');
    assert.equal(r.evidence.open_cra_incidents, 0);
    assert.equal(r.evidence.reporting_channel_set, true);
    assert.equal(r.evidence.psirt_contact_set, true);
    assert.equal(r.evidence.procedure_mentions_vulns, true);
    assert.match(state.lastSql, /WHERE organization_id = \$1/);
    assert.match(state.lastSql, /kind = 'vulnerability' OR COALESCE\(regimes, '\[\]'::jsonb\) \? 'CRA'/);
    assert.match(state.lastSql, /status <> 'closed'/);
    assert.deepEqual(state.lastParams, ['org1']);
    noPersonalData(r);
});

test('register without the CRA columns yet → warn "not provisioned yet", never a throw', async () => {
    for (const code of ['42703', '42P01']) {
        state.queryError = Object.assign(new Error('column "early_warning_due_at" does not exist'), { code });
        const r = await check.evaluate('org1');
        assert.equal(r.status, 'warn');
        assert.match(r.details, /not provisioned yet/);
        assert.equal(r.evidence.registry_provisioned, false);
    }
    // Any other database error is NOT swallowed into a compliance verdict.
    state.queryError = Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
    await assert.rejects(() => check.evaluate('org1'), /connection refused/);
});

test('an open CRA incident past its 24-hour early warning without a stamp → fail, ids only in the sample', async () => {
    const now = Date.now();
    state.rows = [
        { id: 41, kind: 'vulnerability', regimes: ['CRA'], status: 'open', detected_at: new Date(now - 30 * H).toISOString(), exploited_in_wild: true },
    ];
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
    state.rows = [{
        id: 42, kind: 'security_incident', regimes: ['GDPR', 'CRA'], status: 'authority_notified',
        detected_at: new Date(now - 5 * 24 * H).toISOString(),
        early_warning_sent_at: new Date(now - 5 * 24 * H + 3 * H).toISOString(),
        authority_notified_at: new Date(now - 4 * 24 * H).toISOString(),
        final_report_due_at: new Date(now + 9 * 24 * H).toISOString(),
    }];
    const r = await check.evaluate('org1');
    assert.equal(r.status, 'pass');
    assert.equal(r.evidence.clocks.early_warning.sent, 1);
    assert.equal(r.evidence.clocks.notification.sent, 1);
    assert.equal(r.evidence.clocks.final_report.overdue, 0);
});

test('explicit due columns are honoured; an overdue final report → fail', async () => {
    const now = Date.now();
    state.rows = [{
        id: 43, kind: 'vulnerability', status: 'assessing',
        detected_at: new Date(now - 20 * 24 * H).toISOString(),
        early_warning_due_at: new Date(now - 20 * 24 * H + 24 * H).toISOString(), early_warning_sent_at: new Date(now - 19 * 24 * H).toISOString(),
        authority_notified_at: new Date(now - 18 * 24 * H).toISOString(),
        final_report_due_at: new Date(now - 2 * H).toISOString(), final_report_sent_at: null,
    }];
    const r = await check.evaluate('org1');
    assert.equal(r.status, 'fail');
    assert.equal(r.evidence.clocks.final_report.overdue, 1);
    assert.match(r.details, /past the final report \(14 days for a vulnerability/);
});

test('a clock due within 6 hours → warn (partial), not fail', async () => {
    const now = Date.now();
    state.rows = [{ id: 44, kind: 'vulnerability', status: 'open', detected_at: new Date(now - 20 * H).toISOString() }];
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
    assert.equal(state.lastSql, null, 'raw SELECT not used when the helper exists');
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
