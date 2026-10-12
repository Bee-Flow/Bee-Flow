/**
 * Special categories (GDPR Art. 9) in the per-person monitoring views.
 *
 * Health labels (MedicalCondition, Medication, HealthInsuranceNumber) next to
 * a named person reveal health data about that person (CJEU C-184/20). Until
 * per-person monitoring sits behind an opt-in with its preconditions, these
 * views show special categories as organisation totals only:
 *
 *   - rows that carry a person (/guardrails/recent, /integrations/egress,
 *     /integrations/recent) lose their health labels; a row whose labels were
 *     all health is withheld, so an empty list cannot say what was removed,
 *   - a category breakdown narrowed to one other person (?user=) has no
 *     health rows,
 *   - ?pii=<health category> is refused with ?user=, and wherever the answer
 *     lists people; the overviews drop their ranking of people instead,
 *   - organisation-wide totals keep the health categories,
 *   - a person's own rows are left as they are.
 *
 * Hermetic: stores and auth are stubbed (same harness as
 * usage.monitoring.authz.test.js). Synthetic data.
 *
 * Run: cd server && node --test routes/usage.specialCategories.test.js
 */

'use strict';

const assert = require('node:assert');
const { test } = require('node:test');
const { preloadStubs } = require('../testUtils/stubRequire');
const http = require('http');

let orgIdsResult = new Set(['org_a']);
const calls = {};

const authStub = {
    async resolveUserOrgIds() { return orgIdsResult; },
    isOrgAdminRole: (role) => role === 'org_admin',
};
const userStoreStub = {
    async getUser(id) { return { id, orgRole: 'org_admin', organizationId: 'org_a' }; },
    async getUserAvatarsByIds(ids) { return ids.map(id => ({ id, displayName: `Name of ${id}` })); },
    async getAllUserAvatars() { return []; },
    async getConsumerSubscription() { return null; },
    async getOrgSubscription() { return null; },
    async getPlan() { return null; },
};

const GUARD_ROWS = () => [
    { id: 3, user_id: 'u2', violation_type: 'pii', violation_categories: 'Person, MedicalCondition' },
    { id: 2, user_id: 'u2', violation_type: 'pii', violation_categories: 'Medication' },
    { id: 1, user_id: 'u3', violation_type: 'pii', violation_categories: 'Email' },
];
const EGRESS_ROWS = () => [
    { id: 13, user_id: 'u2', tool_name: 'gmail_send', pii_categories_detected: 'Health Insurance Number,Email' },
    { id: 12, user_id: 'u2', tool_name: 'gmail_send', pii_categories_detected: 'MedicalCondition' },
    { id: 11, user_id: 'u3', tool_name: 'gmail_send', pii_categories_detected: null },
];
const CATEGORY_ROWS = () => [
    { category: 'MedicalCondition', violation_type: 'pii', count: 4 },
    { category: 'Email', violation_type: 'pii', count: 2 },
];

const guardStoreStub = {
    async getGuardrailOverview(filters) {
        calls.guardOverview = filters;
        return { summary: {}, timeline: [], top_categories: CATEGORY_ROWS(), by_action: [], top_users: [{ user_id: 'u2', total: 6 }], health: {} };
    },
    async getGuardrailSummary(filters) { calls.guardSummary = filters; return { total_events: 6 }; },
    async getGuardrailTimeline() { return []; },
    async getGuardrailByUser(filters) { calls.guardByUser = filters; return [{ user_id: 'u2', total: 6 }]; },
    async getGuardrailByCategory(filters) { calls.guardByCat = filters; return CATEGORY_ROWS(); },
    async getGuardrailByAction() { return []; },
    async getRecentGuardrailEvents(limit, filters) { calls.guardRecent = filters; return GUARD_ROWS(); },
};
const integStoreStub = {
    async getIntegrationOverview(filters) {
        calls.integOverview = filters;
        return {
            summary: {}, timeline: [],
            top: { destinations: [], non_eu_destinations: [], integrations: [], actors: [], users: [{ user_id: 'u2', total: 3 }] },
            pii_categories: [{ category: 'MedicalCondition', count: 4, non_eu_count: 0 }, { category: 'Email', count: 1, non_eu_count: 0 }],
            data_categories: [], health: {},
        };
    },
    async getIntegrationSummary(filters) { calls.integSummary = filters; return { total_calls: 3 }; },
    async getIntegrationTimeline() { return []; },
    async getIntegrationByType() { return []; },
    async getIntegrationByTool() { return []; },
    async getIntegrationPiiSummary(filters) {
        calls.integPii = filters;
        return [{ pii_category: 'Medication', count: 2, integration_type: 'mail' }, { pii_category: 'Email', count: 1, integration_type: 'mail' }];
    },
    async getIntegrationServers() { return []; },
    async getRecentIntegrationActivity(limit, filters) { calls.integRecent = filters; return EGRESS_ROWS(); },
    async getEgressLog(filters) { calls.egress = filters; return EGRESS_ROWS(); },
    async getOperatorSummary() { return []; },
    async getSovereigntyByDimension(dim, filters) {
        calls.sovereignty = { dim, filters };
        return dim === 'pii'
            ? [{ key: 'MedicalCondition', label: 'MedicalCondition', total: 2 }, { key: 'Email', label: 'Email', total: 1 }]
            : [{ key: 'u2', label: 'u2', total: 3 }];
    },
};

// Stubs under the real resolved paths (testUtils/stubRequire), installed
// before the router is required.
preloadStubs(require, {
    '../auth': authStub,
    '../stores/userStore': userStoreStub,
    '../stores/guardrailEventStore': guardStoreStub,
    '../stores/integrationActivityStore': integStoreStub,
    '../stores/usageStore': {},
    '../stores/azureServiceUsageStore': {},
    '../core/llm/modelCosts': { computeCostSplit: () => ({ input_cost: 0, output_cost: 0 }) },
    '../stores/serverGeoResolver': { countryFlag: () => '' },
    '../license': { serverLicenseGovernsOrgs: () => true },
});

const express = require('express');
const { terminalErrorHandler } = require('../core/http/terminalErrorHandler');
const router = require('./usage');
const app = express();
let currentSession = null;
app.use((req, _res, next) => { req.session = currentSession; next(); });
app.use('/api/usage', router);
app.use(terminalErrorHandler);
const server = app.listen(0);

function get(pathname) {
    const { port } = server.address();
    return new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}/api/usage${pathname}`, (res) => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let body = null;
                try { body = JSON.parse(text); } catch { /* raw */ }
                resolve({ status: res.statusCode, body, text });
            });
        }).on('error', reject);
    });
}

const HEALTH = /medic|health/i;
const asOrgAdmin = () => {
    orgIdsResult = new Set(['org_a']);
    currentSession = { isAuthenticated: true, user: { id: 'admin-1', organizationId: 'org_a' } };
};
const asConsumer = () => {
    orgIdsResult = new Set();
    currentSession = { isAuthenticated: true, user: { id: 'u2' } };
};

test('recent Shield events: no health label next to a person; an all-health row is withheld', async () => {
    asOrgAdmin();
    const r = await get('/guardrails/recent');
    assert.strictEqual(r.status, 200);
    assert.doesNotMatch(r.text, HEALTH, r.text);
    assert.deepStrictEqual(r.body.map(x => [x.id, x.violation_categories]), [[3, 'Person'], [1, 'Email']]);
    assert.strictEqual(r.body[0].display_name, 'Name of u2');
});

test('egress and recent integration rows: no health label next to a person', async () => {
    asOrgAdmin();
    for (const p of ['/integrations/egress', '/integrations/recent']) {
        const r = await get(p);
        assert.strictEqual(r.status, 200, p);
        assert.doesNotMatch(r.text, HEALTH, `${p}: ${r.text}`);
        assert.deepStrictEqual(r.body.map(x => [x.id, x.pii_categories_detected]), [[13, 'Email'], [11, null]], p);
    }
});

test('a category breakdown narrowed to one other person has no health rows', async () => {
    asOrgAdmin();
    const byCat = await get('/guardrails/by-category?user=u2');
    assert.deepStrictEqual(byCat.body.map(x => x.category), ['Email']);
    const pii = await get('/integrations/pii-summary?user=u2');
    assert.deepStrictEqual(pii.body.map(x => x.pii_category), ['Email']);
    const sov = await get('/integrations/sovereignty?dimension=pii&user=u2');
    assert.deepStrictEqual(sov.body.map(x => x.key), ['Email']);
    const go = await get('/guardrails/overview?user=u2');
    assert.deepStrictEqual(go.body.top_categories.map(x => x.category), ['Email']);
    const io = await get('/integrations/overview?user=u2');
    assert.deepStrictEqual(io.body.pii_categories.map(x => x.category), ['Email']);
});

test('organisation-wide totals keep the health categories', async () => {
    asOrgAdmin();
    const byCat = await get('/guardrails/by-category');
    assert.deepStrictEqual(byCat.body.map(x => x.category), ['MedicalCondition', 'Email']);
    const go = await get('/guardrails/overview');
    assert.deepStrictEqual(go.body.top_categories.map(x => x.category), ['MedicalCondition', 'Email']);
    const io = await get('/integrations/overview');
    assert.deepStrictEqual(io.body.pii_categories.map(x => x.category), ['MedicalCondition', 'Email']);
    const sov = await get('/integrations/sovereignty?dimension=pii');
    assert.deepStrictEqual(sov.body.map(x => x.key), ['MedicalCondition', 'Email']);
});

test('?pii=<health category> with ?user= is refused, before any store call', async () => {
    asOrgAdmin();
    for (const p of ['/integrations/summary', '/guardrails/summary', '/integrations/overview', '/guardrails/by-category']) {
        delete calls.integSummary; delete calls.guardSummary; delete calls.integOverview; delete calls.guardByCat;
        const r = await get(`${p}?user=u2&pii=MedicalCondition`);
        assert.strictEqual(r.status, 400, p);
        assert.strictEqual(r.body.code, 'special_category_per_person', p);
        assert.strictEqual(calls.integSummary || calls.guardSummary || calls.integOverview || calls.guardByCat, undefined, `${p} reached the store`);
    }
    // Any spelling of a health category.
    assert.strictEqual((await get('/integrations/summary?user=u2&pii=Health%20Insurance%20Number')).status, 400);
});

test('?pii=<health category> is refused wherever the answer lists people', async () => {
    asOrgAdmin();
    for (const p of ['/guardrails/recent', '/guardrails/by-user', '/integrations/egress', '/integrations/recent', '/integrations/sovereignty', '/integrations/sovereignty?dimension=user']) {
        const r = await get(`${p}${p.includes('?') ? '&' : '?'}pii=Medication`);
        assert.strictEqual(r.status, 400, p);
        assert.strictEqual(r.body.code, 'special_category_per_person', p);
    }
});

test('?pii=<health category> on an organisation total answers; the overviews drop their ranking of people', async () => {
    asOrgAdmin();
    const sum = await get('/integrations/summary?pii=MedicalCondition');
    assert.strictEqual(sum.status, 200);
    assert.strictEqual(calls.integSummary.piiCategory, 'MedicalCondition');
    const sov = await get('/integrations/sovereignty?dimension=pii&pii=MedicalCondition');
    assert.strictEqual(sov.status, 200);
    const io = await get('/integrations/overview?pii=MedicalCondition');
    assert.strictEqual(io.status, 200);
    assert.deepStrictEqual(io.body.top.users, []);
    const go = await get('/guardrails/overview?pii=MedicalCondition');
    assert.strictEqual(go.status, 200);
    assert.deepStrictEqual(go.body.top_users, []);
});

test('other categories filter per person as before', async () => {
    asOrgAdmin();
    const r = await get('/integrations/egress?user=u2&pii=Email');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(calls.egress.piiCategory, 'Email');
    const go = await get('/guardrails/overview?pii=Email');
    assert.deepStrictEqual(go.body.top_users.map(x => x.user_id), ['u2']);
});

test('a person\'s own rows are left as they are', async () => {
    asConsumer();
    const r = await get('/guardrails/recent');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(calls.guardRecent.userId, 'u2');
    assert.deepStrictEqual(r.body.map(x => x.violation_categories), ['Person, MedicalCondition', 'Medication', 'Email']);
    const e = await get('/integrations/egress?pii=MedicalCondition');
    assert.strictEqual(e.status, 200);
    assert.strictEqual(e.body.length, 3);
});

test.after(() => {
    server.close();
});
