'use strict';

/**
 * Creating a playbook (routes/playbooks/playbookRoutes.js, POST /): the depth
 * a caller pins it to has to be one they may use.
 *
 * The schema checked that `options.tier` was A tier, never that it was one
 * this person's groups allow, and the playbook stored it. Every builder the
 * playbook then drives sends that stored tier as its `modelTier`, pinned — so
 * somebody an administrator had narrowed to `fast` could create a playbook on
 * `pro` and have both builders run on it. What this file pins:
 *
 *   - a tier outside the caller's list is refused with the 403 compose gives,
 *     and nothing is stored;
 *   - a tier inside it is stored as asked, `deep_thinking` measured as `pro`;
 *   - `auto` is stored while the person has a tier it could land on;
 *   - the list is the one the dialog offers (taskType automation);
 *   - a create that names no tier stores the one the list leaves: `fast`
 *     when it is theirs, else the cheapest tier that is, else a 403. It
 *     stored `fast` without asking.
 *
 * Run: cd server && node --test routes/playbooks/playbookRoutes.validation.test.js
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

let permitted = new Set();
const asked = [];
mock(path.join(SERVER, 'core/entitlements/userTiers'), {
    getPermittedTierKeys: async (args) => { asked.push(args); return permitted; },
});

const { createPlaybooksRouter } = require('./index');

const created = [];
const deps = {
    playbookStore: {
        createPlaybook: async (row) => { created.push(row); return { id: 'pb1', version: 1, ...row }; },
    },
    recipes: require('../../playbooks/recipes'),
    recipeDoc: require('../../playbooks/recipeDoc'),
    userStore: { getUser: async (id) => ({ id, organizationId: 'orgA' }), getAllGroups: async () => [] },
    entitlements: { hasCapability: async () => true },
    // The real question, over the stubbed list above.
    tierAccessFor: require('../../core/entitlements/tierAccess').tierAccessFor,
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

function create(options) {
    const body = { recipeId: 'invoice_tracker', title: 'Invoices', options: { tableMode: 'new', folderPath: '/Invoices', locale: 'en', ...options } };
    return new Promise((resolve, reject) => {
        const req = {
            method: 'POST', url: '/', originalUrl: '/', path: '/', query: {}, body, headers: {},
            session: { user: { id: 'me', organizationId: 'orgA' } }, get() { return undefined; },
        };
        const res = {
            statusCode: 200,
            set() { return this; }, setHeader() {},
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; resolve(this); return this; },
            send(b) { this.body = b; resolve(this); return this; },
            end() { resolve(this); return this; },
        };
        router(req, res, (err) => reject(err || new Error('fell through: POST /')));
    });
}

const storedTiers = () => created.map((row) => row.options.tier);

test.beforeEach(() => { created.length = 0; asked.length = 0; permitted = new Set(['auto', 'fast']); });

test('a tier the caller\'s groups do not allow is refused by name, and nothing is stored', async () => {
    const res = await create({ tier: 'pro' });
    assert.strictEqual(res.statusCode, 403, JSON.stringify(res.body));
    assert.strictEqual(res.body.code, 'tier_not_permitted');
    assert.strictEqual(res.body.error, 'Tier "pro" is not available on your account.');
    assert.deepStrictEqual(created, []);
});

test('a tier they may use is stored as asked, and deep_thinking is measured as pro', async () => {
    permitted = new Set(['fast', 'thinking']);
    assert.strictEqual((await create({ tier: 'thinking' })).statusCode, 201);
    assert.strictEqual((await create({ tier: 'deep_thinking' })).statusCode, 403);
    permitted = new Set(['fast', 'pro']);
    assert.strictEqual((await create({ tier: 'deep_thinking' })).statusCode, 201);
    assert.deepStrictEqual(storedTiers(), ['thinking', 'deep_thinking']);
});

test('auto is stored while the person has a tier it could land on, and refused when they have none', async () => {
    permitted = new Set(['thinking']);
    assert.strictEqual((await create({ tier: 'auto' })).statusCode, 201, 'the builders choose within thinking');
    permitted = new Set(['custom:legal']);
    const refused = await create({ tier: 'auto' });
    assert.strictEqual(refused.statusCode, 403);
    assert.strictEqual(refused.body.code, 'tier_not_permitted');
    assert.deepStrictEqual(storedTiers(), ['auto']);
});

test('the list is the dialog\'s own: the caller\'s, for automation', async () => {
    await create({ tier: 'fast' });
    assert.strictEqual(asked.length, 1);
    assert.strictEqual(asked[0].userId, 'me');
    assert.strictEqual(asked[0].taskType, 'automation');
});

// No tier stored `fast` without asking. The playbook's server phases then ran
// on fast whatever the groups allowed, and both builders, which measure the
// stored tier, refused every phase of it.
test('a create that names no tier stores fast when that is theirs, else the cheapest tier that is', async () => {
    assert.strictEqual((await create({})).statusCode, 201);
    permitted = new Set(['pro', 'thinking']);
    const narrowed = await create({});
    assert.strictEqual(narrowed.statusCode, 201, JSON.stringify(narrowed.body));
    assert.deepStrictEqual(storedTiers(), ['fast', 'thinking']);
    assert.strictEqual(asked.length, 2, 'the list is asked every time');
});

test('a create that names no tier, by somebody with no tier to choose, is refused and nothing is stored', async () => {
    permitted = new Set(['custom:legal']);
    const res = await create({});
    assert.strictEqual(res.statusCode, 403, JSON.stringify(res.body));
    assert.strictEqual(res.body.code, 'tier_not_permitted');
    assert.deepStrictEqual(created, []);
});
