/**
 * What the incident-register routes accept, and what they say when they
 * refuse (routes/compliance/incidents.js).
 *
 * incidentStore keeps what is already on a row whenever it does not recognise
 * a value, and this register is the GDPR Art-33 / NIS2 / CRA trail an auditor
 * samples. `status: 'authority_notifed'` left the row where it was AND skipped
 * this route's evidence write, so a notification to a supervisory authority
 * was answered 200 and recorded nowhere. `severity: 'critical'` — the top
 * entry of the picker agent-hub actually renders — fell back to 'medium' on
 * create and was dropped on patch. What this file pins is the part a caller
 * can act on:
 *
 *   - the 400 NAMES the field (`body.status`), not just "invalid request";
 *   - the message is a sentence that lists the values;
 *   - the store, the evidence chain and the re-runs are never reached;
 *   - and the bodies IncidentDrawer / IncidentCreateModal really send still
 *     save, still stamp and still carry 'critical' through.
 *
 * Run: cd server && node --test routes/compliance/incidents.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every store, evidence and runner call lands in `touched`. A refused request
// must leave it empty.
const touched = [];
const pass = (req, res, next) => next();

const VALID_KINDS = ['breach', 'security_incident', 'vulnerability'];
const VALID_REGIMES = ['GDPR', 'NIS2', 'CRA', 'DORA'];

const MOCKS = {
    '../../stores/complianceStore': {
        addEvidence: async (row) => { touched.push({ what: 'addEvidence', args: [row] }); return { id: 'ev' }; },
        getSettings: async () => ({}),
    },
    '../../stores/incidentStore': {
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
            touched.push({ what: 'createIncident', args: [input] });
            return { id: 7, kind: input.kind, regimes: input.regimes, severity: input.severity };
        },
        listIncidents: async (orgId, opts) => { touched.push({ what: 'listIncidents', args: [orgId, opts] }); return []; },
        getIncident: async (orgId, id) => ({ id, kind: 'vulnerability', regimes: ['CRA'], status: 'open' }),
        updateIncident: async (orgId, id, patch) => { touched.push({ what: 'updateIncident', args: [orgId, id, patch] }); return { id, ...patch }; },
        stampCraReport: async (orgId, id, opts) => { touched.push({ what: 'stampCraReport', args: [orgId, id, opts] }); return { id, status: 'reported' }; },
        stampCustomerNotified: async (orgId, id, by) => { touched.push({ what: 'stampCustomerNotified', args: [orgId, id, by] }); return { id }; },
    },
    '../../compliance/runner': {
        runOne: async (...a) => { touched.push({ what: 'runOne', args: a }); },
    },
    '../../compliance/frameworkPolicy': {
        activeRegulations: async () => new Set(['GDPR', 'CRA', 'NIS2', 'DORA']),
    },
    '../../compliance/events': { emit: (...a) => { touched.push({ what: 'emit', args: a }); } },
    '../../compliance/evidence/writeFailures': { onEvidenceWriteFailed: () => () => {} },
    '../../auth/permissions': { requireAuth: pass, requirePermission: () => pass },
    './shared': { resolveOrgId: async () => 'orgA' },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:incidents-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /compliance[\\/]incidents\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./incidents');
test.after(() => { Module._resolveFilename = originalResolve; });

const { dispatcher } = require('../../core/http/routeHarness');

const dispatch = dispatcher(router);

test.beforeEach(() => { touched.length = 0; });

async function refuses(request, field) {
    const res = await dispatch(request);
    const what = `${request.method} ${request.url} ${JSON.stringify(request.body)}`;
    assert.strictEqual(res.statusCode, 400, what);
    assert.strictEqual(res.body.code, 'invalid_request', what);
    assert.ok(res.body.details.some((d) => d.path === field),
        `the 400 must name ${field}; it said ${JSON.stringify(res.body.details)}`);
    assert.deepStrictEqual(touched, [], 'a refused request must not reach the store');
    return res;
}

// ═══ PATCH /incidents/:id — the workflow an auditor samples ═════════

test('a misspelled status is refused instead of leaving the row untouched with no Art-33 stamp', async () => {
    const res = await refuses({ method: 'PATCH', url: '/incidents/7', body: { status: 'authority_notifed' } }, 'body.status');
    assert.strictEqual(res.body.error,
        'status is one of: open, assessing, early_warning_sent, authority_notified, reported, subjects_notified, closed.');
});

test('a severity outside the picker is refused rather than dropped from the patch', async () => {
    const res = await refuses({ method: 'PATCH', url: '/incidents/7', body: { severity: 'catastrophic' } }, 'body.severity');
    assert.strictEqual(res.body.error, 'severity is one of: low, medium, high, critical.');
});

test('"high_risk" as the string "true" is refused, not read as a boolean', async () => {
    const res = await refuses({ method: 'PATCH', url: '/incidents/7', body: { high_risk: 'true' } }, 'body.high_risk');
    assert.strictEqual(res.body.error, 'high_risk is true or false.');
});

test('a misspelled reference key is refused rather than dropped under a 200', async () => {
    await refuses({ method: 'PATCH', url: '/incidents/7', body: { status: 'authority_notified', authority_ref: 'AP-1' } }, 'body');
});

test('a body may not stamp recipients_notified_at — only the notify route writes that', async () => {
    await refuses({ method: 'PATCH', url: '/incidents/7', body: { recipients_notified_at: '2026-01-01T00:00:00Z' } }, 'body');
});

test('the drawer\'s authority stamp still saves and still writes the evidence row', async () => {
    const res = await dispatch({
        method: 'PATCH', url: '/incidents/7',
        body: { status: 'authority_notified', authority_reference: 'AP-1' },
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(touched.find((t) => t.what === 'updateIncident').args[2].status, 'authority_notified');
    const ev = touched.find((t) => t.what === 'addEvidence');
    assert.strictEqual(ev.args[0].payload.action, 'authority_notified');
    assert.strictEqual(ev.args[0].payload.reference, 'AP-1');
});

test('the drawer\'s "close after assessment" body — status plus a note — still goes through', async () => {
    const res = await dispatch({ method: 'PATCH', url: '/incidents/7', body: { status: 'closed', note: 'Closed after assessment.' } });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(touched.find((t) => t.what === 'updateIncident').args[2].note, 'Closed after assessment.');
});

// ═══ POST /incidents ═══════════════════════════════════════════════

test('an incident with no title is refused in words, not with "Required"', async () => {
    const res = await refuses({ method: 'POST', url: '/incidents', body: {} }, 'body.title');
    assert.strictEqual(res.body.error, 'An incident needs a title.');
});

test('a "critical" incident reaches the store as critical instead of being filed as medium', async () => {
    const res = await dispatch({
        method: 'POST', url: '/incidents',
        body: { kind: 'breach', title: 'Misdirected e-mail', severity: 'critical', high_risk: true },
    });
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(touched.find((t) => t.what === 'createIncident').args[0].severity, 'critical');
});

test('a misspelled severity is refused rather than silently recorded as medium', async () => {
    await refuses({ method: 'POST', url: '/incidents', body: { title: 'x', severity: 'crtical' } }, 'body.severity');
});

test('the affected-product rows agent-hub sends survive as rows, not as "[object Object]"', async () => {
    const res = await dispatch({
        method: 'POST', url: '/incidents',
        body: {
            kind: 'vulnerability', title: 'Heap overflow', severity: 'high',
            cve_ids: ['CVE-2026-1234'], exploited_in_wild: true,
            affected_products: [{ name: 'server', version_range: '< 1.2' }],
        },
    });
    assert.strictEqual(res.statusCode, 201);
    assert.deepStrictEqual(touched.find((t) => t.what === 'createIncident').args[0].affected_products,
        [{ name: 'server', version_range: '< 1.2' }]);
});

test('the comma-separated product string the API also takes still splits into names', async () => {
    const res = await dispatch({
        method: 'POST', url: '/incidents',
        body: { kind: 'vulnerability', title: 'v', affected_products: 'agent-hub, server' },
    });
    assert.strictEqual(res.statusCode, 201);
    assert.deepStrictEqual(touched.find((t) => t.what === 'createIncident').args[0].affected_products, ['agent-hub', 'server']);
});

test('an unreadable occurred_at is refused instead of reaching the column as a bad date', async () => {
    const res = await refuses({ method: 'POST', url: '/incidents', body: { title: 'x', occurred_at: 'yesterday' } }, 'body.occurred_at');
    assert.strictEqual(res.body.error, 'occurred_at must be a date.');
});

test('the datetime-local value the form posts is a date, and is accepted', async () => {
    const res = await dispatch({ method: 'POST', url: '/incidents', body: { title: 'x', occurred_at: '2026-09-22T13:45' } });
    assert.strictEqual(res.statusCode, 201);
});

test('a misspelled create key is refused rather than dropped from the row', async () => {
    await refuses({ method: 'POST', url: '/incidents', body: { title: 'x', hgih_risk: true } }, 'body');
});

test('an unknown kind keeps its own answer, which lists the kinds', async () => {
    const res = await dispatch({ method: 'POST', url: '/incidents', body: { title: 'x', kind: 'rumour' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'invalid_kind');
    assert.deepStrictEqual(res.body.allowed, VALID_KINDS);
});

test('an unknown regime keeps its own answer too', async () => {
    const res = await dispatch({ method: 'POST', url: '/incidents', body: { title: 'x', regimes: ['PCI'] } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'invalid_regime');
});

// ═══ GET /incidents ════════════════════════════════════════════════

test('a misspelled filter key is refused, not dropped into a listing of every incident', async () => {
    const res = await dispatch({ method: 'GET', url: '/incidents?staus=open' });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.body.details.some((d) => d.path === 'query'));
    assert.deepStrictEqual(touched, []);
});

test('a status that is not one of the seven is refused in words', async () => {
    const res = await dispatch({ method: 'GET', url: '/incidents?status=oepn' });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.body.error.startsWith('status is one of:'));
});

test('the kind filter the incidents page uses still reaches the store', async () => {
    const res = await dispatch({ method: 'GET', url: '/incidents?kind=vulnerability' });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(touched.find((t) => t.what === 'listIncidents').args[1].kind, 'vulnerability');
});

// ═══ POST /incidents/:id/cra-report ════════════════════════════════

test('a misspelled CRA stage is refused in words, before the incident is even read', async () => {
    const res = await refuses({ method: 'POST', url: '/incidents/7/cra-report', body: { stage: 'early_warnig' } }, 'body.stage');
    assert.strictEqual(res.body.error, 'stage is one of: early_warning, full.');
});

test('a misspelled reference key is refused rather than stamping a report with no reference', async () => {
    await refuses({ method: 'POST', url: '/incidents/7/cra-report', body: { stage: 'full', refrence: 'SRP-42' } }, 'body');
});

test('the CRA report body the drawer sends still stamps, still records and still emits', async () => {
    const res = await dispatch({
        method: 'POST', url: '/incidents/7/cra-report',
        body: { stage: 'full', reported_via: 'enisa_srp', reference: 'SRP-42' },
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(touched.find((t) => t.what === 'stampCraReport').args[2].reference, 'SRP-42');
    assert.ok(touched.some((t) => t.what === 'emit'));
});

// ═══ The two stamp routes that read nothing ════════════════════════

test('the customer-notice stamp takes an empty body, as the button posts it', async () => {
    const res = await dispatch({ method: 'POST', url: '/incidents/7/customer-notified', body: {} });
    assert.strictEqual(res.statusCode, 200);
    assert.ok(touched.some((t) => t.what === 'stampCustomerNotified'));
});

test('a key on the customer-notice stamp is refused rather than ignored', async () => {
    await refuses({ method: 'POST', url: '/incidents/7/customer-notified', body: { notified_at: '2026-01-01' } }, 'body');
});
