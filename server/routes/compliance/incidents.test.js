/**
 * routes/compliance/incidents — CRA gating (409 framework_disabled), the
 * kind/regimes/CVE fields reaching the store, the cra-report and
 * customer-notified stamps with their evidence rows and event, the kind
 * filter, and that the legacy breach behaviour still holds.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { installResolveStub } = require('../../testUtils/stubRequire');

// ── Stand-ins ────────────────────────────────────────────────────────
const state = { calls: [], evidence: [], events: [], reruns: [], mails: [], incidents: {}, active: new Set(['GDPR', 'AIA', 'ISO27001']), settings: {}, mailFail: null };
const rec = (name, orgId, ...rest) => state.calls.push({ name, orgId, args: rest });
let nextId = 1;

const VALID_KINDS = ['breach', 'security_incident', 'vulnerability'];
const VALID_REGIMES = ['GDPR', 'NIS2', 'CRA', 'DORA'];

const incidentStoreStub = {
    VALID_KINDS,
    VALID_REGIMES,
    normalizeRegimes: (input, kind) => {
        const list = Array.isArray(input) ? input : (typeof input === 'string' && input ? [input] : []);
        const out = [];
        for (const r of list) {
            const code = String(r).trim().toUpperCase();
            if (!VALID_REGIMES.includes(code)) throw new Error(`invalid regime "${r}"`);
            if (!out.includes(code)) out.push(code);
        }
        return out.length ? out : (kind === 'vulnerability' ? ['CRA'] : ['GDPR']);
    },
    createIncident: async (input) => {
        rec('createIncident', input.organization_id, input);
        const row = { id: nextId++, organization_id: input.organization_id, title: input.title, kind: input.kind || 'breach', regimes: input.regimes || ['GDPR'], status: 'open', cve_ids: input.cve_ids, affected_products: input.affected_products, exploited_in_wild: input.exploited_in_wild ?? null };
        state.incidents[row.id] = row;
        return row;
    },
    listIncidents: async (orgId, opts) => { rec('listIncidents', orgId, opts); return Object.values(state.incidents).filter(i => i.organization_id === orgId && (!opts.kind || i.kind === opts.kind)); },
    getIncident: async (orgId, id) => { rec('getIncident', orgId, id); const i = state.incidents[id]; return i && i.organization_id === orgId ? i : null; },
    updateIncident: async (orgId, id, patch) => { rec('updateIncident', orgId, id, patch); const i = state.incidents[id]; return i && i.organization_id === orgId ? { ...i, ...patch } : null; },
    stampCraReport: async (orgId, id, opts) => { rec('stampCraReport', orgId, id, opts); const i = state.incidents[id]; return i && i.organization_id === orgId ? { ...i, status: opts.stage === 'full' ? 'reported' : 'early_warning_sent' } : null; },
    stampCustomerNotified: async (orgId, id, by) => { rec('stampCustomerNotified', orgId, id, by); const i = state.incidents[id]; return i && i.organization_id === orgId ? { ...i, customer_notified_at: 'now' } : null; },
};
const complianceStoreStub = {
    addEvidence: async (row) => {
        if (state.evidenceFail) { const e = new Error('lock timeout'); e.code = '55P03'; throw e; }
        state.evidence.push(row); return { id: 'ev', seq: 1, hash: 'h' };
    },
    getSettings: async (orgId) => { rec('getSettings', orgId); return state.settings[orgId] || {}; },
};
// The mail transport. It is the ONE place the recipient addresses are allowed
// to arrive (BFSF-441: the channel), so the double records exactly what it was
// handed and can be made to fail like a real SMTP rejection.
const emailServiceStub = {
    sendBreachNotificationEmail: async (args) => {
        state.mails.push(args);
        if (state.mailFail) {
            const err = new Error(`550 5.1.1 <${state.mailFail}>: recipient address rejected: user unknown`);
            err.code = 'EENVELOPE';
            throw err;
        }
        return { messageId: 'm-1' };
    },
};
const runnerStub = { runOne: async (orgId, checkId, opts) => { state.reruns.push({ orgId, checkId, opts }); } };
const frameworkPolicyStub = { activeRegulations: async (orgId, opts) => { rec('activeRegulations', orgId, !!opts?.req); return state.active; } };
const eventsStub = { emit: (name, payload) => state.events.push({ name, payload }), EVENTS: {} };
const permissionsStub = {
    requireAuth: (req, res, next) => (req.session?.user ? next() : res.status(401).json({ error: 'Not authenticated' })),
    requirePermission: () => (req, res, next) => (req.session?.user?.canCompliance ? next() : res.status(403).json({ error: 'forbidden' })),
};
const sharedStub = { resolveOrgId: async (req) => req.session?.user?.orgId || 'default' };

const restore = installResolveStub({
    '../../stores/complianceStore': complianceStoreStub,
    '../../stores/incidentStore': incidentStoreStub,
    '../../compliance/runner': runnerStub,
    '../../compliance/frameworkPolicy': frameworkPolicyStub,
    '../../compliance/events': eventsStub,
    '../../auth/permissions': permissionsStub,
    '../../utils/emailService': emailServiceStub,
    './shared': sharedStub,
});
const router = require('./incidents');
const writeFailures = require('../../compliance/evidence/writeFailures');
test.after(() => restore());

// ── Harness ──────────────────────────────────────────────────────────
let currentSession = null;
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.session = currentSession; next(); });
app.use('/api/compliance', router);
let server; let base;
test.before(async () => {
    await new Promise((resolve) => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}/api/compliance`;
});
test.after(async () => { if (server) await new Promise((r) => server.close(r)); });

async function call(method, path, session, body) {
    currentSession = session;
    const withBody = body !== undefined && method !== 'GET';
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: withBody ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { parsed = text; }
    return { status: res.status, body: parsed };
}
const tick = () => new Promise(r => setImmediate(r));

const ADMIN_A = { user: { id: 'u_a', orgId: 'org_a', canCompliance: true } };
const ADMIN_B = { user: { id: 'u_b', orgId: 'org_b', canCompliance: true } };

test.beforeEach(() => {
    state.calls = []; state.evidence = []; state.events = []; state.reruns = []; state.mails = []; state.incidents = {}; state.settings = {};
    state.evidenceFail = false; state.mailFail = null; writeFailures._reset();
    state.active = new Set(['GDPR', 'AIA', 'ISO27001']);
    nextId = 1;
});

// ── Creation ─────────────────────────────────────────────────────────

test('a plain breach still works as before: kind breach, GDPR regime, Art-33 evidence + rerun', async () => {
    const res = await call('POST', '/incidents', ADMIN_A, { title: 'Laptop lost', severity: 'high' });
    assert.equal(res.status, 201);
    const c = state.calls.find(x => x.name === 'createIncident');
    assert.equal(c.orgId, 'org_a');
    assert.equal(c.args[0].kind, 'breach');
    assert.deepEqual(c.args[0].regimes, ['GDPR']);
    assert.equal(c.args[0].created_by, 'u_a');
    assert.equal(c.args[0].source, 'manual');
    assert.equal(state.evidence[0].check_id, 'GDPR-Art33-breach-detection');
    assert.equal(state.evidence[0].payload.action, 'incident_created');
    await tick();
    assert.deepEqual(state.reruns.map(r => r.checkId), ['GDPR-Art33-breach-detection']);
    // No CRA framework check was needed.
    assert.ok(!state.calls.some(x => x.name === 'activeRegulations'));
});

test('a vulnerability without the CRA framework active → 409 framework_disabled, nothing stored', async () => {
    const res = await call('POST', '/incidents', ADMIN_A, { title: 'RCE in parser', kind: 'vulnerability' });
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'framework_disabled');
    assert.equal(res.body.framework, 'cra');
    assert.ok(!state.calls.some(x => x.name === 'createIncident'));
    assert.equal(state.evidence.length, 0);
    assert.equal(state.calls.find(x => x.name === 'activeRegulations').orgId, 'org_a');
});

test('a breach that lists CRA among its regimes is gated the same way', async () => {
    const res = await call('POST', '/incidents', ADMIN_A, { title: 'x', kind: 'security_incident', regimes: ['NIS2', 'CRA'] });
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'framework_disabled');
});

test('with CRA active a vulnerability carries kind/regimes/cve_ids/affected_products/exploited to the store and stamps CRA evidence', async () => {
    state.active.add('CRA');
    const res = await call('POST', '/incidents', ADMIN_A, {
        title: 'RCE in parser', kind: 'vulnerability', actively_exploited: true,
        cve_ids: ['CVE-2026-1234', 'CVE-2026-1234', ''], affected_products: 'agent-hub, server', reported_via: 'enisa_srp',
    });
    assert.equal(res.status, 201);
    const c = state.calls.find(x => x.name === 'createIncident').args[0];
    assert.equal(c.kind, 'vulnerability');
    assert.deepEqual(c.regimes, ['CRA']);
    assert.equal(c.exploited_in_wild, true);
    assert.deepEqual(c.cve_ids, ['CVE-2026-1234', 'CVE-2026-1234']);
    assert.deepEqual(c.affected_products, ['agent-hub', 'server']);
    assert.equal(c.reported_via, 'enisa_srp');
    assert.equal(c.customerNoticeHours, undefined);
    assert.equal(state.evidence[0].check_id, 'CRA-Art14-vuln-reporting-clocks');
    assert.deepEqual(state.evidence[0].payload.regimes, ['CRA']);
    await tick();
    assert.deepEqual(state.reruns.map(r => r.checkId).sort(), ['CRA-Art14-vuln-reporting-clocks', 'GDPR-Art33-breach-detection']);
});

test('exploited_in_wild is the canonical name; unknown kind / regime → 400', async () => {
    state.active.add('CRA');
    await call('POST', '/incidents', ADMIN_A, { title: 'v', kind: 'vulnerability', exploited_in_wild: false });
    assert.equal(state.calls.find(x => x.name === 'createIncident').args[0].exploited_in_wild, false);

    const badKind = await call('POST', '/incidents', ADMIN_A, { title: 'v', kind: 'rumour' });
    assert.equal(badKind.status, 400);
    assert.equal(badKind.body.error, 'invalid_kind');
    const badRegime = await call('POST', '/incidents', ADMIN_A, { title: 'v', regimes: ['PCI'] });
    assert.equal(badRegime.status, 400);
    assert.equal(badRegime.body.error, 'invalid_regime');
});

test('a DORA incident reads dora_customer_notice_hours from the org settings', async () => {
    state.settings.org_a = { dora_customer_notice_hours: 2 };
    const res = await call('POST', '/incidents', ADMIN_A, { title: 'Outage', kind: 'security_incident', regimes: ['DORA', 'GDPR'] });
    assert.equal(res.status, 201);
    const c = state.calls.find(x => x.name === 'createIncident').args[0];
    assert.equal(c.customerNoticeHours, 2);
    assert.deepEqual(c.regimes, ['DORA', 'GDPR']);
    assert.equal(state.calls.find(x => x.name === 'getSettings').orgId, 'org_a');
});

// ── Listing ──────────────────────────────────────────────────────────

test('GET /incidents?kind= filters through the store, org-scoped; an unknown kind is 400', async () => {
    state.active.add('CRA');
    await call('POST', '/incidents', ADMIN_A, { title: 'b' });
    await call('POST', '/incidents', ADMIN_A, { title: 'v', kind: 'vulnerability' });
    await call('POST', '/incidents', ADMIN_B, { title: 'other org', kind: 'vulnerability' });
    const res = await call('GET', '/incidents?kind=vulnerability', ADMIN_A);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.map(i => i.title), ['v']);
    const l = state.calls.find(x => x.name === 'listIncidents');
    assert.equal(l.orgId, 'org_a');
    assert.equal(l.args[0].kind, 'vulnerability');
    assert.equal((await call('GET', '/incidents?kind=nope', ADMIN_A)).status, 400);
    assert.equal((await call('GET', '/incidents', ADMIN_A)).body.length, 2);
});

// ── CRA report stamps ────────────────────────────────────────────────

async function seedVuln(session = ADMIN_A) {
    state.active.add('CRA');
    const res = await call('POST', '/incidents', session, { title: 'RCE', kind: 'vulnerability' });
    state.calls = []; state.evidence = []; state.events = []; state.reruns = [];
    return res.body.id;
}

test('POST /incidents/:id/cra-report early_warning → stampCraReport + CRA evidence + event', async () => {
    const id = await seedVuln();
    const res = await call('POST', `/incidents/${id}/cra-report`, ADMIN_A, { stage: 'early_warning', reported_via: 'enisa_srp', reference: 'SRP-42' });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'early_warning_sent');
    const s = state.calls.find(x => x.name === 'stampCraReport');
    assert.equal(s.orgId, 'org_a');
    assert.equal(s.args[0], id);
    assert.deepEqual(s.args[1], { stage: 'early_warning', reportedVia: 'enisa_srp', reference: 'SRP-42', by: 'u_a' });
    assert.equal(state.evidence.length, 1);
    assert.equal(state.evidence[0].check_id, 'CRA-Art14-vuln-reporting-clocks');
    assert.equal(state.evidence[0].subject_id, String(id));
    assert.deepEqual(Object.keys(state.evidence[0].payload).sort(), ['action', 'at', 'by', 'incident_id', 'reference', 'reported_via', 'stage']);
    assert.equal(state.events.length, 1);
    assert.equal(state.events[0].name, 'cra_vulnerability_reported');
    assert.deepEqual({ orgId: state.events[0].payload.orgId, incidentId: state.events[0].payload.incidentId, stage: state.events[0].payload.stage }, { orgId: 'org_a', incidentId: id, stage: 'early_warning' });
    await tick();
    assert.deepEqual(state.reruns.map(r => r.checkId), ['CRA-Art14-vuln-reporting-clocks']);
});

test('cra-report: stage full; invalid stage 400; foreign incident 404; non-CRA incident 409', async () => {
    const id = await seedVuln();
    const full = await call('POST', `/incidents/${id}/cra-report`, ADMIN_A, { stage: 'full', reference: 'R-1' });
    assert.equal(full.status, 200);
    assert.equal(full.body.status, 'reported');

    assert.equal((await call('POST', `/incidents/${id}/cra-report`, ADMIN_A, { stage: 'later' })).status, 400);

    state.calls = [];
    const foreign = await call('POST', `/incidents/${id}/cra-report`, ADMIN_B, { stage: 'full' });
    assert.equal(foreign.status, 404);
    assert.ok(!state.calls.some(x => x.name === 'stampCraReport'));

    const breach = await call('POST', '/incidents', ADMIN_A, { title: 'plain breach' });
    const notCra = await call('POST', `/incidents/${breach.body.id}/cra-report`, ADMIN_A, { stage: 'full' });
    assert.equal(notCra.status, 409);
    assert.equal(notCra.body.error, 'not_cra_incident');
});

test('cra-report is refused with 409 framework_disabled once the CRA framework is switched off', async () => {
    const id = await seedVuln();
    state.active.delete('CRA');
    const res = await call('POST', `/incidents/${id}/cra-report`, ADMIN_A, { stage: 'early_warning' });
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'framework_disabled');
    assert.ok(!state.calls.some(x => x.name === 'stampCraReport'));
});

// ── Customer notice ──────────────────────────────────────────────────

test('POST /incidents/:id/customer-notified → stampCustomerNotified(org, id, actor) + evidence; 404 for another org', async () => {
    const created = await call('POST', '/incidents', ADMIN_A, { title: 'Outage', kind: 'security_incident', regimes: ['DORA'] });
    state.calls = []; state.evidence = [];
    const res = await call('POST', `/incidents/${created.body.id}/customer-notified`, ADMIN_A);
    assert.equal(res.status, 200);
    assert.equal(res.body.customer_notified_at, 'now');
    const s = state.calls.find(x => x.name === 'stampCustomerNotified');
    assert.deepEqual([s.orgId, s.args[0], s.args[1]], ['org_a', created.body.id, 'u_a']);
    assert.equal(state.evidence[0].payload.action, 'customer_notified');
    assert.deepEqual(state.evidence[0].payload.regimes, ['DORA']);
    assert.equal(state.evidence[0].check_id, 'GDPR-Art33-breach-detection');

    state.calls = [];
    assert.equal((await call('POST', `/incidents/${created.body.id}/customer-notified`, ADMIN_B)).status, 404);
    assert.ok(!state.calls.some(x => x.name === 'stampCustomerNotified'));
    assert.equal((await call('POST', '/incidents/abc/customer-notified', ADMIN_A)).status, 404);
});

// ── Legacy PATCH stamp ───────────────────────────────────────────────

test('PATCH status authority_notified still writes the Art-33 evidence stamp', async () => {
    const created = await call('POST', '/incidents', ADMIN_A, { title: 'b' });
    state.evidence = [];
    const res = await call('PATCH', `/incidents/${created.body.id}`, ADMIN_A, { status: 'authority_notified', authority_reference: 'AP-1' });
    assert.equal(res.status, 200);
    assert.equal(state.evidence.length, 1);
    assert.equal(state.evidence[0].payload.action, 'authority_notified');
    assert.equal(state.evidence[0].payload.reference, 'AP-1');
});

// ── Breach-recipient notification (the one route that mails people) ──
//
// This is the only incident route that sends personal data anywhere, and its
// evidence row is permanent: `compliance_evidence` is hash-linked and
// append-only, so whatever it writes can never be corrected, minimised or
// erased. BFSF-441 therefore splits the act in two — the addresses go to the
// mail transport (that IS the channel) and the ledger gets an allow-listed
// account of what happened: action, incident, channel, count, actor, time.

const RECIPIENTS = ['dpo@acme.example', 'security@acme.example'];

async function seedBreach(session = ADMIN_A, settings = { breach_recipients: RECIPIENTS }) {
    const created = await call('POST', '/incidents', session, { title: 'Laptop lost', description: 'A laptop with customer records went missing' });
    state.settings[session.user.orgId] = settings;
    state.calls = []; state.evidence = []; state.events = []; state.reruns = []; state.mails = [];
    return created.body.id;
}

test('notify-recipients: the gate — anonymous 401, non-admin 403, foreign or unknown incident 404, and nothing is sent', async () => {
    const id = await seedBreach();

    assert.equal((await call('POST', `/incidents/${id}/notify-recipients`, null)).status, 401);
    assert.equal((await call('POST', `/incidents/${id}/notify-recipients`, { user: { id: 'u_x', orgId: 'org_a' } })).status, 403);
    assert.equal((await call('POST', `/incidents/${id}/notify-recipients`, ADMIN_B)).status, 404, 'another org cannot reach this incident');
    assert.equal((await call('POST', '/incidents/99999/notify-recipients', ADMIN_A)).status, 404);
    assert.equal((await call('POST', '/incidents/abc/notify-recipients', ADMIN_A)).status, 404, 'a non-numeric id is not an incident');

    assert.equal(state.mails.length, 0, 'nothing was mailed behind the gate');
    assert.equal(state.evidence.length, 0, 'and nothing was written to the chain');
    assert.ok(!state.calls.some(x => x.name === 'updateIncident'), 'no stamp either');
});

test('notify-recipients: no configured recipients → 400 no_breach_recipients, no mail, no stamp, no evidence', async () => {
    // An address without an "@" is not an address; the route must not treat a
    // list of junk as "somebody was notified".
    const id = await seedBreach(ADMIN_A, { breach_recipients: ['not-an-address', 42, null] });
    const res = await call('POST', `/incidents/${id}/notify-recipients`, ADMIN_A);
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'no_breach_recipients');
    assert.equal(state.mails.length, 0);
    assert.equal(state.evidence.length, 0);
    assert.ok(!state.calls.some(x => x.name === 'updateIncident'));

    state.settings.org_a = {};
    assert.equal((await call('POST', `/incidents/${id}/notify-recipients`, ADMIN_A)).body.error, 'no_breach_recipients', 'no setting at all is the same answer');
});

test('notify-recipients: the addresses reach the mail transport and only the transport', async () => {
    const id = await seedBreach(ADMIN_A, { breach_recipients: [...RECIPIENTS, 'junk', ''] });
    const res = await call('POST', `/incidents/${id}/notify-recipients`, ADMIN_A);
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.notified, 2, 'the two real addresses');

    // The channel: delivery is the whole point, so the transport gets them.
    assert.equal(state.mails.length, 1);
    assert.deepEqual(state.mails[0].to, RECIPIENTS);
    assert.match(state.mails[0].incidentSummary, /Laptop lost/);
    assert.match(state.mails[0].ackUrl, /\/app\/admin\/compliance\/incidents\/1$/);

    // The stamp: the register records that the internal alert went out.
    const upd = state.calls.find(x => x.name === 'updateIncident');
    assert.equal(upd.orgId, 'org_a');
    assert.equal(upd.args[0], id);
    assert.ok(upd.args[1].recipients_notified_at, 'recipients_notified_at is stamped');
    assert.ok(res.body.incident.recipients_notified_at, 'and comes back on the incident');

    // Nowhere else. Not in the response body, not in the ledger.
    const seen = JSON.stringify({ body: res.body, evidence: state.evidence });
    assert.ok(!seen.includes('@'), 'no address survives anywhere outside the transport');
    assert.ok(!seen.includes('acme.example'), 'not even the recipients\' domain');
});

test('notify-recipients: the evidence row is an allow-list — who sent it, over what channel, to how many, when', async () => {
    const id = await seedBreach();
    await call('POST', `/incidents/${id}/notify-recipients`, ADMIN_A);

    assert.equal(state.evidence.length, 1);
    const row = state.evidence[0];
    assert.equal(row.organization_id, 'org_a');
    assert.equal(row.check_id, 'GDPR-Art33-breach-detection');
    assert.equal(row.subject_type, 'incident');
    assert.equal(row.subject_id, String(id));
    // The exact shape, not "these keys are present": a payload built by
    // deleting keys from a row would grow a new one the day a column is added.
    assert.deepEqual(
        Object.keys(row.payload).sort(),
        ['action', 'at', 'by', 'channel', 'incident_id', 'recipient_count'],
    );
    assert.equal(row.payload.action, 'recipients_notified');
    assert.equal(row.payload.incident_id, id);
    assert.equal(row.payload.channel, 'email');
    assert.equal(row.payload.recipient_count, RECIPIENTS.length);
    assert.equal(row.payload.by, 'u_a');
    assert.match(row.payload.at, /^\d{4}-\d\d-\d\dT/);
    // Two of the fields an auditor would otherwise have to take on trust —
    // "how many" must be a number, never the list it was counted from.
    assert.equal(typeof row.payload.recipient_count, 'number');
    assert.ok(!('recipients' in row.payload), 'the address list is not carried');
    assert.ok(!JSON.stringify(row).includes('Laptop lost'), 'nor the incident\'s own free text');
});

test('notify-recipients: a mail failure is a refusal — 502, no stamp, no evidence, and the transport\'s message never escapes', async () => {
    const id = await seedBreach();
    state.mailFail = 'dpo@acme.example';
    const res = await call('POST', `/incidents/${id}/notify-recipients`, ADMIN_A);

    assert.equal(res.status, 502);
    assert.equal(res.body.error, 'notification_failed');
    // An SMTP rejection quotes the address it bounced on. That string is a
    // response body away from the browser and a log line away from the disk.
    const seen = JSON.stringify(res.body);
    assert.ok(!seen.includes('@'), 'the transport message is not reflected back');
    assert.ok(!seen.includes('acme.example'));
    assert.ok(!seen.includes('550'));

    assert.ok(!state.calls.some(x => x.name === 'updateIncident'), 'nothing went out, so nothing is stamped');
    assert.equal(state.evidence.length, 0, 'and the chain does not attest to a notification that never happened');

    // It recovers: the next attempt, with a working transport, is a normal send.
    state.mailFail = null;
    const ok = await call('POST', `/incidents/${id}/notify-recipients`, ADMIN_A);
    assert.equal(ok.status, 200);
    assert.equal(state.evidence.length, 1);
    assert.equal(state.evidence[0].payload.recipient_count, RECIPIENTS.length);
});

// ── The ledger write cannot fail silently ────────────────────────────

test('a failed evidence write still registers the incident, but is reported instead of swallowed', async () => {
    // The register must not refuse a breach report because the append-only
    // trail hiccuped — but "the attestation happened and was never recorded"
    // has to be visible to somebody. It reaches the chain report through
    // compliance/evidence/writeFailures.
    state.evidenceFail = true;
    const res = await call('POST', '/incidents', ADMIN_A, { title: 'Laptop lost', severity: 'high' });
    assert.equal(res.status, 201, 'the incident is still registered');
    assert.equal(state.evidence.length, 0, 'and the ledger row really is missing');
    await tick();

    const reported = writeFailures.writeFailureSummary('org_a');
    assert.ok(reported, 'the swallowed write is reported');
    assert.equal(reported.count, 1);
    assert.equal(reported.recent[0].check_id, 'GDPR-Art33-breach-detection');
    assert.equal(reported.recent[0].subject_type, 'incident');
    assert.equal(reported.recent[0].error_type, '55P03');
    assert.ok(!JSON.stringify(reported).includes('Laptop lost'), 'the incident title never travels');
    assert.equal(writeFailures.writeFailureSummary('org_b'), null, 'org-scoped');
});
