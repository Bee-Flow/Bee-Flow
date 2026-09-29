/**
 * DORA-Art30-incident-reporting-path — customer contacts + the customer-notice
 * clock on DORA-regime incidents.
 * Run: cd server && node --test --test-force-exit compliance/checks/dora/art30-incident-reporting-path.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { installResolveStub } = require('../../../testUtils/stubRequire');

const ORG = 'org-a';
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const HOUR = 3600e3;
const fx = { incidents: [], settings: {}, dbError: null, params: [], listOpenClocks: undefined };
const pgError = (code) => Object.assign(new Error(`pg ${code}`), { code, severity: 'ERROR' });
const fakeDb = {
    async getAll(sql, params) {
        fx.params.push(params);
        if (fx.dbError) throw fx.dbError;
        assert.match(sql, /FROM compliance_incidents/);
        assert.match(sql, /organization_id = \$1/);
        assert.match(sql, /status <> 'closed'/);
        assert.match(sql, /"DORA"/);
        return fx.incidents.filter(i => i.organization_id === params[0] && i.status !== 'closed' && (i.regimes || []).includes('DORA'));
    },
    async getOne() { return null; },
};
const incidentStub = {
    get listOpenClocks() { return fx.listOpenClocks; },
};
const restore = installResolveStub({
    '../../../db': fakeDb,
    '../../../stores/complianceStore': { getSettings: async (orgId) => ({ organization_id: orgId, ...fx.settings }) },
    '../../../stores/incidentStore': incidentStub,
});
const check = require('./art30-incident-reporting-path');
test.after(() => restore());

const READY = {
    framework_relevance: { dora: 'relevant' },
    incident_customer_contacts: [
        { name: 'Jan Jansen', email: 'ict-risk@bank.example', entity: 'Example Bank N.V.' },
        { name: 'Piet', email: 'soc@insurer.example', entity: 'Example Verzekeringen' },
    ],
    dora_customer_notice_hours: 4,
};
const at = (h) => new Date(Date.now() + h * HOUR).toISOString();
const incident = (id, extra = {}) => ({
    id, organization_id: ORG, kind: 'security_incident', status: 'open', severity: 'high', regimes: ['GDPR', 'DORA'],
    detected_at: at(-1), customer_notified_at: null,
    title: 'Outage seen by mail@example.org', description: 'contains customer names', ...extra,
});
const noPii = (r) => {
    const blob = JSON.stringify(r.evidence) + ' ' + r.details;
    assert.doesNotMatch(blob, EMAIL);
    assert.doesNotMatch(blob, /Jansen|Example Bank|customer names/);
};

test.beforeEach(() => { fx.incidents = []; fx.settings = { ...READY }; fx.dbError = null; fx.params = []; fx.listOpenClocks = undefined; });

test('contract shape — high, automated, tagged NIS2 Art. 23 + GDPR Art. 33', () => {
    assert.equal(check.id, 'DORA-Art30-incident-reporting-path');
    assert.equal(check.regulation, 'DORA');
    assert.equal(check.severity, 'high');
    assert.equal(check.scope, 'global');
    assert.equal(check.verification, 'automated');
    assert.equal(check.remediationLink, 'admin/compliance/incidents');
    assert.equal(check.titleKey, 'compliance.check_dora_incident_path_title');
    assert.equal(check.descriptionKey, 'compliance.check_dora_incident_path_desc');
    assert.equal(check.remediationKey, 'compliance.check_dora_incident_path_fix');
    assert.ok(check.frameworks.some(f => f.regulation === 'NIS2' && f.ref === 'Art. 23'));
    assert.ok(check.frameworks.some(f => f.regulation === 'GDPR' && f.ref === 'Art. 33'));
});

test('relevance gate: not_relevant → not_applicable without touching the register', async () => {
    fx.settings.framework_relevance = { dora: 'not_relevant' };
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'not_applicable');
    assert.deepEqual(r.evidence, { relevance: 'not_relevant' });
    assert.equal(fx.params.length, 0);
});

test('relevance unknown (or unset, or a JSON string) → the check runs and the details say the card asks', async () => {
    fx.settings.framework_relevance = {};
    let r = await check.evaluate(ORG);
    assert.equal(r.status, 'pass');
    assert.equal(r.evidence.relevance, 'unknown');
    assert.match(r.details, /Frameworks card asks/);
    fx.settings.framework_relevance = JSON.stringify({ dora: 'relevant' });
    r = await check.evaluate(ORG);
    assert.equal(r.evidence.relevance, 'relevant');
    assert.doesNotMatch(r.details, /Frameworks card asks/);
});

test('empty: no customer contact → fail, even with a clean register', async () => {
    fx.settings.incident_customer_contacts = [];
    let r = await check.evaluate(ORG);
    assert.equal(r.status, 'fail');
    assert.equal(r.evidence.contacts_count, 0);
    assert.match(r.details, /No customer incident contact/);
    noPii(r);
    // contacts without an address are not a reporting path either
    fx.settings.incident_customer_contacts = [{ name: 'Someone', entity: 'Bank' }, 'garbage', null];
    r = await check.evaluate(ORG);
    assert.equal(r.status, 'fail');
    assert.equal(r.evidence.contacts_declared, 3);
    assert.equal(r.evidence.contacts_count, 0);
});

test('gap: an open DORA incident past detected_at + notice window without customer_notified_at → fail', async () => {
    fx.incidents = [incident(11, { detected_at: at(-5) }), incident(12, { detected_at: at(-0.5) })];
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'fail');
    assert.equal(r.evidence.open_dora_incidents, 2);
    assert.equal(r.evidence.overdue_count, 1);
    assert.equal(r.evidence.incidents[0].clock.state, 'overdue');
    assert.equal(r.evidence.incidents[1].clock.state, 'running');
    assert.match(r.details, /1 open DORA incident\(s\) passed the 4 h customer-notice window.*ids 11/);
    noPii(r);
});

test('a notified incident is green regardless of age; closed and non-DORA rows are not counted', async () => {
    fx.incidents = [
        incident(21, { detected_at: at(-30), customer_notified_at: at(-29) }),
        incident(22, { detected_at: at(-30), status: 'closed' }),
        incident(23, { detected_at: at(-30), regimes: ['GDPR', 'NIS2'] }),
    ];
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'pass');
    assert.equal(r.evidence.open_dora_incidents, 1);
    assert.equal(r.evidence.notified_count, 1);
    assert.deepEqual(fx.params, [[ORG]], 'one org-scoped query');
});

test('partial: window closing within 1 h → warn; contacts without an entity → warn', async () => {
    fx.incidents = [incident(31, { detected_at: at(-3.5) })];
    let r = await check.evaluate(ORG);
    assert.equal(r.status, 'warn');
    assert.equal(r.evidence.urgent_count, 1);
    assert.match(r.details, /reach the 4 h customer-notice window within 1 hour/);
    fx.incidents = [];
    fx.settings.incident_customer_contacts = [{ email: 'soc@insurer.example' }];
    r = await check.evaluate(ORG);
    assert.equal(r.status, 'warn');
    assert.equal(r.evidence.financial_entities_count, 0);
    assert.match(r.details, /none names the financial entity/);
    noPii(r);
});

test('good: contacts with entities, default notice window, no open incident → pass', async () => {
    delete fx.settings.dora_customer_notice_hours;
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'pass');
    assert.equal(r.evidence.notice_hours, 4);
    assert.equal(r.evidence.notice_hours_default, true);
    assert.equal(r.evidence.contacts_count, 2);
    assert.equal(r.evidence.financial_entities_count, 2);
    assert.match(r.details, /Reporting path ready: 2 customer contact\(s\) across 2 financial entities/);
    noPii(r);
});

test('a stored customer_notice_due_at wins over detected_at + window', async () => {
    fx.incidents = [incident(45, { detected_at: at(-10), customer_notice_due_at: at(3) })];
    let r = await check.evaluate(ORG);
    assert.equal(r.status, 'pass');
    assert.equal(r.evidence.incidents[0].clock.state, 'running');
    assert.equal(r.evidence.incidents[0].clock.due_at, at(3).slice(0, 16) + r.evidence.incidents[0].clock.due_at.slice(16));
    fx.incidents = [incident(46, { detected_at: at(-1), customer_notice_due_at: at(-0.1) })];
    r = await check.evaluate(ORG);
    assert.equal(r.status, 'fail');
});

test('a custom notice window moves the clock', async () => {
    fx.settings.dora_customer_notice_hours = 24;
    fx.incidents = [incident(41, { detected_at: at(-5) })];
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'pass');
    assert.equal(r.evidence.incidents[0].clock.state, 'running');
    assert.match(r.details, /24 h notice window/);
});

test('incidentStore.listOpenClocks is preferred when present, filtered to open DORA rows', async () => {
    fx.listOpenClocks = async (orgId) => {
        assert.equal(orgId, ORG);
        return [incident(51, { detected_at: at(-9) }), incident(52, { regimes: ['GDPR'] }), incident(53, { status: 'closed' })];
    };
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'fail');
    assert.equal(r.evidence.source, 'incidentStore.listOpenClocks');
    assert.equal(r.evidence.open_dora_incidents, 1);
    assert.equal(fx.params.length, 0, 'no fallback SELECT');
});

test('missing table/column (42P01 / 42703) → warn "not provisioned yet"; other errors surface', async () => {
    fx.dbError = pgError('42703');
    let r = await check.evaluate(ORG);
    assert.equal(r.status, 'warn');
    assert.equal(r.evidence.register_provisioned, false);
    assert.equal(r.evidence.missing, '42703');
    assert.match(r.details, /not provisioned yet/);
    fx.dbError = null;
    fx.listOpenClocks = async () => { throw pgError('42P01'); };
    r = await check.evaluate(ORG);
    assert.equal(r.status, 'warn');
    assert.equal(r.evidence.source, 'incidentStore.listOpenClocks');
    fx.listOpenClocks = undefined;
    fx.dbError = new Error('connection reset');
    await assert.rejects(() => check.evaluate(ORG), /connection reset/);
});

test('evidence never carries a contact name, e-mail address, entity name or the incident text', async () => {
    fx.incidents = [incident(61, { detected_at: at(-9) }), incident(62)];
    for (const r of [await check.evaluate(ORG)]) {
        noPii(r);
        assert.deepEqual(Object.keys(r.evidence.incidents[0]).sort(), ['clock', 'detected_at', 'id', 'kind', 'severity', 'status']);
    }
});
