/**
 * The enterprise-split grandfather, proven against real Postgres
 * (@electric-sql/pglite behind the db.js facade, the same seam as
 * org-granted-capabilities-2026-09.integration.test.js), not a string mock.
 *
 * The properties under test:
 *   - the six ids here are exactly the registry's new Enterprise-only GA betas;
 *   - --dry-run writes nothing (plans, org menus AND markers);
 *   - a failed pass throws, writes no marker, and the retry finishes the job
 *     without appending anything twice;
 *   - PAID restricted plans (price > 0 or metered, whatever their tier) gain
 *     every missing id; webpage_sharing follows webpages on ANY plan, free ones
 *     included; free plans gain nothing else; NULL lists stay NULL;
 *   - stored org menus gain the five ids, plus webpage_sharing next to
 *     webpages; NULL menus stay NULL;
 *   - a second run is a byte-identical no-op;
 *   - after the marker, a super-admin's removal survives every later run, and
 *     the marker is per id;
 *   - a table or column that does not exist yet means "nothing to keep".
 *
 * Run: cd server && node --test migrations/enterprise-split-2026-10.integration.test.js
 */

const { test, before } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const Module = require('node:module');

const SERVER = path.join(__dirname, '..');

// ── pglite behind the db.js facade ─────────────────────────────────────────
const { PGlite } = require('@electric-sql/pglite');
let pg = new PGlite();

// Flip to make every read of `organizations` fail, as a flaky DB would.
let failOrgReads = false;

function adaptResult(res) {
    const r = Array.isArray(res) ? (res[res.length - 1] || {}) : (res || {});
    const rows = r.rows || [];
    const rowCount = (r.fields || []).length > 0
        ? rows.length
        : (typeof r.affectedRows === 'number' ? r.affectedRows : 0);
    return { rows, rowCount };
}
async function rawQuery(sql, params) {
    if (failOrgReads && /FROM organizations/.test(sql)) throw new Error('simulated connection reset');
    if (Array.isArray(params) && params.length > 0) return adaptResult(await pg.query(sql, params));
    return adaptResult(await pg.query(sql));
}

function mock(absPath, exportsObj) {
    const m = new Module(absPath);
    m.exports = exportsObj;
    m.loaded = true;
    require.cache[absPath] = m;
}

mock(path.join(SERVER, 'db.js'), {
    run: rawQuery,
    getOne: async (sql, params) => (await rawQuery(sql, params)).rows[0] || null,
    getAll: async (sql, params) => (await rawQuery(sql, params)).rows,
    exec: (sql) => rawQuery(sql),
});

const { up, NEW_IDS, MARKER_PREFIX, isPaidPlan, additionsFor } = require('./enterprise-split-2026-10');

// The five ids every paid list gains, in the order the migration appends them.
const FIVE = ['automation_privacy_steps', 'studio_documents', 'datatable_retention', 'kb_datatable_sources', 'kb_scheduled_refresh'];
// All six, in NEW_IDS order (webpage_sharing third).
const SIX = ['automation_privacy_steps', 'studio_documents', 'webpage_sharing', 'datatable_retention', 'kb_datatable_sources', 'kb_scheduled_refresh'];

const planLists = async () => {
    const r = await rawQuery(`SELECT id, allowed_beta_features AS l FROM subscription_plans ORDER BY id`);
    return Object.fromEntries(r.rows.map((x) => [x.id, x.l == null ? null : (() => { try { return JSON.parse(x.l); } catch (_) { return x.l; } })()]));
};
const orgMenus = async () => {
    const r = await rawQuery(`SELECT id, "org_available_capabilities" AS m FROM organizations ORDER BY id`);
    return Object.fromEntries(r.rows.map((x) => [x.id, x.m == null ? null : JSON.parse(x.m)]));
};
const markers = async () => (await rawQuery(`SELECT key FROM config ORDER BY key`)).rows.map((x) => x.key);

before(async () => {
    await pg.exec(`
        CREATE TABLE subscription_plans (
            id TEXT PRIMARY KEY,
            name TEXT,
            plan_type TEXT DEFAULT 'organization',
            price REAL,
            billing_model TEXT DEFAULT 'fixed',
            tier TEXT,
            allowed_beta_features TEXT
        );
        CREATE TABLE organizations (
            id TEXT PRIMARY KEY,
            "org_available_capabilities" TEXT DEFAULT NULL
        );
        CREATE TABLE config (
            key TEXT PRIMARY KEY,
            value TEXT,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
    `);
    await pg.query(`INSERT INTO subscription_plans (id, name, plan_type, price, billing_model, tier, allowed_beta_features) VALUES
        -- The paid "Bee Flow" plan: tier NULL, so a tier filter would miss it.
        ('bee-flow',        'Bee Flow',       'organization', 30,   'fixed',   NULL,         '["automations","webpages"]'),
        ('team',            'Team',           'organization', 15,   'fixed',   'pro',        '["automations"]'),
        ('enterprise-null', 'Enterprise',     'organization', 50,   'fixed',   'enterprise', NULL),
        -- Pay-as-you-go: price 0 but a paying customer.
        ('payg',            'PAYG',           'organization', 0,    'metered', NULL,         '["webpages"]'),
        ('free-default',    'Free',           'organization', 0,    'fixed',   NULL,         '[]'),
        -- A free plan that shares webpages today keeps sharing them.
        ('free-webpages',   'Free+Pages',     'organization', 0,    'fixed',   NULL,         '["webpages"]'),
        ('free-null-price', 'Legacy',         'organization', NULL, 'fixed',   NULL,         '["knowledge_bases_beta"]'),
        ('partial',         'Partial',        'organization', 20,   'fixed',   'pro',        '["studio_documents"]'),
        ('malformed',       'Broken',         'organization', 10,   'fixed',   'pro',        'not json'),
        ('consumer-plus',   'Plus',           'consumer',     9.99, 'fixed',   'pro',        '["knowledge_bases_beta"]')`);
    await pg.query(`INSERT INTO organizations (id, "org_available_capabilities") VALUES
        ('org-null',  NULL),
        ('org-web',   '["webpages","notebooks"]'),
        ('org-noweb', '["notebooks"]'),
        ('org-empty', '[]')`);
});

test('registered in LOOSE_MIGRATIONS and exports up()', () => {
    const { LOOSE_MIGRATIONS } = require('../boot/bootMigrations');
    assert.ok(LOOSE_MIGRATIONS.includes('enterprise-split-2026-10'), 'an unregistered migration never runs');
    assert.strictEqual(typeof up, 'function');
});

test('NEW_IDS are exactly the registry\'s enterprise-split betas (GA, id === licence feature, Enterprise only)', () => {
    const tiers = require('../license/tiers');
    const { BETA_FEATURES, BetaLifecycle } = require('../core/entitlements/betaFeatures');
    assert.deepStrictEqual([...NEW_IDS], SIX);
    for (const id of NEW_IDS) {
        const row = BETA_FEATURES.find((f) => f.id === id);
        assert.ok(row, `${id} is a beta row`);
        assert.strictEqual(row.licenseFeature, id, `${id}: id === licenseFeature`);
        assert.strictEqual(row.lifecycle, BetaLifecycle.GA, `${id} is GA`);
        assert.ok(tiers.TIER_FEATURES.enterprise.includes(id), `${id} is listed in the enterprise tier`);
        assert.ok(!tiers.tierHasFeature('community', id), `${id} is not a Community feature`);
    }
});

test('isPaidPlan: a price above zero or metered billing; tier plays no part', () => {
    assert.strictEqual(isPaidPlan({ price: 30, tier: null }), true);
    assert.strictEqual(isPaidPlan({ price: '15', tier: 'pro' }), true, 'NUMERIC comes back as text');
    assert.strictEqual(isPaidPlan({ price: 0, billing_model: 'metered' }), true);
    assert.strictEqual(isPaidPlan({ price: 0, billing_model: 'fixed', tier: 'enterprise' }), false);
    assert.strictEqual(isPaidPlan({ price: null }), false);
    assert.strictEqual(isPaidPlan({}), false);
    assert.deepStrictEqual(additionsFor(['webpages'], SIX, { paid: false }), ['webpage_sharing']);
    assert.deepStrictEqual(additionsFor([], SIX, { paid: true }), FIVE);
});

test('--dry-run reports but writes nothing: no plan, no menu, no marker', async () => {
    const beforePlans = await planLists();
    const beforeOrgs = await orgMenus();
    const res = await up({ dryRun: true });
    assert.deepStrictEqual(res.ids, SIX);
    assert.strictEqual(res.plans, 6, 'bee-flow, team, payg, free-webpages, partial and consumer-plus would change');
    assert.strictEqual(res.orgs, 3);
    assert.deepStrictEqual(await planLists(), beforePlans);
    assert.deepStrictEqual(await orgMenus(), beforeOrgs);
    assert.deepStrictEqual(await markers(), [], 'the real run still has to happen');
});

test('a failed pass throws and writes no marker; the retry completes without duplicates', async () => {
    failOrgReads = true;
    await assert.rejects(up(), /incomplete, will retry: org access menus: simulated connection reset/);
    failOrgReads = false;
    assert.deepStrictEqual(await markers(), [], 'no marker after a failed pass: the next boot must retry');
    const afterFailedRun = await planLists();
    assert.deepStrictEqual(afterFailedRun.team, ['automations', ...FIVE], 'pass A ran before pass B failed');

    const res = await up();
    assert.deepStrictEqual(res.ids, SIX);
    assert.strictEqual(res.plans, 0, 'the retry finds every plan already complete');
    assert.strictEqual(res.orgs, 3);
    assert.deepStrictEqual(await markers(), SIX.map((id) => `${MARKER_PREFIX}${id}`).sort());
});

test('plans: paid lists gain every missing id, webpage_sharing follows webpages, the rest is untouched', async () => {
    assert.deepStrictEqual(await planLists(), {
        // Paid, tier NULL, has webpages → all six.
        'bee-flow': ['automations', 'webpages', ...SIX],
        // Paid, no webpages → the five, never webpage_sharing.
        'team': ['automations', ...FIVE],
        // Unrestricted already includes every beta.
        'enterprise-null': null,
        // Metered at price 0 is paid.
        'payg': ['webpages', ...SIX],
        // The free default gains nothing.
        'free-default': [],
        // Free, but shares webpages today → only webpage_sharing.
        'free-webpages': ['webpages', 'webpage_sharing'],
        // A NULL price is not a paid plan.
        'free-null-price': ['knowledge_bases_beta'],
        // Already had one of them → no duplicate.
        'partial': ['studio_documents', 'automation_privacy_steps', 'datatable_retention', 'kb_datatable_sources', 'kb_scheduled_refresh'],
        // Unparseable lists are left exactly as they are.
        'malformed': 'not json',
        // Paid consumer plans count too.
        'consumer-plus': ['knowledge_bases_beta', ...FIVE],
    });
});

test('org menus: stored menus gain the five, plus webpage_sharing next to webpages; NULL stays NULL', async () => {
    assert.deepStrictEqual(await orgMenus(), {
        'org-empty': FIVE,
        'org-noweb': ['notebooks', ...FIVE],
        'org-null': null,
        'org-web': ['webpages', 'notebooks', ...SIX],
    });
});

test('a second run is a byte-identical no-op', async () => {
    const p = await planLists();
    const o = await orgMenus();
    const m = await markers();
    const res = await up();
    assert.deepStrictEqual(res, { ids: [], plans: 0, orgs: 0 });
    assert.deepStrictEqual(await planLists(), p);
    assert.deepStrictEqual(await orgMenus(), o);
    assert.deepStrictEqual(await markers(), m);
});

test("after the marker, a super-admin's removal survives every later run", async () => {
    await pg.query(`UPDATE subscription_plans SET allowed_beta_features = $1 WHERE id = 'team'`,
        [JSON.stringify(['automations', 'automation_privacy_steps'])]);
    await pg.query(`UPDATE organizations SET "org_available_capabilities" = $1 WHERE id = 'org-web'`,
        [JSON.stringify(['webpages', 'notebooks'])]);
    await up();
    const plans = await planLists();
    const orgs = await orgMenus();
    assert.deepStrictEqual(plans.team, ['automations', 'automation_privacy_steps'], 'the plan editor un-tick is respected');
    assert.deepStrictEqual(orgs['org-web'], ['webpages', 'notebooks'], 'the access-menu un-tick is respected');
});

test('the marker is per id: only an unmarked id is appended again', async () => {
    await pg.query(`DELETE FROM config WHERE key = $1`, [`${MARKER_PREFIX}kb_scheduled_refresh`]);
    const res = await up();
    assert.deepStrictEqual(res.ids, ['kb_scheduled_refresh']);
    const plans = await planLists();
    assert.deepStrictEqual(plans.team, ['automations', 'automation_privacy_steps', 'kb_scheduled_refresh'],
        'the unmarked id comes back; the removed-and-marked ones stay removed');
    assert.deepStrictEqual((await orgMenus())['org-web'], ['webpages', 'notebooks', 'kb_scheduled_refresh']);
    assert.ok((await markers()).includes(`${MARKER_PREFIX}kb_scheduled_refresh`));
});

test('a table or column that does not exist yet means nothing to keep: markers are written', async () => {
    const original = pg;
    pg = new PGlite();
    try {
        // No subscription_plans table at all, and organizations without the menu column.
        await pg.exec(`
            CREATE TABLE organizations (id TEXT PRIMARY KEY);
            CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
        `);
        const res = await up();
        assert.deepStrictEqual(res, { ids: SIX, plans: 0, orgs: 0 });
        assert.strictEqual((await markers()).length, SIX.length);
    } finally {
        await pg.close();
        pg = original;
    }
});
