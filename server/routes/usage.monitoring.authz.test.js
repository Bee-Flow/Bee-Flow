/**
 * Authorization matrix for the monitoring read endpoints.
 *
 * Until requireMonitoringScope existed, /api/usage/guardrails/* and
 * /api/usage/integrations/* were readable by ANY authenticated org member —
 * the org's whole egress ledger, per-user violation counts and detected PII
 * categories included. The licence gate in index.js checks a capability, not
 * a role. This file pins the fix:
 *
 *   org admin            → 200, org forced from the SESSION
 *   plain org member     → 403
 *   super admin + org    → 200
 *   super admin, org-less→ 403 (per-org dashboards, not a global console)
 *   consumer (no org)    → 200 scoped to their OWN rows, ?user= can't widen it
 *
 * Plus: dashboards exclude dry runs, limits clamp, keyset cursor reaches the
 * store, and the consumption endpoints stay member-readable (only the
 * monitoring prefix is admin-gated).
 *
 * Hermetic: stores and auth are stubbed. Run:
 *   node --test server/routes/usage.monitoring.authz.test.js
 */

const assert = require('node:assert');
const { test } = require('node:test');
const path = require('path');
const Module = require('module');
const http = require('http');

// ── Mutable test state ─────────────────────────────────────────────────
let orgIdsResult = new Set(['org_a']);   // what resolveUserOrgIds returns
let userOrgRole = 'member';              // what userStore.getUser reports
let userRecordOrgId = null;              // organizationId on the user RECORD (super-admin path)
const captured = {};                     // store-call capture, per fn name
let avatarRows = [];                     // what userStore.getUserAvatarsByIds returns

// ── Stubs ──────────────────────────────────────────────────────────────
const authStub = {
    async resolveUserOrgIds() { return orgIdsResult; },
    isOrgAdminRole: (role) => role === 'org_admin' || role === 'org_owner',
};
const userStoreStub = {
    async getUser(id) { return { id, orgRole: userOrgRole, organizationId: userRecordOrgId }; },
    async getUserAvatarsByIds(ids) { captured.avatarIds = ids; return avatarRows; },
    async getAllUserAvatars() { throw new Error('full-table avatar scan must not run on monitoring endpoints'); },
    async getConsumerSubscription() { return null; },
    async getOrgSubscription() { return null; },
    async getPlan() { return null; },
};
const guardStoreStub = {
    async getGuardrailOverview(filters, interval) {
        captured.guardOverview = { filters, interval };
        return {
            summary: { total_events: 3, pii_count: 1 },
            timeline: [], top_categories: [], by_action: [],
            top_users: [{ user_id: 'u1', total: 3 }],
            health: { last_event_at: null },
        };
    },
    async getGuardrailSummary(filters) { captured.guardSummary = filters; return { total_events: 1 }; },
    async getGuardrailTimeline(filters) { captured.guardTimeline = filters; return []; },
    async getGuardrailByUser(filters) { captured.guardByUser = filters; return []; },
    async getGuardrailByCategory(filters) { captured.guardByCat = filters; return []; },
    async getGuardrailByAction(filters) { captured.guardByAction = filters; return []; },
    async getRecentGuardrailEvents(limit, filters) { captured.guardRecent = { limit, filters }; return []; },
};
const integStoreStub = {
    async getIntegrationOverview(filters, interval) {
        captured.integOverview = { filters, interval };
        return {
            summary: { total_calls: 10, non_eu_count: 2, pii_non_eu_count: 1, sovereignty_score: 73, score_delta: -4 },
            timeline: [],
            top: { destinations: [{ dest_host: 'api.openai.com', country_code: 'US' }], non_eu_destinations: [], integrations: [], actors: [], users: [{ user_id: 'u1', total: 10 }] },
            pii_categories: [], data_categories: [],
            health: { last_event_at: null, scan_levels: { full: 0, basic: 0, none: 0 }, unknown_operator_pct: 0 },
        };
    },
    async getIntegrationSummary(filters) { captured.integSummary = filters; return { total_calls: 0 }; },
    async getIntegrationTimeline(_filters) { return []; },
    async getIntegrationByType(_filters) { return []; },
    async getIntegrationByTool(_filters) { return []; },
    async getIntegrationPiiSummary(_filters) { return []; },
    async getIntegrationServers(_filters) { return []; },
    async getRecentIntegrationActivity(limit, filters) { captured.integRecent = { limit, filters }; return []; },
    async getEgressLog(filters, limit) { captured.egress = { filters, limit }; return []; },
    async getOperatorSummary(_filters) { return []; },
    async getSovereigntyByDimension(dim, filters) { captured.sovereignty = { dim, filters }; return []; },
};
const usageStoreStub = {
    async getUsageSummary(filters) { captured.usageSummary = filters; return { total_calls: 5, estimated_cost: 1 }; },
    async getUsageByModel() { return []; },
};

const ROUTES_DIR = path.sep + 'routes' + path.sep;
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && parent.filename && parent.filename.includes(ROUTES_DIR)) {
        const map = {
            '../auth': '__stub_auth_monauthz__.js',
            '../stores/userStore': '__stub_user_monauthz__.js',
            '../stores/guardrailEventStore': '__stub_guard_monauthz__.js',
            '../stores/integrationActivityStore': '__stub_integ_monauthz__.js',
            '../stores/usageStore': '__stub_usage_monauthz__.js',
            '../stores/azureServiceUsageStore': '__stub_azure_monauthz__.js',
            '../core/llm/modelCosts': '__stub_costs_monauthz__.js',
            '../stores/serverGeoResolver': '__stub_geo_monauthz__.js',
            '../license': '__stub_lic_monauthz__.js',
        };
        if (map[request]) return path.join(__dirname, map[request]);
    }
    return origResolve.call(this, request, parent, ...rest);
};
for (const [fname, exp] of Object.entries({
    '__stub_auth_monauthz__.js': authStub,
    '__stub_user_monauthz__.js': userStoreStub,
    '__stub_guard_monauthz__.js': guardStoreStub,
    '__stub_integ_monauthz__.js': integStoreStub,
    '__stub_usage_monauthz__.js': usageStoreStub,
    '__stub_azure_monauthz__.js': { async getAzureServiceSummary() { return { total_cost: 0 }; } },
    '__stub_costs_monauthz__.js': { computeCostSplit: () => ({ input_cost: 0, output_cost: 0 }) },
    '__stub_geo_monauthz__.js': { countryFlag: () => '🌐' },
    '__stub_lic_monauthz__.js': { serverLicenseGovernsOrgs: () => true },
})) {
    const full = path.join(__dirname, fname);
    require.cache[full] = { id: full, filename: full, loaded: true, exports: exp };
}

const express = require('express');
const router = require('./usage');
const app = express();
let currentSession = null;
app.use((req, _res, next) => { req.session = currentSession; next(); });
app.use('/api/usage', router);
const server = app.listen(0);

function get(pathname) {
    const { port } = server.address();
    return new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}${pathname}`, (res) => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                let body = null;
                try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* raw */ }
                resolve({ status: res.statusCode, body });
            });
        }).on('error', reject);
    });
}

const asOrgUser = (role) => {
    orgIdsResult = new Set(['org_a']);
    userOrgRole = role;
    userRecordOrgId = 'org_a';
    currentSession = { isAuthenticated: true, user: { id: 'u1', organizationId: 'org_a' } };
};

test('plain org member gets 403 on every monitoring prefix', async () => {
    asOrgUser('member');
    for (const p of ['/api/usage/guardrails/summary', '/api/usage/guardrails/recent',
        '/api/usage/integrations/summary', '/api/usage/integrations/egress',
        '/api/usage/integrations/sovereignty?dimension=user']) {
        const r = await get(p);
        assert.strictEqual(r.status, 403, `${p} answered ${r.status} for a plain member`);
    }
});

test('org admin gets 200, org forced from session, dry runs excluded', async () => {
    asOrgUser('org_admin');
    const r = await get('/api/usage/guardrails/summary?days=7');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(captured.guardSummary.organizationId, 'org_a');
    assert.strictEqual(captured.guardSummary.excludeDryRun, true);
});

test('super admin with an org on their RECORD passes, scoped to that org', async () => {
    // resolveUserOrgIds is deliberately org-blind for admins (returns null),
    // so the middleware must fall back to the admin's own user record. The
    // role check is bypassed (userOrgRole stays 'member').
    orgIdsResult = null;
    userOrgRole = 'member';
    userRecordOrgId = 'org_admins_own';
    currentSession = { isAuthenticated: true, isAdmin: true, user: { id: 'admin', role: 'admin' } };
    const r = await get('/api/usage/integrations/summary');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(captured.integSummary.organizationId, 'org_admins_own');
});

test('super admin with NO org anywhere gets 403 (per-org dashboards)', async () => {
    orgIdsResult = null;
    userRecordOrgId = null;
    currentSession = { isAuthenticated: true, isAdmin: true, user: { id: 'admin', role: 'admin' } };
    const r = await get('/api/usage/guardrails/summary');
    assert.strictEqual(r.status, 403);
});

test('consumer account is scoped to its OWN rows; ?user= cannot widen it', async () => {
    orgIdsResult = new Set();
    currentSession = { isAuthenticated: true, user: { id: 'consumer-1' } };
    const r = await get('/api/usage/integrations/egress?user=victim-2');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(captured.egress.filters.userId, 'consumer-1', '?user= must not override the session scope');
    assert.strictEqual(captured.egress.filters.organizationId, undefined);
    assert.strictEqual(captured.egress.filters.excludeDryRun, true);
});

test('limits clamp and the keyset cursor reaches the store', async () => {
    asOrgUser('org_admin');
    await get('/api/usage/guardrails/recent?limit=99999&cursor=442&type=pii');
    assert.strictEqual(captured.guardRecent.limit, 200);
    assert.strictEqual(captured.guardRecent.filters.beforeId, 442);
    assert.strictEqual(captured.guardRecent.filters.violationType, 'pii');

    await get('/api/usage/integrations/egress?limit=99999&cursor=17');
    assert.strictEqual(captured.egress.limit, 200);
    assert.strictEqual(captured.egress.filters.beforeId, 17);
});

test('the consolidated overviews answer with their full shape, admin-gated', async () => {
    asOrgUser('member');
    assert.strictEqual((await get('/api/usage/guardrails/overview')).status, 403);
    assert.strictEqual((await get('/api/usage/integrations-health')).status, 403);

    asOrgUser('org_admin');
    const g = await get('/api/usage/guardrails/overview?days=7&interval=day');
    assert.strictEqual(g.status, 200);
    assert.strictEqual(g.body.summary.total_events, 3);
    assert.ok(Array.isArray(g.body.top_users));
    assert.strictEqual(g.body.top_users[0].display_name, 'u1', 'withUser enrichment ran');
    assert.ok(g.body.window, 'window echo present');
    assert.strictEqual(captured.guardOverview.filters.excludeDryRun, true);

    const i = await get('/api/usage/integrations/overview?days=30');
    assert.strictEqual(i.status, 200);
    assert.strictEqual(i.body.summary.sovereignty_score, 73, 'score comes from the SERVER');
    assert.strictEqual(i.body.top.destinations[0].country_flag, '🌐', 'flags added route-side');

    const h = await get('/api/usage/integrations-health');
    assert.strictEqual(h.status, 200);
    assert.ok('scan_levels' in h.body);
});

test('superseded endpoints answer with a Deprecation header', async () => {
    asOrgUser('org_admin');
    const { port } = server.address();
    const dep = await new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}/api/usage/integrations/summary`, (res) => {
            res.resume();
            resolve(res.headers.deprecation);
        }).on('error', reject);
    });
    assert.strictEqual(dep, 'true');
});

test('consumption endpoints stay member-readable (only the monitoring prefix is gated)', async () => {
    asOrgUser('member');
    const r = await get('/api/usage/summary');
    assert.strictEqual(r.status, 200, 'the Usage overview must not require org admin');
});

test('unauthenticated gets 401 before any scope logic', async () => {
    currentSession = null;
    const r = await get('/api/usage/guardrails/summary');
    assert.strictEqual(r.status, 401);
});

test.after(() => {
    server.close();
    Module._resolveFilename = origResolve;
});

test('a row never carries an inline image as its avatar — only a short URL or an emoji', async () => {
    // withUser copies the avatar onto EVERY row, and the ledgers answer 200
    // rows each. One account with a 2.2 MB base64 picture made the two detail
    // responses of "What happened" over 100 MB of JSON, which stalled the
    // server for seconds while it was stringified. A picture is a link.
    asOrgUser('org_admin');
    avatarRows = [
        { id: 'u1', username: 'kim', displayName: 'Kim', avatarType: 'url', avatar: 'data:image/png;base64,' + 'A'.repeat(2_300_000) },
    ];
    try {
        const big = await get('/api/usage/guardrails/overview?days=7');
        assert.strictEqual(big.status, 200);
        assert.strictEqual(big.body.top_users[0].display_name, 'Kim');
        assert.strictEqual(big.body.top_users[0].avatarType, 'url', 'the type still says a picture exists');
        assert.strictEqual(big.body.top_users[0].avatar, null, 'the inline image is not copied onto the row');

        avatarRows = [{ id: 'u1', username: 'kim', displayName: 'Kim', avatarType: 'url', avatar: '/uploads/kim.png' }];
        const small = await get('/api/usage/guardrails/overview?days=7');
        assert.strictEqual(small.body.top_users[0].avatar, '/uploads/kim.png', 'an uploaded picture is a short link and rides along');
    } finally {
        avatarRows = [];
    }
});
