/**
 * Route tests for /api/compliance/chat-monitoring (routes/compliance/chatMonitoring.js).
 *
 * The stores, the resolver, the auth gate and the event bus are doubles keyed
 * by the require strings the route uses; the vocabulary, the rules, the
 * suppression helpers, validation and the terminal error handler are real.
 * What is pinned is the boundary as an admin meets it:
 *
 *   · every precondition refuses with field CODES (details.missing), never a value;
 *   · only an organisation admin widens (a super admin for 'default'); a DPO
 *     narrows, switches off and maintains;
 *   · the start date: +7 days for employees, earlier only acknowledged,
 *     at once for website visitors;
 *   · evidence and the access audit carry the allow-list and nothing else;
 *   · the summary shows only suppressed figures, and every read is audited.
 *
 * Run: cd server && node --test routes/compliance/chatMonitoring.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const { installResolveStub } = require('../../testUtils/stubRequire');

const DAY = 86_400_000;
const day = (offset) => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);

const calls = { saved: [], evidence: [], audit: [], events: [], invalidated: [], outcomeReads: [], contributorReads: [], discarded: [] };
const fx = { stored: {}, dpia: null, orgAdmin: true, superAdmin: false, hasOrgs: true, outcomeRows: [], kindRows: [], contributors: 12, deleted: 0 };

const restore = installResolveStub({
    '../../stores/complianceStore': {
        getSettings: async () => ({ ...fx.stored }),
        saveSettings: async (orgId, patch) => {
            calls.saved.push({ orgId, patch });
            fx.stored = { ...fx.stored, ...patch };
            return { ...fx.stored };
        },
        addEvidence: async (row) => { calls.evidence.push(row); return { id: calls.evidence.length }; },
    },
    '../../stores/dpiaStore': { getLatestForAgent: async (orgId, key) => (key === 'chat_monitoring' ? fx.dpia : null) },
    '../../stores/userStore': {
        hasAnyOrganization: async () => fx.hasOrgs,
        getUser: async (id) => (id === 'admin-1' ? { id, displayName: 'Ada Admin', email: 'ada@example.org' } : null),
        logAccessAudit: async (...args) => { calls.audit.push(args); },
    },
    '../../stores/chatSignalStore': {
        outcomeTotals: async (orgId, w) => { calls.outcomeReads.push({ orgId, ...w }); return fx.outcomeRows.filter(r => w.surfaces.includes(r.surface)); },
        kindTotals: async (orgId, w) => fx.kindRows.filter(r => w.surfaces.includes(r.surface)),
        contributorCount: async (orgId, surface, w) => {
            calls.contributorReads.push({ surface, ...w });
            return typeof fx.contributors === 'function' ? fx.contributors(w) : fx.contributors;
        },
        deleteAll: async () => fx.deleted,
    },
    '../../core/entitlements/chatMonitoringFlag': {
        resolveChatMonitoring: async () => ({ state: 'off', version: null, from: null, surfaces: [], paused: [], signals: [], noticeUrl: null, visitorNoticeUrl: null, retentionDays: 90 }),
        invalidate: (orgId) => calls.invalidated.push(orgId),
    },
    '../../auth/permissions': {
        requireAuth: (req, res, next) => (req.headers['x-test-user'] ? next() : res.status(401).json({ error: 'Not authenticated' })),
        requirePermission: () => (req, res, next) => next(),
        isOrgAdminForOrg: async () => fx.orgAdmin || fx.superAdmin,
        isSuperAdmin: () => fx.superAdmin,
    },
    './shared': { resolveOrgId: async (req) => req.headers['x-test-org'] || 'default' },
    '../../compliance/evidence/writeFailures': { onEvidenceWriteFailed: () => () => {} },
    '../../compliance/events': {
        EVENTS: { CHAT_MONITORING_CHANGED: 'chat_monitoring_changed' },
        emit: (name, payload) => calls.events.push({ name, payload }),
    },
    '../../utils/appPaths': { publicBaseUrl: (o) => o || 'https://app.example.test', publicDsrPath: () => '/privacy/requests' },
    '../../jobs/monitoringRetention': { RETENTION_DAYS: 400 },
    '../../core/privacy/chatSignals': { discardOrg: (orgId) => { calls.discarded.push(orgId); return 0; } },
});
const router = require('./chatMonitoring');
const { terminalErrorHandler } = require('../../core/http/terminalErrorHandler');
test.after(() => restore());

let server; let baseUrl;
test.before(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.session = req.headers['x-test-user'] ? { isAuthenticated: true, user: { id: req.headers['x-test-user'] } } : {}; next(); });
    app.use('/api/compliance', router);
    app.use(terminalErrorHandler);
    server = http.createServer(app);
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { if (server) await new Promise(r => server.close(r)); });

const OFF_ROW = { organization_id: 'orgA', chat_monitoring_enabled: false, chat_monitoring_surfaces: [], chat_monitoring_signals: [], dpo_name: null, dpo_email: null, privacy_notice_url: null };
test.beforeEach(() => {
    for (const k of Object.keys(calls)) calls[k].length = 0;
    Object.assign(fx, { stored: { ...OFF_ROW }, dpia: { approved_at: new Date(Date.now() - 10 * DAY).toISOString(), expires_at: null, risk_level: 'medium' }, orgAdmin: true, superAdmin: false, hasOrgs: true, outcomeRows: [], kindRows: [], contributors: 12, deleted: 0 });
});

const hdrs = (org = 'orgA') => ({ 'x-test-user': 'admin-1', 'x-test-org': org, 'content-type': 'application/json' });
const put = (b, org) => fetch(`${baseUrl}/api/compliance/chat-monitoring`, { method: 'PUT', headers: hdrs(org), body: JSON.stringify(b) });

function body(over = {}) {
    return {
        enabled: true,
        surfaces: ['direct', 'agent', 'agent_public'],
        signals: ['outcomes', 'kinds'],
        effective_from: null,
        retention_days: 90,
        legal_basis: 'art6_1_c',
        works_council: 'consent',
        works_council_reason: null,
        works_council_at: day(-30),
        works_council_scope: { surfaces: ['direct', 'agent'], signals: ['outcomes', 'kinds'], max_retention_days: 90 },
        dpia_ref: null,
        dpia_at: null,
        dpia_risk_level: null,
        dpo_advice_at: null,
        prior_consultation_at: null,
        notice_url: 'https://intranet.example.org/chat-signals',
        notice_published_at: day(-1),
        acknowledgements: { notice_published: true, ropa_reviewed: true },
        ...over,
    };
}

/** Switch on with a good body, then forget the calls it made. */
async function switchOn(over = {}) {
    const res = await put(body(over));
    assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
    for (const k of Object.keys(calls)) calls[k].length = 0;
    return res.json();
}

test('401 without a session', async () => {
    const res = await fetch(`${baseUrl}/api/compliance/chat-monitoring`);
    assert.equal(res.status, 401);
});

test('GET: the settings card shape, no-store, and never an id', async () => {
    const res = await fetch(`${baseUrl}/api/compliance/chat-monitoring`, { headers: hdrs() });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const v = await res.json();
    assert.deepEqual(Object.keys(v).sort(), ['can_widen', 'catalogue', 'contributors', 'dpia', 'dpo_recorded', 'effective', 'install_has_organisations', 'privacy_notice_url_set', 'settings', 'template'].sort());
    assert.equal(v.settings.enabled, false);
    assert.equal(v.settings.retention_days, 90);
    assert.deepEqual(v.catalogue.surfaces.map(s => [s.id, s.population, s.available]), [
        ['direct', 'employees', true], ['agent', 'employees', true], ['agent_public', 'visitors', true], ['notebook', 'employees', false],
    ]);
    assert.deepEqual(v.catalogue.k, { outcomes: 5, kinds: 10 });
    assert.deepEqual(v.contributors, { direct: '10-24', agent: '10-24' }, 'bands, never a number');
    assert.equal(v.dpia.kind, 'internal');
    assert.equal(v.template.dsr_url, 'https://app.example.test/privacy/requests');
    assert.equal(v.template.shield_log_retention_days, 400);
    assert.equal(v.can_widen, true);
    assert.equal(calls.contributorReads.length, 2);
    assert.ok(calls.contributorReads.every(r => new Date(`${r.from}T00:00:00Z`).getUTCDay() === 1), 'completed ISO weeks');
});

test('PUT switch on: saved, stamped, effective in 7 days, invalidated, event emitted', async () => {
    const before = Date.now();
    const res = await put(body());
    assert.equal(res.status, 200);
    const patch = calls.saved[0].patch;
    assert.equal(patch.chat_monitoring_enabled, true);
    const start = Date.parse(patch.chat_monitoring_effective_from);
    assert.ok(start >= before + 7 * DAY - 1000 && start <= Date.now() + 7 * DAY, 'now + 7 days by default');
    assert.equal(patch.chat_monitoring_enabled_by, 'admin-1', 'the row keeps the deciding admin');
    assert.ok(patch.chat_monitoring_enabled_at);
    assert.deepEqual(calls.invalidated, ['orgA']);
    assert.deepEqual(calls.events, [{ name: 'chat_monitoring_changed', payload: { orgId: 'orgA' } }]);
    const v = await res.json();
    assert.equal(v.settings.enabled_by_name, 'Ada Admin');
    assert.ok(!JSON.stringify(v).includes('admin-1'), 'the response names, never ids');
});

test('every precondition refuses with field codes only, never the submitted values', async () => {
    const res = await put(body({
        legal_basis: null, works_council: 'pending', notice_url: null, notice_published_at: null,
        dpia_ref: 'DPIA about Jan Jansen', acknowledgements: {},
    }));
    assert.equal(res.status, 422);
    const out = await res.json();
    assert.equal(out.code, 'chat_monitoring_preconditions');
    assert.deepEqual(out.details.missing, ['legal_basis', 'notice_published', 'ropa_reviewed', 'works_council', 'notice_url', 'notice_published_at', 'agent_public_notice']);
    assert.ok(!JSON.stringify(out).includes('Jan Jansen'));
    assert.equal(calls.saved.length, 0, 'nothing written');
    assert.equal(calls.events.length, 0);

    fx.dpia = null;
    const noDpia = await (await put(body())).json();
    assert.deepEqual(noDpia.details.missing, ['dpia']);
    fx.dpia = { approved_at: new Date(Date.now() - 10 * DAY).toISOString(), risk_level: 'high' };
    assert.deepEqual((await (await put(body())).json()).details.missing, ['prior_consultation_at']);
    fx.dpia = { approved_at: new Date(Date.now() - 10 * DAY).toISOString(), risk_level: 'medium' };
    fx.stored.dpo_email = 'dpo@example.org';
    assert.deepEqual((await (await put(body())).json()).details.missing, ['dpo_advice_at']);
    assert.equal((await put(body({ dpo_advice_at: day(-2) }))).status, 200);
});

test('works council pending blocks employee surfaces only', async () => {
    assert.deepEqual((await (await put(body({ works_council: 'pending', surfaces: ['direct'] }))).json()).details.missing, ['works_council']);
    const visitors = await put(body({ works_council: 'pending', surfaces: ['agent_public'], signals: ['outcomes'] }));
    assert.equal(visitors.status, 200, 'website visitors are not held by the works council');
});

test('body validation: unknown keys, an http notice and a non-list are 400 in words', async () => {
    for (const [b, field] of [
        [{ ...body(), special_kinds: true }, 'body'],
        [body({ notice_url: 'http://intranet.example.org' }), 'body.notice_url'],
        [body({ surfaces: 'direct' }), 'body.surfaces'],
        [body({ surfaces: ['project_chat'] }), 'body.surfaces.0'],
        [body({ retention_days: 365 }), 'body.retention_days'],
        [body({ acknowledgements: { small_org: true } }), 'body.acknowledgements'],
    ]) {
        const res = await put(b);
        assert.equal(res.status, 400, field);
        const out = await res.json();
        assert.equal(out.code, 'invalid_request');
        assert.ok(out.details.some(d => d.path.startsWith(field)), `${field}: ${JSON.stringify(out.details)}`);
    }
    const missing = { ...body() };
    delete missing.dpia_ref;
    assert.equal((await put(missing)).status, 400, 'a full replacement: every field is sent');
});

test('a DPO (no org admin) narrows, switches off and maintains, but cannot widen', async () => {
    await switchOn();
    fx.orgAdmin = false;
    const widen = await put(body({ retention_days: 90, surfaces: ['direct', 'agent', 'agent_public'], legal_basis: 'art6_1_e' }));
    assert.equal(widen.status, 403);
    assert.equal((await widen.json()).code, 'chat_monitoring_widen_forbidden');

    const maintain = await put(body({ notice_url: 'https://intranet.example.org/v2' }));
    assert.equal(maintain.status, 200, 'maintain');
    const narrow = await put(body({ surfaces: ['direct'] }));
    assert.equal(narrow.status, 200, 'narrow');
    const off = await put(body({ enabled: false, acknowledgements: {} }));
    assert.equal(off.status, 200, 'off');
    const patch = calls.saved.at(-1).patch;
    assert.equal(patch.chat_monitoring_effective_from, null);
    assert.equal(patch.chat_monitoring_enabled_at, null);
    assert.equal(patch.chat_monitoring_enabled_by, null);
});

test('a pure narrow skips the preconditions, but on with nothing selected is refused', async () => {
    await switchOn();
    fx.dpia = null;   // the DPIA lapsed since: a narrow must still be possible
    assert.equal((await put(body({ surfaces: ['direct', 'agent_public'] }))).status, 200, 'a pure narrow saves despite the lapsed DPIA');
    const narrowAndEdit = await put(body({ surfaces: ['direct'], notice_url: 'https://intranet.example.org/v3' }));
    assert.deepEqual((await narrowAndEdit.json()).details.missing, ['dpia'], 'a narrow that also edits the notice is checked');
    const empty = await put(body({ surfaces: [] }));
    assert.equal(empty.status, 422);
    assert.deepEqual((await empty.json()).details.missing, ['surfaces_required']);
    const noOutcomes = await put(body({ signals: ['kinds'], surfaces: ['direct'] }));
    assert.ok((await noOutcomes.json()).details.missing.includes('outcomes_required'));
});

test('a retention increase is a widen', async () => {
    await switchOn({ retention_days: 60, works_council_scope: { surfaces: ['direct', 'agent'], signals: ['outcomes', 'kinds'], max_retention_days: 90 } });
    fx.orgAdmin = false;
    assert.equal((await put(body({ retention_days: 90 }))).status, 403);
    fx.orgAdmin = true;
    const startBefore = fx.stored.chat_monitoring_effective_from;
    assert.equal((await put(body({ retention_days: 90 }))).status, 200);
    assert.notEqual(fx.stored.chat_monitoring_effective_from, startBefore, 'a widen moves the start (and the notice version)');
});

test('the default bucket needs a super admin to widen', async () => {
    fx.hasOrgs = false;
    const orgAdminOnly = await put(body(), 'default');
    assert.equal(orgAdminOnly.status, 403);
    fx.superAdmin = true;
    assert.equal((await put(body(), 'default')).status, 200);
});

test('the default bucket on an installation with organisations refuses employee surfaces', async () => {
    fx.superAdmin = true;
    const res = await put(body(), 'default');
    assert.equal(res.status, 422);
    assert.deepEqual((await res.json()).details.missing, ['default_bucket_has_orgs']);
});

test('start date: an earlier start needs the acknowledgement; website visitors start at once', async () => {
    const early = new Date(Date.now() + 2 * DAY).toISOString();
    const refused = await put(body({ effective_from: early }));
    assert.deepEqual((await refused.json()).details.missing, ['informed_before_start']);
    const past = await put(body({ effective_from: new Date(Date.now() - 3 * DAY).toISOString() }));
    assert.deepEqual((await past.json()).details.missing, ['effective_from']);

    const ok = await put(body({ effective_from: early, acknowledgements: { notice_published: true, ropa_reviewed: true, informed_before_start: true } }));
    assert.equal(ok.status, 200);
    assert.equal(calls.saved[0].patch.chat_monitoring_effective_from, early);
    assert.equal(calls.evidence[0].payload.early_start_attested, true);

    fx.stored = { ...OFF_ROW };
    calls.saved.length = 0;
    const before = Date.now();
    const visitors = await put(body({ surfaces: ['agent_public'], effective_from: new Date(Date.now() + 30 * DAY).toISOString() }));
    assert.equal(visitors.status, 200);
    const start = Date.parse(calls.saved[0].patch.chat_monitoring_effective_from);
    assert.ok(start >= before - 1000 && start <= Date.now(), 'immediate');
});

test('widening beyond the works-council scope fails; a newer date with a covering scope passes', async () => {
    await switchOn({ surfaces: ['direct'], signals: ['outcomes'], works_council_scope: { surfaces: ['direct'], signals: ['outcomes'], max_retention_days: 90 } });
    const beyond = await put(body({ surfaces: ['direct'], signals: ['outcomes', 'kinds'], works_council_scope: { surfaces: ['direct'], signals: ['outcomes'], max_retention_days: 90 } }));
    assert.deepEqual((await beyond.json()).details.missing, ['works_council_scope']);
    const wider = { surfaces: ['direct'], signals: ['outcomes', 'kinds'], max_retention_days: 90 };
    const sameDate = await put(body({ surfaces: ['direct'], signals: ['outcomes', 'kinds'], works_council_scope: wider }));
    assert.deepEqual((await sameDate.json()).details.missing, ['works_council_scope'], 'a wider scope needs a newer decision date');
    const newer = await put(body({ surfaces: ['direct'], signals: ['outcomes', 'kinds'], works_council_scope: wider, works_council_at: day(-1) }));
    assert.equal(newer.status, 200);
});

const EVIDENCE_KEYS = [
    'action', 'change', 'enabled', 'surfaces', 'signals', 'effective_from', 'early_start_attested',
    'legal_basis', 'lia_documented', 'works_council', 'works_council_reason', 'works_council_at',
    'works_council_scope', 'dpia', 'dpia_expires_at', 'dpia_risk_level', 'prior_consultation_at',
    'dpo_advice_at', 'notice_url_set', 'notice_published_at', 'retention_days', 'at',
];

test('evidence and the access audit carry the allow-list exactly: no DPIA text, no URL, no actor', async () => {
    fx.dpia = null;
    const res = await put(body({ dpia_ref: 'DPIA-2026 Jan Jansen', dpia_at: day(-20), dpia_risk_level: 'low', legal_basis: 'art6_1_f', acknowledgements: { notice_published: true, ropa_reviewed: true, lia_documented: true } }));
    assert.equal(res.status, 200);
    assert.equal(calls.evidence.length, 1);
    const row = calls.evidence[0];
    assert.deepEqual([row.organization_id, row.check_id, row.subject_type, row.subject_id], ['orgA', 'GDPR-Art35-chat-monitoring-safeguards', 'setting', 'chat_monitoring']);
    assert.deepEqual(Object.keys(row.payload).sort(), [...EVIDENCE_KEYS].sort());
    assert.equal(row.payload.change, 'widen');
    assert.equal(row.payload.dpia, 'external');
    assert.equal(row.payload.lia_documented, true);
    assert.equal(row.payload.notice_url_set, true);
    const text = JSON.stringify(row.payload);
    for (const needle of ['Jan Jansen', 'DPIA-2026', 'intranet.example.org', 'admin-1']) assert.ok(!text.includes(needle), needle);

    assert.equal(calls.audit.length, 1);
    const [action, targetType, targetId, actor, oldSnap, newSnap, org] = calls.audit[0];
    assert.deepEqual([action, targetType, targetId, actor, org], ['compliance_chat_monitoring_changed', 'compliance_setting', 'chat_monitoring', 'admin-1', 'orgA']);
    assert.deepEqual(newSnap, row.payload, 'the audit snapshot is the evidence allow-list');
    assert.deepEqual(Object.keys(oldSnap).sort(), [...EVIDENCE_KEYS].sort());
    assert.ok(!JSON.stringify(oldSnap).includes('intranet'));
});

test('summary: suppressed figures over completed weeks, and every read is in the access log', async () => {
    fx.stored = { ...OFF_ROW, chat_monitoring_enabled: true, chat_monitoring_surfaces: ['direct', 'agent_public'], chat_monitoring_signals: ['outcomes'], chat_monitoring_effective_from: new Date(Date.now() - 80 * DAY).toISOString() };
    fx.outcomeRows = [
        { surface: 'direct', value: 'clean', destination: 'external', provider_type: 'openai', turns: 40 },
        { surface: 'direct', value: 'blocked', destination: 'external', provider_type: 'openai', turns: 3 },
        { surface: 'agent_public', value: 'clean', destination: 'internal', provider_type: 'local', turns: 2 },
    ];
    const res = await fetch(`${baseUrl}/api/compliance/chat-monitoring/summary?days=30`, { headers: hdrs() });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const out = await res.json();
    assert.equal(out.window.days, 30);
    assert.equal(out.window.employee.granularity, 'week');
    assert.equal(new Date(`${out.window.employee.from}T00:00:00Z`).getUTCDay(), 1, 'employee windows start on a Monday');
    assert.ok(Date.parse(`${out.window.employee.to}T00:00:00Z`) + 7 * DAY <= Date.now(), 'and end with a completed week');
    assert.equal(out.window.visitor.granularity, 'day');
    assert.equal(out.surfaces.direct.outcomes.blocked, '<5');
    assert.equal(out.surfaces.direct.outcomes.clean, 'hidden', 'the single small cell cannot be recovered by subtraction');
    assert.equal(out.surfaces.direct.contributors, '10-24');
    assert.equal(out.surfaces.agent_public.turns, '<5');
    assert.deepEqual(calls.audit.map(a => [a[0], a[3], a[5], a[6]]), [['compliance_chat_monitoring_viewed', 'admin-1', { days: 30 }, 'orgA']]);

    fx.contributors = 4;
    const small = await (await fetch(`${baseUrl}/api/compliance/chat-monitoring/summary?days=90`, { headers: hdrs() })).json();
    assert.deepEqual(small.surfaces.direct, { status: 'suppressed', k: 5 });

    assert.equal((await fetch(`${baseUrl}/api/compliance/chat-monitoring/summary?days=7`, { headers: hdrs() })).status, 400);
    assert.equal((await fetch(`${baseUrl}/api/compliance/chat-monitoring/summary?user=u1`, { headers: hdrs() })).status, 400);
});

test('summary: the 90-day view is hidden when the weeks only it holds come from fewer than 5 people (no differencing against the 30-day view)', async () => {
    fx.stored = { ...OFF_ROW, chat_monitoring_enabled: true, chat_monitoring_surfaces: ['direct'], chat_monitoring_signals: ['outcomes'], chat_monitoring_effective_from: new Date(Date.now() - 200 * DAY).toISOString() };
    fx.outcomeRows = [{ surface: 'direct', value: 'clean', destination: 'external', provider_type: 'openai', turns: 400 }];
    const thirty = await (await fetch(`${baseUrl}/api/compliance/chat-monitoring/summary?days=30`, { headers: hdrs() })).json();
    const shortFrom = thirty.window.employee.from;

    // 12 people in the whole 90 days, but only 2 in the weeks before the 30-day view.
    fx.contributors = (w) => (w.toExclusive === shortFrom ? 2 : 12);
    calls.contributorReads.length = 0;
    const hidden = await (await fetch(`${baseUrl}/api/compliance/chat-monitoring/summary?days=90`, { headers: hdrs() })).json();
    assert.deepEqual(hidden.surfaces.direct, { status: 'suppressed', k: 5 });
    assert.ok(calls.contributorReads.some(r => r.toExclusive === shortFrom && r.from === hidden.window.employee.from), 'the remainder weeks are counted on their own');

    fx.contributors = (w) => (w.toExclusive === shortFrom ? 6 : 12);
    const shown = await (await fetch(`${baseUrl}/api/compliance/chat-monitoring/summary?days=90`, { headers: hdrs() })).json();
    assert.equal(shown.surfaces.direct.status, 'shown');
    assert.equal(shown.surfaces.direct.contributors, '10-24', 'the band is still the whole window');

    calls.contributorReads.length = 0;
    await fetch(`${baseUrl}/api/compliance/chat-monitoring/summary?days=30`, { headers: hdrs() });
    assert.equal(calls.contributorReads.length, 1, 'the 30-day view needs no remainder count');
});

test('summary: a start this week has no complete week yet', async () => {
    fx.stored = { ...OFF_ROW, chat_monitoring_enabled: true, chat_monitoring_surfaces: ['direct'], chat_monitoring_signals: ['outcomes'], chat_monitoring_effective_from: new Date(Date.now() - 60_000).toISOString() };
    const out = await (await fetch(`${baseUrl}/api/compliance/chat-monitoring/summary`, { headers: hdrs() })).json();
    assert.deepEqual(out.surfaces.direct, { status: 'no_full_period' });
    assert.equal(out.window.employee, null);
    assert.equal(calls.outcomeReads.length, 0);
});

test('DELETE counts: evidence, an access-audit row and the event', async () => {
    fx.deleted = 17;
    const res = await fetch(`${baseUrl}/api/compliance/chat-monitoring/counts`, { method: 'DELETE', headers: hdrs() });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { deleted: 17 });
    assert.deepEqual(calls.discarded, ['orgA'], 'counts still waiting in this process are dropped, not written back after the delete');
    assert.equal(calls.evidence.length, 1);
    assert.deepEqual(Object.keys(calls.evidence[0].payload).sort(), ['action', 'at', 'rows']);
    assert.equal(calls.evidence[0].payload.action, 'chat_signals_deleted');
    assert.equal(calls.audit[0][0], 'compliance_chat_monitoring_counts_deleted');
    assert.deepEqual(calls.events, [{ name: 'chat_monitoring_changed', payload: { orgId: 'orgA' } }]);
});
