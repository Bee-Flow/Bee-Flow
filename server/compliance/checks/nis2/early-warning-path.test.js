/**
 * NIS2-Art23-early-warning-path — 24 h / 72 h / 1-month clocks on NIS2-regime incidents,
 * on a real Postgres (the boot ladder's schema on PGlite behind db.js's pool).
 * Run: cd server && node --test compliance/checks/nis2/early-warning-path.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { installResolveStub } = require('../../../testUtils/stubRequire');
const { usePglitePool } = require('../../../testUtils/pglitePool');
const { ladderPglite } = require('../../../testUtils/pgliteTemplate');
const { failReads } = require('../../../testUtils/pgliteFaults');
const { insertRow } = require('../../../testUtils/pgliteSeed');

const ORG = 'org-a';
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const HOUR = 3600e3;
/** @type {{ listOpenClocks: undefined | ((orgId: string) => Promise<unknown>) }} */
const fx = { listOpenClocks: undefined };

// The boot ladder's schema on PGlite (testUtils/pgliteTemplate.js) behind db.js's pool.
const { pg, close } = usePglitePool(ladderPglite());
// incidentStore is swapped for one whose listOpenClocks a test switches on or
// off: the check prefers that helper and runs its own SELECT without it.
const restore = installResolveStub({
    '../../../stores/incidentStore': { get listOpenClocks() { return fx.listOpenClocks; } },
});
const complianceStore = require('../../../stores/complianceStore');
const check = require('./early-warning-path');
test.after(async () => { restore(); await close(); });

/** @param {...Record<string, any>} rows */
async function incidents(...rows) {
    for (const r of rows) await insertRow(pg, 'compliance_incidents', r);
}
const settings = (patch) => complianceStore.saveSettings(ORG, patch);

const READY = {
    breach_recipients: ['dpo@example.org', 'ciso@example.org'],
    nis2_authority_channel: 'MijnNCSC',
    nis2_csirt_contact: 'csirt@example.org',
};
const inAt = (h) => new Date(Date.now() + h * HOUR).toISOString();
const incident = (id, extra = {}) => ({
    id, organization_id: ORG, kind: 'security_incident', status: 'open', severity: 'high', regimes: ['GDPR', 'NIS2'],
    detected_at: inAt(-2), early_warning_due_at: inAt(22), deadline_at: inAt(70), final_report_due_at: inAt(24 * 29),
    early_warning_sent_at: null, authority_notified_at: null, final_report_sent_at: null, reported_via: null,
    title: 'Ransomware on mail@example.org', description: 'contains customer names', ...extra,
});
const noPii = (r) => assert.doesNotMatch(JSON.stringify(r.evidence) + ' ' + r.details, EMAIL);

test.beforeEach(async () => {
    fx.listOpenClocks = undefined;
    await pg.exec('DELETE FROM compliance_incidents; DELETE FROM compliance_settings');
    await settings({ ...READY });
});

test('contract shape — critical, tagged CRA Art. 14 + GDPR Art. 33', () => {
    assert.equal(check.id, 'NIS2-Art23-early-warning-path');
    assert.equal(check.severity, 'critical');
    assert.equal(check.remediationLink, 'admin/compliance/incidents');
    assert.ok(check.frameworks.some(f => f.regulation === 'CRA' && f.ref === 'Art. 14'));
    assert.ok(check.frameworks.some(f => f.regulation === 'GDPR' && f.ref === 'Art. 33'));
});

test('relevance gate', async () => {
    await settings({ framework_relevance: { nis2: 'not_relevant' } });
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'not_applicable');
});

test('register without the NIS2 columns (42703) → warn not provisioned, readiness still reported', async () => {
    const undo = await failReads(pg, 'compliance_incidents', '42703', 'column "early_warning_due_at" does not exist');
    let r;
    try { r = await check.evaluate(ORG); } finally { await undo(); }
    assert.equal(r.status, 'warn');
    assert.equal(r.evidence.register_provisioned, false);
    assert.equal(r.evidence.recipients_count, 2);
    assert.match(r.details, /not provisioned/);
    noPii(r);
});

test('an e-mail address typed as reported_via never reaches the evidence', async () => {
    await incidents(incident(1, { reported_via: 'mail to contact@ncsc.example.org' }));
    const r = await check.evaluate(ORG);
    noPii(r);
    assert.equal(r.evidence.incidents[0].reported_via, 'email');
});

test('ready: channel + CSIRT + recipients, no open incident → pass; contact never in evidence', async () => {
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'pass');
    assert.equal(r.evidence.open_nis2_incidents, 0);
    assert.equal(r.evidence.authority_channel, 'MijnNCSC');
    assert.equal(r.evidence.csirt_contact_configured, true);
    noPii(r);
});

test('an e-mail address typed as the authority channel never reaches the evidence', async () => {
    await settings({ nis2_authority_channel: 'cert@ncsc.example' });
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'pass');
    assert.equal(r.evidence.authority_channel_configured, true);
    assert.equal(r.evidence.authority_channel, 'email');
    noPii(r);
});

test('no authority channel / CSIRT contact / recipients → warn naming each gap', async () => {
    await pg.exec('DELETE FROM compliance_settings');
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'warn');
    assert.match(r.details, /reporting channel/);
    assert.match(r.details, /CSIRT contact/);
    assert.match(r.details, /recipients/);
});

test('open incident inside every clock → pass with the clocks in evidence', async () => {
    await incidents(incident(1));
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'pass');
    assert.equal(r.evidence.open_nis2_incidents, 1);
    assert.equal(r.evidence.incidents[0].clocks.early_warning.state, 'running');
    assert.equal(r.evidence.incidents[0].clocks.notification.state, 'running');
    assert.equal(r.evidence.incidents[0].clocks.final_report.state, 'running');
    noPii(r);
    assert.doesNotMatch(JSON.stringify(r.evidence), /Ransomware|customer names/, 'incident text never leaves the register');
});

test('an incident whose clock columns are NULL is reported as unknown, never as inside its clocks', async () => {
    // The upgrade case: `early_warning_due_at` / `final_report_due_at` are
    // added with ADD COLUMN IF NOT EXISTS and no backfill, so every incident
    // opened before that release carries NULLs there.
    await incidents(incident(1, { early_warning_due_at: null, final_report_due_at: null }));
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'warn', 'a deadline that was never computed is not a met deadline');
    assert.equal(r.evidence.unknown_clock_count, 1);
    assert.equal(r.evidence.clocks_unknown, 2);
    assert.equal(r.evidence.incidents[0].clocks.early_warning.state, 'no_clock');
    assert.match(r.details, /no due date/);
    assert.doesNotMatch(r.details, /all inside their clocks/);
    noPii(r);
});

test('every clock NULL on every open incident → still warn, with all of them counted', async () => {
    await incidents(
        incident(1, { early_warning_due_at: null, deadline_at: null, final_report_due_at: null }),
        incident(2, { early_warning_due_at: null, deadline_at: null, final_report_due_at: null }),
    );
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'warn');
    assert.equal(r.evidence.unknown_clock_count, 2);
    // The 72 h notification is computed from detected_at, so only the early
    // warning and the final report are unknown per incident.
    assert.equal(r.evidence.clocks_unknown, 4);
    assert.equal(r.evidence.overdue_count, 0);
});

test('a NULL clock that already carries its sent stamp is settled, not unknown', async () => {
    await incidents(incident(1, { early_warning_due_at: null, early_warning_sent_at: inAt(-1) }));
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'pass', 'the report is recorded — there is no open deadline to compute');
    assert.equal(r.evidence.unknown_clock_count, 0);
    assert.equal(r.evidence.incidents[0].clocks.early_warning.state, 'sent');
});

test('early warning overdue without a stamp → fail', async () => {
    await incidents(incident(1, { early_warning_due_at: inAt(-1) }));
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'fail');
    assert.equal(r.evidence.overdue_count, 1);
    assert.equal(r.evidence.incidents[0].clocks.early_warning.state, 'overdue');
});

test('72 h notification overdue without authority_notified_at → fail; stamped → not overdue', async () => {
    await incidents(incident(1, { detected_at: inAt(-73), early_warning_sent_at: inAt(-60), deadline_at: inAt(-1) }));
    assert.equal((await check.evaluate(ORG)).status, 'fail');
    await pg.exec('DELETE FROM compliance_incidents');
    await incidents(incident(1, { detected_at: inAt(-73), early_warning_sent_at: inAt(-60), deadline_at: inAt(-1), authority_notified_at: inAt(-2), status: 'authority_notified' }));
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'pass');
    assert.equal(r.evidence.incidents[0].clocks.notification.state, 'sent');
});

test('the notification clock is 72 h from detection, not the row\'s earliest deadline', async () => {
    // A NIS2 + DORA incident: deadline_at holds the 4 h DORA customer notice,
    // which has passed. That is not a missed NIS2 notification — the 72 h
    // clock still runs.
    const row = incident(1, { regimes: ['NIS2', 'DORA'], detected_at: inAt(-6), early_warning_due_at: inAt(18), deadline_at: inAt(-2) });
    await incidents(row);
    const r = await check.evaluate(ORG);
    const clock = r.evidence.incidents[0].clocks.notification;
    assert.equal(clock.state, 'running');
    assert.equal(new Date(clock.due_at).getTime(), new Date(row.detected_at).getTime() + 72 * HOUR);
    assert.equal(r.status, 'pass');
});

test('no detected_at → the notification clock is unknown, never met', async () => {
    // detected_at is NOT NULL in the register, so the row comes through the store helper.
    fx.listOpenClocks = async () => [incident(1, { detected_at: null })];
    const r = await check.evaluate(ORG);
    assert.equal(r.evidence.incidents[0].clocks.notification.state, 'no_clock');
    assert.equal(r.status, 'warn');
});

test('final report overdue → fail', async () => {
    await incidents(incident(1, {
        early_warning_sent_at: inAt(-700), authority_notified_at: inAt(-690), status: 'authority_notified',
        early_warning_due_at: inAt(-710), deadline_at: inAt(-660), final_report_due_at: inAt(-1),
    }));
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'fail');
    assert.equal(r.evidence.incidents[0].clocks.final_report.state, 'overdue');
});

test('a clock within 6 h → warn (urgent)', async () => {
    await incidents(incident(1, { early_warning_due_at: inAt(3) }));
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'warn');
    assert.equal(r.evidence.urgent_count, 1);
    assert.match(r.details, /within 6 hours/);
});

test('closed and non-NIS2 incidents are ignored', async () => {
    await incidents(
        incident(1, { status: 'closed', early_warning_due_at: inAt(-100) }),
        incident(2, { regimes: ['GDPR'], early_warning_due_at: inAt(-100) }),
        incident(3, { organization_id: 'org-b', early_warning_due_at: inAt(-100) }),
    );
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'pass');
    assert.equal(r.evidence.open_nis2_incidents, 0);
});

test('incidentStore.listOpenClocks is preferred when present, and its rows are filtered to open NIS2 ones', async () => {
    fx.listOpenClocks = async (orgId) => {
        assert.equal(orgId, ORG);
        return [
            incident(1, { early_warning_due_at: inAt(-1) }),
            incident(2, { regimes: '["CRA"]', early_warning_due_at: inAt(-1) }),
            incident(3, { status: 'closed', early_warning_due_at: inAt(-1) }),
        ];
    };
    const r = await check.evaluate(ORG);
    assert.equal(r.evidence.source, 'incidentStore.listOpenClocks');
    assert.equal(r.status, 'fail');
    assert.equal(r.evidence.open_nis2_incidents, 1, 'the register itself is empty: the helper answered');
});

test('a store helper returning a non-array falls back to the own SELECT', async () => {
    fx.listOpenClocks = async () => ({ rows: [] });
    await incidents(incident(1));
    const r = await check.evaluate(ORG);
    assert.equal(r.evidence.source, 'query');
    assert.equal(r.evidence.open_nis2_incidents, 1);
});

test('evidence caps the incident list at 10', async () => {
    await incidents(...Array.from({ length: 14 }, (_, i) => incident(i + 1)));
    const r = await check.evaluate(ORG);
    assert.equal(r.evidence.open_nis2_incidents, 14);
    assert.equal(r.evidence.incidents.length, 10);
});
