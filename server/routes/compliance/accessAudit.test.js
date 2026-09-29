/**
 * The audit view is a read of other people's activity, so the property worth a
 * test is not "does it return rows" but "whose rows".
 *
 * The specific trap: routes/compliance/shared.js resolves a caller with no
 * organisation to the literal string 'default'. That is fine for a settings
 * screen — it reads a row that may not exist and shows defaults. Reused here it
 * would hand an org-less account the complete access and authentication trail
 * of any organisation that happens to be called 'default'. So this router
 * resolves strictly and refuses instead, and the first two tests below are
 * about exactly that.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const Module = require('node:module');

// ── Stand-ins ───────────────────────────────────────────────────────
const state = {
    users: new Map(),
    rows: [],
    lastFilter: null,
    written: [],
};

const mockUserStore = {
    getUser: async (id) => state.users.get(id) || null,
    logAccessAudit: async (action, targetType, targetId, changedBy, oldValues, newValues, organizationId) => {
        state.written.push({ action, targetType, targetId, changedBy, newValues, organizationId });
    },
    getAccessAuditLog: async (opts) => {
        state.lastFilter = opts;
        return state.rows.filter((r) => matches(r, opts)).slice(opts.offset || 0, (opts.offset || 0) + (opts.limit || 100));
    },
    countAccessAuditLog: async (opts) => state.rows.filter((r) => matches(r, opts)).length,
    listAccessAuditActions: async (opts) => {
        const seen = new Map();
        for (const r of state.rows.filter((x) => matches(x, opts))) {
            seen.set(r.action, (seen.get(r.action) || 0) + 1);
        }
        return [...seen].map(([action, count]) => ({ action, count }));
    },
};

/** The stand-in for the store's WHERE clause — same scoping rules. */
function matches(row, opts = {}) {
    if (opts.organizationId) { if (row.organization_id !== opts.organizationId) return false; }
    else if (opts.globalOnly) { if (row.organization_id !== null) return false; }
    if (opts.actions && !opts.actions.includes(row.action)) return false;
    if (opts.changedBy && row.changed_by !== opts.changedBy) return false;
    if (opts.since && row.created_at < opts.since) return false;
    if (opts.until && row.created_at > opts.until) return false;
    return true;
}

const mockPermissions = {
    requireAuth: (req, res, next) => (req.session?.user ? next() : res.status(401).json({ error: 'Not authenticated' })),
    requirePermission: () => (req, res, next) => (req.session?.user?.canCompliance
        ? next()
        : res.status(403).json({ error: "Permission 'admin_compliance' required" })),
    isSuperAdmin: (req) => !!(req.session?.isAdmin || req.session?.user?.role === 'admin'),
};

const STORE = require.resolve('../../stores/userStore.js');
const PERMS = require.resolve('../../auth/permissions.js');
const originalResolve = Module._resolveFilename;
for (const [file, exports] of [[STORE, mockUserStore], [PERMS, mockPermissions]]) {
    require.cache[file] = { id: file, filename: file, loaded: true, exports };
}

const router = require('./accessAudit');
test.after(() => {
    Module._resolveFilename = originalResolve;
    delete require.cache[STORE];
    delete require.cache[PERMS];
});

// ── Harness ─────────────────────────────────────────────────────────
let currentSession = null;
const app = express();
app.use((req, _res, next) => { req.session = currentSession; next(); });
app.use('/api/compliance', router);
let server;
let base;

test.before(async () => {
    await new Promise((resolve) => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}/api/compliance`;
});
test.after(async () => { if (server) await new Promise((r) => server.close(r)); });

async function get(path, session) {
    currentSession = session;
    const res = await fetch(base + path);
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { body = text; }
    return { status: res.status, body, headers: res.headers };
}

const ORG_A = { id: 'u_a', canCompliance: true };
const ORG_B = { id: 'u_b', canCompliance: true };
const ORGLESS = { id: 'u_none', canCompliance: true };
const PLAIN = { id: 'u_plain' };
const SUPER = { id: 'u_super', role: 'admin', canCompliance: true };

test.beforeEach(() => {
    state.users = new Map([
        ['u_a', { id: 'u_a', organizationId: 'org_a' }],
        ['u_b', { id: 'u_b', organizationId: 'org_b' }],
        ['u_none', { id: 'u_none', organizationId: '' }],
        ['u_plain', { id: 'u_plain', organizationId: 'org_a' }],
        ['u_super', { id: 'u_super', organizationId: 'default' }],
    ]);
    state.rows = [
        { id: '1', action: 'login_succeeded', target_type: 'user', target_id: 'u_a', changed_by: 'u_a', organization_id: 'org_a', created_at: '2026-09-01T10:00:00Z' },
        { id: '2', action: 'login_failed', target_type: 'login_identifier', target_id: 'v1:abc', changed_by: 'anonymous', organization_id: 'org_a', created_at: '2026-09-02T10:00:00Z' },
        { id: '3', action: 'login_succeeded', target_type: 'user', target_id: 'u_b', changed_by: 'u_b', organization_id: 'org_b', created_at: '2026-09-03T10:00:00Z' },
        { id: '4', action: 'module_installed', target_type: 'platform_module', target_id: 'mod_1', changed_by: 'u_super', organization_id: null, created_at: '2026-09-04T10:00:00Z' },
        { id: '5', action: 'login_succeeded', target_type: 'user', target_id: 'u_d', changed_by: 'u_d', organization_id: 'default', created_at: '2026-09-05T10:00:00Z' },
    ];
    state.lastFilter = null;
    state.written = [];
});

// ── The scoping tests ───────────────────────────────────────────────

test('an org admin sees their own organisation and nothing else', async () => {
    const res = await get('/access-audit', { user: ORG_A });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.entries.map((e) => e.id), ['1', '2']);
    assert.strictEqual(res.body.total, 2);
    assert.strictEqual(res.body.scope, 'org_a');
    // Explicitly: not the other tenant, and not the platform rows.
    assert.ok(!res.body.entries.some((e) => e.organization_id === 'org_b'));
    assert.ok(!res.body.entries.some((e) => e.organization_id === null));
});

test('an account with no organisation is refused, not defaulted', async () => {
    // The whole reason this router does not reuse shared.resolveOrgId: that
    // helper answers 'default', and row 5 belongs to an organisation with that
    // very id. A 200 here would be a cross-tenant read.
    const res = await get('/access-audit', { user: ORGLESS });
    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.body.code, 'no_organisation');
    assert.strictEqual(state.lastFilter, null, 'the store was queried before the scope was settled');
});

test('platform-level rows never appear in an organisation view', async () => {
    // organization_id NULL means the event belongs to no tenant. Showing it in
    // an org view would leak platform activity into every organisation at once.
    const res = await get('/access-audit', { user: ORG_A });
    assert.ok(!res.body.entries.some((e) => e.action === 'module_installed'));
});

test('only a super admin can ask for the platform scope', async () => {
    const denied = await get('/access-audit?scope=platform', { user: ORG_A });
    assert.strictEqual(denied.status, 403, 'admin_compliance inside an org is not a platform grant');

    const allowed = await get('/access-audit?scope=platform', { user: SUPER, isAdmin: true });
    assert.strictEqual(allowed.status, 200);
    assert.deepStrictEqual(allowed.body.entries.map((e) => e.id), ['4']);
    assert.strictEqual(allowed.body.scope, 'platform');
});

test('the compliance permission is required, not just a session', async () => {
    assert.strictEqual((await get('/access-audit', { user: PLAIN })).status, 403);
    assert.strictEqual((await get('/access-audit', null)).status, 401);
    assert.strictEqual((await get('/access-audit/export', { user: PLAIN })).status, 403);
    assert.strictEqual((await get('/access-audit/actions', { user: PLAIN })).status, 403);
});

// ── Filters, counts and the export ──────────────────────────────────

test('the total counts what the page is a page of', async () => {
    // A total computed under a looser filter than the rows makes "42 sign-ins
    // this month" a number nobody can reproduce from the screen.
    const res = await get('/access-audit?action=login_succeeded&limit=1', { user: ORG_A });
    assert.strictEqual(res.body.entries.length, 1);
    assert.strictEqual(res.body.total, 1, 'the count ignored the action filter');
});

test('an unparseable date is no filter rather than the epoch', async () => {
    const res = await get('/access-audit?since=not-a-date', { user: ORG_A });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.total, 2, 'a broken date silently changed which rows came back');
    assert.strictEqual(state.lastFilter.since, null);
});

test('a date range narrows both the rows and the count', async () => {
    const res = await get('/access-audit?since=2026-09-02T00:00:00Z', { user: ORG_A });
    assert.deepStrictEqual(res.body.entries.map((e) => e.id), ['2']);
    assert.strictEqual(res.body.total, 1);
});

test('the page size is bounded', async () => {
    const res = await get('/access-audit?limit=999999', { user: ORG_A });
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.limit <= router._internal.MAX_PAGE);
});

test('the export carries its own scope and filter', async () => {
    // A file that has travelled away from the screen must still say what it is
    // a file OF; an export whose scope has to be remembered is not evidence.
    const res = await get('/access-audit/export?action=login_failed', { user: ORG_A });
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-disposition') || '', /attachment; filename="access-audit-org_a-\d{4}-\d{2}-\d{2}\.json"/);
    assert.strictEqual(res.body.scope, 'org_a');
    assert.deepStrictEqual(res.body.filter.actions, ['login_failed']);
    assert.strictEqual(res.body.generatedBy, 'u_a');
    assert.deepStrictEqual(res.body.entries.map((e) => e.id), ['2']);
    assert.strictEqual(res.body.total, 1);
});

test('the export is scoped exactly like the view', async () => {
    const res = await get('/access-audit/export', { user: ORG_B });
    assert.deepStrictEqual(res.body.entries.map((e) => e.id), ['3']);
    assert.ok(!JSON.stringify(res.body).includes('org_a'), 'the export crossed a tenant boundary');
});

test('an oversized export is refused with a number, not truncated', async () => {
    // Silently returning the first N rows of a range somebody asked for is the
    // failure mode that ends with an auditor drawing a conclusion from a
    // partial file.
    const many = [];
    for (let i = 0; i < router._internal.MAX_EXPORT + 5; i++) {
        many.push({ id: `x${i}`, action: 'login_succeeded', target_type: 'user', target_id: 'u', changed_by: 'u', organization_id: 'org_a', created_at: '2026-09-01T10:00:00Z' });
    }
    state.rows = many;
    const res = await get('/access-audit/export', { user: ORG_A });
    assert.strictEqual(res.status, 413);
    assert.strictEqual(res.body.code, 'export_too_large');
    assert.strictEqual(res.body.total, many.length);
    assert.strictEqual(res.body.max, router._internal.MAX_EXPORT);
});

test('the action list is built from the log, scoped to the caller', async () => {
    const res = await get('/access-audit/actions', { user: ORG_A });
    assert.strictEqual(res.status, 200);
    const actions = res.body.actions.map((a) => a.action).sort();
    assert.deepStrictEqual(actions, ['login_failed', 'login_succeeded']);
    assert.ok(!actions.includes('module_installed'), 'a platform action leaked into an org filter list');
});

test('taking a copy of the trail is itself recorded', async () => {
    // A.8.15 asks for logs to be protected, and "who took a copy of everyone's
    // sign-in times and addresses" is the question asked after an account turns
    // out to have been compromised. An export that leaves no trace is the one
    // read of this table that nobody can reconstruct.
    const res = await get('/access-audit/export?action=login_succeeded', { user: ORG_A });
    assert.strictEqual(res.status, 200);

    const row = state.written.find((w) => w.action === 'access_audit_exported');
    assert.ok(row, 'exporting the audit trail wrote no audit row');
    assert.strictEqual(row.changedBy, 'u_a');
    assert.strictEqual(row.organizationId, 'org_a');
    assert.strictEqual(row.targetType, 'access_audit_log');
    assert.deepStrictEqual(row.newValues.filter.actions, ['login_succeeded']);
    assert.strictEqual(row.newValues.rows, 1, 'the row does not say how much was taken');
});

test('a refused export leaves no export row', async () => {
    // Only what actually left the building. An attempted-and-refused read is
    // not a copy, and recording it as one makes the trail lie in the direction
    // that matters most.
    const res = await get('/access-audit/export', { user: ORGLESS });
    assert.strictEqual(res.status, 403);
    assert.strictEqual(state.written.filter((w) => w.action === 'access_audit_exported').length, 0);
});

test('the export is rate limited', async () => {
    // The one route that hands over bulk personal data in a single file. The
    // gate says who may read it; the cap limits what a stolen session carries
    // away before anyone notices.
    let refused = 0;
    for (let i = 0; i < 25; i++) {
        const r = await get('/access-audit/export', { user: ORG_A });
        if (r.status === 429) refused += 1;
    }
    assert.ok(refused > 0, 'an unbounded export loop was never refused');
});
