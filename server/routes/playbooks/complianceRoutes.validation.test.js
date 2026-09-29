'use strict';

/**
 * "Resolve with AI" on a compliance finding (routes/playbooks/complianceRoutes.js,
 * POST /:id/phases/:key/resolve-plan): whom the model may name.
 *
 * The access assistant was fixed first (skipRetryAccess.validation.test.js);
 * this route kept the old clause, `!orgId || !x.organizationId ||
 * x.organizationId === orgId`, which read a missing organisation as a missing
 * FILTER. A consumer's playbook handed every person and group in the
 * installation, other tenants included, to the model; an organisation's
 * playbook let in every consumer account and every global group. It now
 * follows the same rule as the access assistant: the directory belongs to
 * the PLAYBOOK, not to whoever is asking.
 *
 * Run: cd server && node --test routes/playbooks/complianceRoutes.validation.test.js
 */

process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const Module = require('module');

const SERVER = path.resolve(__dirname, '..', '..');
function mock(absId, exports) {
    const p = require.resolve(absId);
    const m = new Module(p);
    m.exports = exports;
    m.loaded = true;
    require.cache[p] = m;
}

const pass = (req, res, next) => next();
mock(path.join(SERVER, 'auth/permissions'), {
    requireAuth: pass,
    requirePermission: () => pass,
    Permissions: { MANAGE_APPS: 'manage_apps', MANAGE_DATATABLES: 'manage_datatables' },
    hasPermission: async () => true,
});
mock(path.join(SERVER, 'utils/perUserRateLimit'), { perUserRateLimit: () => pass });

const { createPlaybooksRouter } = require('./index');
const { tierAccessOf } = require('../../core/entitlements/tierAccess');

// The tiers the owner may use, and who was asked.
let permitted = new Set();
const tierAsks = [];

const planned = [];
let playbook = null;
const PLAYBOOK = (extra = {}) => ({
    id: 'pb1', userId: 'me', organizationId: 'orgA', version: 3, status: 'active',
    title: 'Invoices', options: { locale: 'en' },
    phases: [
        { key: 'table', kind: 'table', status: 'done' },
        {
            key: 'compliance', kind: 'compliance', status: 'awaiting',
            artifacts: { findings: [{ code: 'no_owner', severity: 'high', title: 'Nobody owns this table' }], facts: { automations: [] } },
        },
    ],
    ...extra,
});

// The installation: two tenants, a consumer account, a global group, and one
// orgB person who sits in an orgA group (the same fixture the access
// assistant's test uses).
const GROUPS = [
    { id: 'g_finance', name: 'Finance', organizationId: 'orgA' },
    { id: 'g_rival', name: 'Rival sales', organizationId: 'orgB' },
    { id: 'g_global', name: 'Everyone everywhere', organizationId: null },
];
const USERS = [
    { id: 'me', name: 'Me', email: 'me@a.example', organizationId: 'orgA', groups: [] },
    { id: 'ann', name: 'Ann', email: 'ann@a.example', organizationId: 'orgA', groups: ['g_finance'] },
    { id: 'bob', name: 'Bob', email: 'bob@b.example', organizationId: 'orgB', groups: ['g_rival'] },
    { id: 'eve', name: 'Eve', email: 'eve@b.example', organizationId: 'orgB', groups: '["g_finance"]' },
    { id: 'cat', name: 'Cat', email: 'cat@consumer.example', organizationId: null, groups: [] },
];

const deps = {
    playbookStore: { getPlaybook: async () => (playbook ? { ...playbook } : null) },
    recipes: { listRecipes: () => [], getRecipe: () => null },
    recipeDoc: { fromDocument: () => null },
    userStore: { getAllGroups: async () => GROUPS, getAllUsers: async () => USERS, getUser: async () => null },
    automationStore: { getAutomation: async () => null },
    planResolve: async (args) => { planned.push(args); return { ok: true, plan: {} }; },
    entitlements: { hasCapability: async () => true },
    tierAccessFor: async (args) => { tierAsks.push(args); return tierAccessOf(permitted); },
    now: () => Date.parse('2026-09-23T10:00:00Z'),
};
// Anything a request reaches for beyond these is a bug this file is here to catch.
const d = new Proxy(deps, {
    get(target, key) {
        if (key in target) return target[key];
        return new Proxy({}, { get: () => { throw new Error(`unexpected dep: ${String(key)}`); } });
    },
});

const router = createPlaybooksRouter(d);

function resolvePlan(session) {
    const url = '/pb1/phases/compliance/resolve-plan';
    return new Promise((resolve, reject) => {
        const req = {
            method: 'POST', url, originalUrl: url, path: url, query: {}, body: { code: 'no_owner' }, headers: {},
            session, get() { return undefined; },
        };
        const res = {
            statusCode: 200,
            set() { return this; }, setHeader() {},
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; resolve(this); return this; },
            send(b) { this.body = b; resolve(this); return this; },
            end() { resolve(this); return this; },
        };
        router(req, res, (err) => reject(err || new Error(`fell through: POST ${url}`)));
    });
}

async function directorySeen(session) {
    planned.length = 0;
    const res = await resolvePlan(session);
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(planned.length, 1, 'the planner was asked');
    const { directory } = planned[0];
    return {
        people: directory.people.map((u) => u.id).sort(),
        groups: directory.groups.map((g) => g.id).sort(),
    };
}

test.beforeEach(() => { planned.length = 0; tierAsks.length = 0; permitted = new Set(['auto', 'fast']); playbook = PLAYBOOK(); });

test('a playbook with no organisation names its owner — not the whole installation', async () => {
    playbook = PLAYBOOK({ organizationId: null });
    const seen = await directorySeen({ user: { id: 'me' } });
    assert.deepStrictEqual(seen.people, ['me']);
    assert.deepStrictEqual(seen.groups, []);
});

test('an organisation\'s playbook names its own people and groups — no consumer, no global group, no other tenant', async () => {
    const seen = await directorySeen({ user: { id: 'me', organizationId: 'orgA' } });
    assert.deepStrictEqual(seen.people, ['ann', 'eve', 'me'], 'eve is in orgB but sits in an orgA group');
    assert.deepStrictEqual(seen.groups, ['g_finance']);
});

test('the installation\'s operator, whose playbook has no organisation, still sees everyone', async () => {
    playbook = PLAYBOOK({ organizationId: null });
    const seen = await directorySeen({ isAdmin: true, user: { id: 'me', role: 'admin' } });
    assert.deepStrictEqual(seen.people, ['ann', 'bob', 'cat', 'eve', 'me']);
    assert.deepStrictEqual(seen.groups, ['g_finance', 'g_global', 'g_rival']);
});

test('who is asking never widens an organisation\'s directory', async () => {
    const seen = await directorySeen({ isAdmin: true, user: { id: 'me', role: 'admin', organizationId: 'orgA' } });
    assert.deepStrictEqual(seen.people, ['ann', 'eve', 'me']);
    assert.deepStrictEqual(seen.groups, ['g_finance']);
});

// ═══ Which tier it runs on ══════════════════════════════════════════
//
// It ran on the tier straight off the row: `auto`, which the planner's model
// resolver reads as an unknown tier and answers with the FAST model, and a
// tier the owner had lost since the playbook was created.

const OWNER = { user: { id: 'me', organizationId: 'orgA' } };

test('"resolve with AI" on a playbook on auto runs on the cheapest tier the owner may use', async () => {
    playbook = PLAYBOOK({ options: { locale: 'en', tier: 'auto' } });
    permitted = new Set(['pro', 'thinking']);
    const res = await resolvePlan(OWNER);
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(planned.map((p) => p.tier), ['thinking']);
    assert.strictEqual(tierAsks[0].userId, 'me', "the owner's list");
    assert.strictEqual(tierAsks[0].taskType, 'automation');
});

test('a tier the owner has lost is refused, and no model is asked', async () => {
    playbook = PLAYBOOK({ options: { locale: 'en', tier: 'pro' } });
    const res = await resolvePlan(OWNER);
    assert.strictEqual(res.statusCode, 403, JSON.stringify(res.body));
    assert.strictEqual(res.body.code, 'tier_not_permitted');
    assert.deepStrictEqual(planned, []);
});
