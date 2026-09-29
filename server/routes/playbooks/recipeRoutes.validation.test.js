'use strict';

/**
 * Composing a recipe (routes/playbooks/recipeRoutes.js): the depth a caller
 * asks for has to be one they may use.
 *
 * The schema checked that `tier` was A tier, never that it was one this
 * person's groups allow. Everywhere else a tier is picked, the permitted list
 * (core/entitlements/userTiers) decides; compose skipped it, so somebody an
 * administrator had narrowed to `fast` could POST `tier: 'pro'` and compose
 * on the pro model. What this file pins:
 *
 *   - a tier outside the caller's list is refused with a 403 that names it,
 *     and no model is asked;
 *   - a tier inside it still composes on that tier;
 *   - `deep_thinking` is measured as `pro`, its other name;
 *   - the list is asked for with the dialog's own taskType (automation);
 *   - the dialog's request, which sends no tier, asks the list too: it
 *     composes on `fast` when that is theirs, else on the cheapest tier that
 *     is, else it is refused. It composed on fast without asking.
 *
 * Run: cd server && node --test routes/playbooks/recipeRoutes.validation.test.js
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

// The caller's groups allow what `permitted` says; every question lands in `touched`.
let permitted = new Set();
const touched = [];
mock(path.join(SERVER, 'core/entitlements/userTiers'), {
    getPermittedTierKeys: async (args) => { touched.push({ what: 'getPermittedTierKeys', args: [args] }); return permitted; },
});

const { createPlaybooksRouter } = require('./index');

let composed = { ok: true, recipe: {}, warnings: [] };
const deps = {
    composeRecipe: async (args) => { touched.push({ what: 'composeRecipe', args: [args] }); return composed; },
    entitlements: { hasCapability: async () => true },
    // The real question, over the stubbed list above.
    tierAccessFor: require('../../core/entitlements/tierAccess').tierAccessFor,
    recipes: { listRecipes: () => [], getRecipe: () => null },
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

function dispatch(body) {
    return new Promise((resolve, reject) => {
        const url = '/recipes/compose';
        const req = {
            method: 'POST', url, originalUrl: url, path: url, query: {}, body, headers: {},
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
        router(req, res, (err) => reject(err || new Error('fell through: POST /recipes/compose')));
    });
}

const composedOn = () => touched.filter((t) => t.what === 'composeRecipe').map((t) => t.args[0].tier);
const listAsked = () => touched.filter((t) => t.what === 'getPermittedTierKeys').map((t) => t.args[0]);

test.beforeEach(() => { touched.length = 0; permitted = new Set(['auto', 'fast']); composed = { ok: true, recipe: {}, warnings: [] }; });

test('a tier the caller\'s groups do not allow is refused by name, and no model is asked', async () => {
    const res = await dispatch({ description: 'a supplier intake', tier: 'pro' });
    assert.strictEqual(res.statusCode, 403, JSON.stringify(res.body));
    assert.strictEqual(res.body.code, 'tier_not_permitted');
    assert.match(res.body.error, /"pro"/);
    assert.deepStrictEqual(composedOn(), []);
});

test('a tier they may use still composes on that tier', async () => {
    permitted = new Set(['auto', 'fast', 'thinking']);
    const res = await dispatch({ description: 'a supplier intake', tier: 'thinking' });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(composedOn(), ['thinking']);
});

test('deep_thinking is measured as pro, its other name', async () => {
    const refused = await dispatch({ description: 'a supplier intake', tier: 'deep_thinking' });
    assert.strictEqual(refused.statusCode, 403);
    permitted = new Set(['fast', 'pro']);
    const allowed = await dispatch({ description: 'a supplier intake', tier: 'deep_thinking' });
    assert.strictEqual(allowed.statusCode, 200, JSON.stringify(allowed.body));
    assert.deepStrictEqual(composedOn(), ['deep_thinking']);
});

test('the list is the one the dialog offers: the caller\'s own, for automation', async () => {
    await dispatch({ description: 'a supplier intake', tier: 'fast' });
    const [args] = listAsked();
    assert.strictEqual(args.userId, 'me');
    assert.strictEqual(args.taskType, 'automation');
});

// `auto` read as the literal key `auto`: a group narrowed to `pro` (the
// group editor cannot even list `auto`) was refused, and a list that did hold
// `auto` composed on it — which composeRecipe resolves to the FAST model,
// whatever the groups allow. `auto` chooses within the caller's own tiers.
test('auto composes on a tier the caller may use: fast when it is theirs, else the cheapest that is', async () => {
    permitted = new Set(['auto', 'fast', 'pro']);
    assert.strictEqual((await dispatch({ description: 'a supplier intake', tier: 'auto' })).statusCode, 200);
    permitted = new Set(['pro', 'thinking']);
    const narrowed = await dispatch({ description: 'a supplier intake', tier: 'auto' });
    assert.strictEqual(narrowed.statusCode, 200, JSON.stringify(narrowed.body));
    assert.deepStrictEqual(composedOn(), ['fast', 'thinking']);
});

test('auto with no tier to land on is the same 403', async () => {
    permitted = new Set(['auto']);
    const res = await dispatch({ description: 'a supplier intake', tier: 'auto' });
    assert.strictEqual(res.statusCode, 403, JSON.stringify(res.body));
    assert.strictEqual(res.body.code, 'tier_not_permitted');
    assert.deepStrictEqual(composedOn(), []);
});

// The dialog sends no tier at all, which makes this the request that matters.
// It composed on `fast` without asking, so a group narrowed to `thinking`, or
// to an on-prem custom tier for data residency, still sent the person's
// description to the fast model.
test('the dialog sends no tier: it composes on fast when that is theirs, else on the cheapest tier that is', async () => {
    const res = await dispatch({ description: 'a supplier intake', locale: 'nl' });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    permitted = new Set(['pro', 'thinking']);
    const narrowed = await dispatch({ description: 'a supplier intake', locale: 'nl' });
    assert.strictEqual(narrowed.statusCode, 200, JSON.stringify(narrowed.body));
    assert.deepStrictEqual(composedOn(), ['fast', 'thinking']);
    assert.strictEqual(listAsked().length, 2, 'the list is asked every time');
});

test('the dialog\'s request, from somebody with no tier compose may choose, is refused and no model is asked', async () => {
    permitted = new Set(['custom:onprem']);
    const res = await dispatch({ description: 'a supplier intake' });
    assert.strictEqual(res.statusCode, 403, JSON.stringify(res.body));
    assert.strictEqual(res.body.code, 'tier_not_permitted');
    assert.strictEqual(res.body.error, 'Tier "fast" is not available on your account.');
    assert.deepStrictEqual(composedOn(), []);
});

// composeRecipe answers an unreachable model with a fixed sentence and the id
// its log line carries; the id is the only thing that ties the person's
// screen to the operator's log, so the refusal has to carry it.
test('an unreachable model is a 502 with the fixed sentence and the correlation id the log carries', async () => {
    composed = { ok: false, code: 'compose_failed', status: 502, error: 'The model could not be reached. Try again in a moment.', correlationId: 'req-4711' };
    const res = await dispatch({ description: 'a supplier intake' });
    assert.strictEqual(res.statusCode, 502);
    assert.strictEqual(res.body.code, 'compose_failed');
    assert.strictEqual(res.body.error, 'The model could not be reached. Try again in a moment.');
    assert.strictEqual(res.body.correlationId, 'req-4711');
});
