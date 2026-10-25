/**
 * The customer view of the usage dashboards is an allow-list.
 *
 *   1. redactRow keeps exactly the allow-listed keys plus the computed
 *      billed_cost, and an unknown new column stays out.
 *   2. Through the router: a customer gets the redacted payload, the platform
 *      operator and a self-hosted install get the raw one.
 *   3. Guard: every column alias the usage store selects (and every column of
 *      ai_usage_log) is in CUSTOMER_FIELDS or OPERATOR_ONLY_FIELDS, so a new
 *      column has to be classified before it can ship.
 *
 * Hermetic. Run: node --test server/routes/usage.customerView.test.js
 */

const assert = require('node:assert');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('module');
const http = require('http');

const { CUSTOMER_FIELDS, OPERATOR_ONLY_FIELDS, redactRow, redactRows } = require('./usageCustomerView');

// ── State and stubs for the router tests ───────────────────────────────
let governsOrgs = false;
let currentSession = null;
const RAW_ROW = {
    period: '2026-10-01', user_id: 'u1', model: 'm', source: 's',
    calls: 3, total_tokens: 10, prompt_tokens: 4, estimated_cost: 2, new_secret_cost: 9,
};

const stubs = {
    '../auth': { async resolveUserOrgIds() { return new Set(['org_a']); }, isOrgAdminRole: () => false },
    '../stores/userStore': {
        async getUserAvatarsByIds() { return []; },
        async getAllUserAvatars() { return []; },
        async getConsumerSubscription() { return null; },
        async getOrgSubscription() { return { plan_id: 'p1' }; },
        async getPlan() { return { markup_percent: 50 }; },
    },
    '../stores/usageStore': {
        async getUsageByModel() { return [{ ...RAW_ROW }]; },
        async getUsageTimeline() { return [{ ...RAW_ROW }]; },
    },
    '../stores/guardrailEventStore': {},
    '../stores/integrationActivityStore': {},
    '../stores/azureServiceUsageStore': {},
    '../core/llm/modelCosts': { computeCostSplit: () => ({ input_cost: 1, output_cost: 1 }) },
    '../stores/serverGeoResolver': { countryFlag: () => '' },
    '../license': { serverLicenseGovernsOrgs: () => governsOrgs },
};
const ROUTES_DIR = path.sep + 'routes' + path.sep;
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && parent.filename && parent.filename.includes(ROUTES_DIR) && stubs[request]) {
        return path.join(__dirname, `__stub_${Object.keys(stubs).indexOf(request)}_custview__.js`);
    }
    return origResolve.call(this, request, parent, ...rest);
};
Object.keys(stubs).forEach((request, i) => {
    const full = path.join(__dirname, `__stub_${i}_custview__.js`);
    require.cache[full] = { id: full, filename: full, loaded: true, exports: stubs[request] };
});

const express = require('express');
const router = require('./usage');
const app = express();
app.use((req, _res, next) => { req.session = currentSession; next(); });
app.use('/api/usage', router);
const server = app.listen(0);
test.after(() => server.close());

function get(pathname) {
    const { port } = /** @type {import('net').AddressInfo} */ (server.address());
    return new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}${pathname}`, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
        }).on('error', reject);
    });
}

// ── 1. redactRow ───────────────────────────────────────────────────────
test('the customer view is the allow-listed fields plus billed_cost, nothing else', () => {
    const everyKnownField = {};
    for (const f of CUSTOMER_FIELDS) everyKnownField[f] = `v:${f}`;
    for (const f of OPERATOR_ONLY_FIELDS) everyKnownField[f] = 7;
    everyKnownField.estimated_cost = 4;

    const out = redactRow(everyKnownField, 1.5);

    const expected = {};
    for (const f of CUSTOMER_FIELDS) expected[f] = `v:${f}`;
    expected.billed_cost = 6; // 4 x 1.5, computed, never the stored column
    assert.deepStrictEqual(out, expected);
    for (const f of OPERATOR_ONLY_FIELDS) assert.ok(!(f in out), `${f} is operator-only`);
});

test('an unknown new column does not reach the customer', () => {
    const out = redactRow({ model: 'm', estimated_cost: 2, new_secret_cost: 99, new_token_count: 5 }, 2);
    assert.deepStrictEqual(out, { model: 'm', billed_cost: 4 });
    assert.deepStrictEqual(redactRows([{ new_secret_cost: 1 }], 1), [{ billed_cost: 0 }]);
});

test('the raw cost feeds billed_cost from whichever name the report uses', () => {
    assert.strictEqual(redactRow({ total_estimated_cost: 2 }, 3).billed_cost, 6);
    assert.strictEqual(redactRow({ total_cost: 2 }, 3).billed_cost, 6);
    assert.strictEqual(redactRow({}, 3).billed_cost, 0);
});

test('the two lists do not overlap', () => {
    for (const f of OPERATOR_ONLY_FIELDS) assert.ok(!CUSTOMER_FIELDS.has(f), `${f} is in both lists`);
});

// ── 2. Through the router ──────────────────────────────────────────────
test('a cloud customer gets the allow-listed payload', async () => {
    governsOrgs = false;
    currentSession = { isAuthenticated: true, user: { id: 'u1', organizationId: 'org_a' } };
    for (const p of ['/api/usage/models', '/api/usage/timeline']) {
        const r = await get(p);
        assert.strictEqual(r.status, 200);
        assert.deepStrictEqual(r.body, [{ period: '2026-10-01', user_id: 'u1', model: 'm', source: 's', billed_cost: 3 }], p);
    }
});

test('the platform operator gets the raw payload', async () => {
    governsOrgs = false;
    currentSession = { isAuthenticated: true, user: { id: 'admin' } };
    const r = await get('/api/usage/timeline');
    assert.deepStrictEqual(r.body, [RAW_ROW]);
});

test('a self-hosted install gets the raw payload', async () => {
    governsOrgs = true;
    currentSession = { isAuthenticated: true, user: { id: 'u1', organizationId: 'org_a' } };
    const r = await get('/api/usage/timeline');
    assert.deepStrictEqual(r.body, [RAW_ROW]);
});

// ── 3. Guard: every selected column is classified ──────────────────────
const USAGE_STORE_DIR = path.join(__dirname, '..', 'stores', 'usage');

/** Aliases (`... AS x`) in the SQL template literals of the usage store, and the ai_usage_log columns. */
function selectedColumns() {
    const found = new Map(); // column -> where it was found
    // queries.js and breakdowns.js are the reports behind /api/usage; counts.js (test chats,
    // App Studio runs) and logUsage.js serve other callers.
    for (const file of ['queries.js', 'breakdowns.js', 'schema.js']) {
        const src = fs.readFileSync(path.join(USAGE_STORE_DIR, file), 'utf8');
        // schema.js contributes the table columns only (/recent is SELECT * on ai_usage_log).
        for (const [literal] of file === 'schema.js' ? [] : src.matchAll(/`[^`]*`/g)) {
            if (!/\bSELECT\b/i.test(literal)) continue;
            for (const m of literal.matchAll(/\bas\s+([a-z_][a-z0-9_]*)/gi)) found.set(m[1], file);
        }
        if (file === 'schema.js') {
            const create = src.match(/CREATE TABLE IF NOT EXISTS ai_usage_log \(([\s\S]*?)\n\s*\)/);
            for (const line of (create ? create[1] : '').split('\n')) {
                const col = line.trim().match(/^([a-z_][a-z0-9_]*)\s+[A-Z]/);
                if (col) found.set(col[1], file);
            }
            for (const m of src.matchAll(/ALTER TABLE ai_usage_log ADD COLUMN IF NOT EXISTS ([a-z_][a-z0-9_]*)/g)) found.set(m[1], file);
        }
    }
    return found;
}

test('guard: the scan sees the columns it is meant to guard', () => {
    const found = selectedColumns();
    for (const expected of ['total_estimated_cost', 'estimated_cost', 'usage_raw', 'total_billed_cost', 'phase_count', 'period']) {
        assert.ok(found.has(expected), `the scan no longer finds ${expected}; fix the scan, not the lists`);
    }
});

test('guard: every column a usage query selects is classified', () => {
    // Added by the route rather than a query.
    const addedInRoute = ['display_name', 'avatarType', 'avatar', 'input_cost', 'output_cost',
        'total_input_cost', 'total_output_cost', 'azure_services_total_cost', 'combined_total_cost'];
    const unclassified = [];
    for (const [col, file] of selectedColumns()) {
        if (!CUSTOMER_FIELDS.has(col) && !OPERATOR_ONLY_FIELDS.has(col)) unclassified.push(`${col} (${file})`);
    }
    for (const col of addedInRoute) {
        if (!CUSTOMER_FIELDS.has(col) && !OPERATOR_ONLY_FIELDS.has(col)) unclassified.push(`${col} (routes/usage.js)`);
    }
    assert.deepStrictEqual(unclassified, [],
        'Classify each new column in routes/usageCustomerView.js: CUSTOMER_FIELDS if a customer may see it, '
        + 'OPERATOR_ONLY_FIELDS if it is a token count, raw cost or price.');
});
