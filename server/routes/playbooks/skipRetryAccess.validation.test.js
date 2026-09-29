'use strict';

/**
 * Skip, retry and the access assistant (routes/playbooks/skipRetryRoutes.js,
 * routes/playbooks/accessPhaseRoutes.js) — what they accept, and whom the
 * assistant may name.
 *
 * Three things answered 200 or 500 where they should not have:
 *
 *   - a skip or retry WITHOUT `expectedVersion` moved the phase with no lock
 *     at all: the schema made it optional and the route only compared when it
 *     was there, so `{}` skipped on top of whatever somebody else had written;
 *   - a skip of a phase that does not exist was a 500 "Could not skip the
 *     phase", logged as a server failure (retry already said "Unknown phase.");
 *   - the access assistant read a playbook with no organisation as "no
 *     filter": every person and group in the installation, other tenants
 *     included, went to the model and could come back in the plan by name.
 *     The same clause let consumer accounts and global groups into every
 *     organisation's directory.
 *
 * Whom the assistant may name now follows GET /auth/users, with one rule of
 * its own: the directory belongs to the PLAYBOOK, not to whoever is asking.
 * An organisation's playbook names that organisation — its groups, its
 * members, the people in its groups, and the owner — even when its owner
 * administers the whole installation, because the directory goes into a
 * model's prompt and the app belongs to that organisation. Only a playbook
 * with no organisation at all can reach past one: the installation operator's
 * own sees everyone, a consumer's sees its owner.
 *
 * Run: cd server && node --test routes/playbooks/skipRetryAccess.validation.test.js
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
// What the planner answers.
let planAnswer = { ok: true, plan: {} };

// Every store write and every planner call lands in `touched`.
const touched = [];
const note = (what) => async (...args) => { touched.push({ what, args }); return true; };

let playbook = null;
const PLAYBOOK = (extra = {}) => ({
    id: 'pb1', userId: 'me', organizationId: 'orgA', version: 3, status: 'active',
    title: 'Invoices', options: { locale: 'en' },
    phases: [
        { key: 'table', kind: 'table', status: 'done' },
        { key: 'app', kind: 'app', status: 'failed', artifacts: { appId: 'app1' } },
        { key: 'access', kind: 'access', status: 'ready', artifacts: { appId: 'app1' } },
    ],
    ...extra,
});

// The installation: two tenants, a consumer account, a global group, and one
// orgB person who sits in an orgA group.
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
    playbookStore: {
        listPlaybooksForUser: async () => [],
        getPlaybook: async () => (playbook ? { ...playbook } : null),
        createPlaybook: note('createPlaybook'),
        savePhases: note('savePhases'),
        deletePlaybook: note('deletePlaybook'),
    },
    recipes: { listRecipes: () => [], getRecipe: () => null },
    recipeDoc: { normaliseRecipeDoc: (d) => d, validateRecipeDoc: () => ({ ok: true }), fromDocument: () => null },
    userStore: { getAllGroups: async () => GROUPS, getAllUsers: async () => USERS, getUser: async () => null },
    studioAppStore: { getStudioApp: async () => ({ id: 'app1', userId: 'me', name: 'App' }) },
    studioAppDataStore: { getDataModel: async () => null },
    planAccess: async (args) => { touched.push({ what: 'planAccess', args: [args] }); return planAnswer; },
    entitlements: { hasCapability: async () => true },
    tierAccessFor: async (args) => { tierAsks.push(args); return tierAccessOf(permitted); },
    now: () => Date.parse('2026-09-23T10:00:00Z'),
};
// Anything a refused request reaches for beyond these is a bug this file is
// here to catch.
const d = new Proxy(deps, {
    get(target, key) {
        if (key in target) return target[key];
        return new Proxy({}, { get: () => { throw new Error(`unexpected dep: ${String(key)}`); } });
    },
});

const router = createPlaybooksRouter(d);

function dispatch({ method, url, body, session = { user: { id: 'me', organizationId: 'orgA' } } }) {
    return new Promise((resolve, reject) => {
        const req = {
            method, url, originalUrl: url, path: url, query: {}, body, headers: {},
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
        router(req, res, (err) => reject(err || new Error(`fell through: ${method} ${url}`)));
    });
}

test.beforeEach(() => { touched.length = 0; tierAsks.length = 0; permitted = new Set(['auto', 'fast']); planAnswer = { ok: true, plan: {} }; playbook = PLAYBOOK(); });

// ═══ Skip and retry: the lock is not optional ═══════════════════════

for (const [what, body] of [['an empty body', {}], ['no body at all', undefined]]) {
    test(`a skip with ${what} is refused for the missing lock, and nothing moves`, async () => {
        const res = await dispatch({ method: 'POST', url: '/pb1/phases/app/skip', body });
        assert.strictEqual(res.statusCode, 400, JSON.stringify(res.body));
        assert.strictEqual(res.body.code, 'bad_patch');
        assert.strictEqual(res.body.error, 'expectedVersion is the version this playbook had when you read it.');
        assert.ok(res.body.errors.some((e) => e.path === 'body.expectedVersion'));
        assert.deepStrictEqual(touched, []);
    });
}

test('a retry without the lock is refused the same way', async () => {
    const res = await dispatch({ method: 'POST', url: '/pb1/phases/app/retry', body: { resetBrief: true } });
    assert.strictEqual(res.statusCode, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body.code, 'bad_patch');
    assert.ok(res.body.errors.some((e) => e.path === 'body.expectedVersion'));
    assert.deepStrictEqual(touched, []);
});

test('the lock the Studio sends still reaches the version check', async () => {
    const res = await dispatch({ method: 'POST', url: '/pb1/phases/app/skip', body: { expectedVersion: 2 } });
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(res.body.code, 'version_conflict');
    assert.deepStrictEqual(touched, []);
});

test('skipping a phase that does not exist is a 400 in words, not a 500', async () => {
    const res = await dispatch({ method: 'POST', url: '/pb1/phases/nope/skip', body: { expectedVersion: 3 } });
    assert.strictEqual(res.statusCode, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body.code, 'bad_patch');
    assert.strictEqual(res.body.error, 'Unknown phase.');
    assert.deepStrictEqual(touched, []);
});

// ═══ The access assistant: whom it may name ═════════════════════════

async function directorySeen(session) {
    const res = await dispatch({ method: 'POST', url: '/pb1/phases/access/access-plan', body: { message: 'the finance team' }, session });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    const call = touched.find((t) => t.what === 'planAccess');
    assert.ok(call, 'the planner was asked');
    return {
        people: call.args[0].people.map((u) => u.id).sort(),
        groups: call.args[0].groups.map((g) => g.id).sort(),
    };
}

test('a playbook with no organisation names its owner — not the whole installation', async () => {
    playbook = PLAYBOOK({ organizationId: null });
    const seen = await directorySeen({ user: { id: 'me' } });
    assert.deepStrictEqual(seen.people, ['me']);
    assert.deepStrictEqual(seen.groups, []);
});

test('an organisation\'s playbook names its own people and groups, and nobody from another tenant', async () => {
    const seen = await directorySeen({ user: { id: 'me', organizationId: 'orgA' } });
    // eve is in orgB but sits in an orgA group, exactly as GET /auth/users counts her.
    assert.deepStrictEqual(seen.people, ['ann', 'eve', 'me']);
    assert.deepStrictEqual(seen.groups, ['g_finance'], 'no orgB group, and no global group');
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

// ═══ The access assistant: which tier it runs on ════════════════════
//
// It ran on the tier straight off the row: `auto`, which the planner's model
// resolver reads as an unknown tier and answers with the FAST model, and a
// tier the owner had lost since the playbook was created.

async function planTier(options) {
    playbook = PLAYBOOK({ options: { locale: 'en', ...options } });
    return dispatch({ method: 'POST', url: '/pb1/phases/access/access-plan', body: { message: 'the finance team' } });
}
const plannedOn = () => touched.filter((t) => t.what === 'planAccess').map((t) => t.args[0].tier);

test('the assistant of a playbook on auto runs on the cheapest tier the owner may use', async () => {
    permitted = new Set(['pro', 'thinking']);
    const res = await planTier({ tier: 'auto' });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(plannedOn(), ['thinking']);
    assert.strictEqual(tierAsks[0].userId, 'me', "the owner's list");
    assert.strictEqual(tierAsks[0].taskType, 'automation');
});

test('a tier the owner has lost is refused, and no model is asked', async () => {
    const res = await planTier({ tier: 'pro' });
    assert.strictEqual(res.statusCode, 403, JSON.stringify(res.body));
    assert.strictEqual(res.body.code, 'tier_not_permitted');
    assert.deepStrictEqual(plannedOn(), []);
});

test('a tier the owner still has is the one it runs on', async () => {
    permitted = new Set(['fast', 'thinking']);
    await planTier({ tier: 'thinking' });
    assert.deepStrictEqual(plannedOn(), ['thinking']);
});

// planAccess answers an unreachable model with a fixed sentence and the id its
// log line carries (playbooks/modelFailure.js); the refusal has to carry that
// id, or nothing ties the person's screen to the operator's log.
test('a model that cannot be reached is a 422 with the fixed sentence and the correlation id the log carries', async () => {
    planAnswer = { ok: false, code: 'plan_failed', error: 'The model could not be reached. Try again in a moment.', correlationId: 'req-4711' };
    const res = await dispatch({ method: 'POST', url: '/pb1/phases/access/access-plan', body: { message: 'the finance team' } });
    assert.strictEqual(res.statusCode, 422, JSON.stringify(res.body));
    assert.strictEqual(res.body.code, 'plan_failed');
    assert.strictEqual(res.body.error, 'The model could not be reached. Try again in a moment.');
    assert.strictEqual(res.body.correlationId, 'req-4711');
});
