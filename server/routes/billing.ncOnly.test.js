/**
 * GET /api/billing/{public,offered}-plans — the nc_only audience filter.
 *
 * `nc_only` narrows `is_public`: a public plan carrying it is offered only to
 * organisations that came in through the Nextcloud connector. The anonymous
 * pricing feed must never carry them (it is also shared-cached), and the
 * authenticated feed must carry them only for an NC org.
 *
 * DB-free: the module-level deps of routes/billing.js are replaced in
 * require.cache and the real router is driven with a stub req/res.
 *
 * Run: cd server && node --test routes/billing.ncOnly.test.js
 */

const assert = require('assert');
const { test } = require('node:test');

let plans = [];
let orgs = {};
let sessionOrgId = null;

function stub(path, exports) {
    const filename = require.resolve(path);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

stub('../stores/userStore', {
    getAllPlans: async () => plans,
    getOrganization: async (id) => orgs[id] || null,
    getUser: async () => null,
});

stub('../services/stripeService', { isEnabled: async () => true });

stub('../auth/permissions', {
    requireAuth: (req, res, next) => next(),
    resolveUserOrgIds: async () => new Set(),
});

const router = require('./billing');

function dispatch(path, { authenticated = false } = {}) {
    return new Promise((resolve, reject) => {
        const req = {
            method: 'GET', url: path, originalUrl: path, baseUrl: '', path,
            headers: {}, body: {}, params: {}, query: {},
            session: authenticated
                ? { isAuthenticated: true, user: { id: 'u1', organizationId: sessionOrgId } }
                : {},
            get() { return undefined; },
        };
        const res = {
            statusCode: 200, headers: {}, body: undefined,
            set(k, v) { this.headers[k] = v; return this; },
            setHeader(k, v) { this.headers[k] = v; },
            getHeader(k) { return this.headers[k]; },
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; resolve(this); return this; },
            send(b) { this.body = b; resolve(this); return this; },
            end() { resolve(this); return this; },
        };
        router(req, res, (err) => reject(err || new Error(`fell through router: GET ${path}`)));
    });
}

const ids = (res) => res.body.plans.map(p => p.id);

test.beforeEach(() => {
    plans = [
        { id: 'open', name: 'Pro', is_public: true, plan_type: 'organization', sort_order: 1 },
        { id: 'nc', name: 'Nextcloud Free', is_public: true, nc_only: true, plan_type: 'organization', sort_order: 2 },
        { id: 'hidden', name: 'Custom', is_public: false, plan_type: 'organization', sort_order: 3 },
    ];
    orgs = {
        org_plain: { id: 'org_plain', registrationSource: 'direct' },
        org_nc: { id: 'org_nc', nc_instance_id: 'nc-abc' },
    };
    sessionOrgId = null;
});

// ── public-plans (anonymous) ────────────────────────────────────────────────

test('the anonymous pricing feed omits Nextcloud-only plans', async () => {
    const res = await dispatch('/public-plans');

    assert.deepStrictEqual(ids(res), ['open']);
});

test('the anonymous feed stays shared-cacheable — its body is the same for everyone', async () => {
    const res = await dispatch('/public-plans');

    assert.strictEqual(res.headers['Cache-Control'], 'public, max-age=60');
});

// ── offered-plans (authenticated) ───────────────────────────────────────────

test('a non-Nextcloud org is not offered the restricted plan', async () => {
    sessionOrgId = 'org_plain';

    const res = await dispatch('/offered-plans', { authenticated: true });

    assert.deepStrictEqual(ids(res), ['open']);
});

test('a Nextcloud org is offered it, alongside the open plans', async () => {
    sessionOrgId = 'org_nc';

    const res = await dispatch('/offered-plans', { authenticated: true });

    assert.deepStrictEqual(ids(res), ['open', 'nc']);
});

test('the per-caller feed is never stored in a shared cache', async () => {
    sessionOrgId = 'org_nc';

    const res = await dispatch('/offered-plans', { authenticated: true });

    assert.strictEqual(res.headers['Cache-Control'], 'private, no-store');
});

test('a non-public plan stays invisible whether or not it is nc_only', async () => {
    plans.push({ id: 'hidden_nc', name: 'Internal NC', is_public: false, nc_only: true, plan_type: 'organization', sort_order: 4 });
    sessionOrgId = 'org_nc';

    const res = await dispatch('/offered-plans', { authenticated: true });

    assert.ok(!ids(res).includes('hidden_nc'), 'nc_only narrows is_public, it does not override it');
});
