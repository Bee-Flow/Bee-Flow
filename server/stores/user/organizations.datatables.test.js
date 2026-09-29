/**
 * Deleting an organisation has to take its datatables with it — rows included.
 *
 * deleteOrganization cascaded roughly twenty tables and DROPped the analogous
 * physical `custom_tables`, and mentioned `datatables`, `datatable_models`,
 * `automation_datatable_usage` and the per-org row SCHEMA exactly nowhere. So a
 * tenant deleted at a customer's request kept every row of their personal data,
 * indefinitely, in a Postgres schema no UI reaches, no access filter guards and
 * (there being no retention sweep) nothing will ever expire. That is an Art. 17
 * failure in the path the product treats as authoritative, which is why the
 * ORDER is asserted here and not just the presence of the statements.
 *
 * No real DB: `db` is redirected to an in-memory double under every specifier
 * depth in the cascade, exactly as stores/userStore.credentialCleanup.test.js
 * does — see the notes at the top of that file for why all four depths and why
 * NODE_ENV must be set before the first require.
 *
 * Run: cd server && node --test --test-force-exit stores/user/organizations.datatables.test.js
 */

process.env.NODE_ENV = 'test';   // must precede every require

const assert = require('assert');
const { test, after, beforeEach } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { installResolveStub } = require('../../testUtils/stubRequire');

// ONE ordered log, because the properties that matter here are all orderings:
// the schema must be dropped while the metadata still describes it, and the
// access memo must be cleared after the metadata is gone.
const events = [];
const runCalls = [];
let getOneImpl = () => null;
let getAllImpl = () => [];
let runFailsOn = null;   // regex; the matching statement throws (set by a failure test)

const dbStub = {
    pool: {},
    run: async (sql, params) => {
        if (runFailsOn && runFailsOn.test(String(sql))) throw new Error(`${String(sql).split(' ')[2]}: lock timeout`);
        runCalls.push({ sql, params });
        events.push({ kind: 'run', sql: String(sql).replace(/\s+/g, ' ').trim(), params });
        return { rowCount: 1 };
    },
    getOne: async (sql, params) => getOneImpl(sql, params),
    getAll: async (sql, params) => getAllImpl(sql, params),
    exec: async () => {},
    getClient: async () => ({ query: async () => ({ rows: [] }), release() {} }),
    withTransaction: async (fn) => fn({ query: async () => ({ rows: [], rowCount: 0 }) }),
    getRedis: () => null,
    redisHealthy: () => false,
    disconnectRedis: async () => {},
    getPoolStats: () => ({}),
};

const deletedConfigKeys = [];
const configStoreStub = {
    getConfig: async () => null,
    getSecret: async () => null,
    setConfig: async () => {},
    deleteConfig: async (key) => { deletedConfigKeys.push(key); events.push({ kind: 'config', key }); },
};

let resetThrows = null;   // set by the failure test, cleared in beforeEach
const datatableDbStub = {
    orgScopeKey: (orgId) => `org:${orgId}`,
    scopeKey: (scope) => `${scope.kind}:${scope.id}`,
    reset: async (ownerId, entityId) => {
        events.push({ kind: 'reset', ownerId, entityId });
        if (resetThrows) throw new Error(resetThrows);
    },
    invalidate: (key) => { events.push({ kind: 'invalidate', key }); },
    dropDatatable: async () => true,
};

const cachePurges = [];

const restore = installResolveStub({
    './db': dbStub,
    '../db': dbStub,
    '../../db': dbStub,
    '../../../db': dbStub,

    './configStore': configStoreStub,
    '../configStore': configStoreStub,
    // The two per-org policy modules are NOT stubbed — the point is that the
    // real CONFIG_KEY_PREFIX values reach the teardown list — but they each
    // reach configStore by this longer specifier.
    '../../stores/configStore': configStoreStub,

    '../datatableDbStore': datatableDbStub,
    '../integrationCacheStore': {
        purgeForOrg: async (orgId) => { cachePurges.push(orgId); return 2; },
        purgeForUser: async () => 0,
    },

    './notificationStore': { deleteNotificationsForUser: async () => {} },
    '../notificationStore': { deleteNotificationsForUser: async () => {} },
    '../services/planEntitlements': { applyPlanToOrg: async () => {} },
    '../../services/planEntitlements': { applyPlanToOrg: async () => {} },
    './usageStore': { invalidatePaygCache: () => {} },
    '../usageStore': { invalidatePaygCache: () => {} },
    // Non-unref'd 5-minute sweep installed at require time; without this the
    // runner hangs after the last assertion.
    '../../auth/decryptAudit': { trackDecrypt: () => {}, getDecryptStats: () => null },
});
after(restore);

const organizations = require('./organizations');

const ORG = 'orgA';
const idx = (pred) => events.findIndex(pred);
const runIdx = (re) => idx(e => e.kind === 'run' && re.test(e.sql));

/** The org exists; `hasModel` decides whether it ever used datatables. */
function withOrg({ hasModel = true } = {}) {
    getOneImpl = (sql) => {
        if (/FROM organizations WHERE id/i.test(sql)) return { id: ORG, nc_instance_id: null };
        if (/FROM datatable_models WHERE scope_kind/i.test(sql)) return hasModel ? { present: 1 } : null;
        return null;
    };
    getAllImpl = () => [];
}

beforeEach(() => {
    resetThrows = null;
    runFailsOn = null;
    events.length = 0;
    runCalls.length = 0;
    deletedConfigKeys.length = 0;
    cachePurges.length = 0;
});

test('every datatable metadata table is swept, scoped to the organisation', async () => {
    withOrg();
    await organizations.deleteOrganization(ORG);

    for (const table of ['automation_datatable_usage', 'datatables', 'datatable_models']) {
        const hit = runCalls.find(c => new RegExp(`DELETE FROM ${table}\\b`, 'i').test(c.sql));
        assert.ok(hit, `${table} must be swept on org delete`);
        assert.deepStrictEqual(hit.params, [ORG]);
    }
    const grants = runCalls.find(c => /DELETE FROM datatable_grants/i.test(c.sql));
    assert.ok(grants, 'datatable_grants must be swept');
    assert.deepStrictEqual(grants.params, [ORG]);
});

test('the row SCHEMA is dropped BEFORE the metadata that describes it', async () => {
    withOrg();
    await organizations.deleteOrganization(ORG);

    const drop = idx(e => e.kind === 'reset');
    assert.ok(drop >= 0, 'the per-org schema must actually be dropped — a FK cannot do it');
    assert.deepStrictEqual(
        { ownerId: events[drop].ownerId, entityId: events[drop].entityId },
        { ownerId: `org:${ORG}`, entityId: `org:${ORG}` },
        'the engine addresses a tenant by its SCOPE KEY — a bare org id hashes to '
        + 'a schema nobody\'s rows are in, and DROP SCHEMA there reports success',
    );
    const meta = runIdx(/DELETE FROM datatable_models/i);
    assert.ok(meta >= 0);
    assert.ok(drop < meta,
        'inverted, a crash here leaves personal data in a schema nothing describes, nothing guards and no UI reaches');
});

test('the access memo is cleared last, so a re-created org id inherits nothing', async () => {
    withOrg();
    await organizations.deleteOrganization(ORG);

    const inv = idx(e => e.kind === 'invalidate' && e.key === `org:${ORG}`);
    const meta = runIdx(/DELETE FROM datatable_models/i);
    assert.ok(inv >= 0, 'invalidate must be called');
    assert.ok(inv > meta, 'the memo says "this org has datatables" for 60s');
});

test('the schema name is never rebuilt at the call site', () => {
    // DROP SCHEMA … CASCADE is irreversible. Resolving the name from the stored
    // scope is what keeps it on the right tenant; concatenating an id here is
    // how it lands on the wrong one — and it silently stops matching the day
    // the naming scheme changes.
    // Match on CODE, not prose: the comment above the block explains at length
    // what it is refusing to do, and a whole-file regex reads that explanation
    // as the thing it warns against.
    //
    // Genuinely textual: the property is an ABSENCE ("this file never builds
    // or issues its own DROP SCHEMA"), not a value the scenarios above could
    // fail to exercise — the schema-drop test proves the delegation happens
    // on the tested path, but not that no OTHER, untested path in the same
    // file reconstructs the name and runs the statement directly. There is no
    // input to this test file's calls that would make a dead second
    // implementation observable.
    const SRC = fs.readFileSync(path.join(__dirname, 'organizations.js'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
    assert.doesNotMatch(SRC, /dtorg_/);
    assert.doesNotMatch(SRC, /DROP SCHEMA/i);
});

test('a FAILED schema drop keeps the metadata AND the organisation, and says so', async () => {
    // The ordering above defends against a CRASH between the two steps. This is
    // the other half: a drop that throws. Deleting the metadata anyway would
    // leave the organisation's personal data in a schema nothing describes, no
    // access filter guards and no retention reaches — silently, and reported
    // to the caller as a successful deletion. So the failure propagates, and
    // the organisation row stays until someone repairs and retries.
    withOrg({ hasModel: true });
    resetThrows = 'permission denied for schema';

    await assert.rejects(organizations.deleteOrganization(ORG), /permission denied for schema/);

    assert.ok(events.some(e => e.kind === 'reset'), 'the drop was attempted');
    assert.strictEqual(runIdx(/DELETE FROM organizations/i), -1,
        'the organisation row must survive a failed teardown');
    // Plain substring matching, deliberately. A template literal turns \b into
    // a BACKSPACE character rather than a regex word boundary, so a regex built
    // that way matches nothing and this assertion passes no matter what the
    // code does. It did exactly that until a mutation test caught it.
    const swept = runCalls
        .map(c => String(c.sql).replace(/s+/g, ' '))
        .filter(sql => sql.includes('datatable'));
    assert.deepStrictEqual(swept, [],
        'no datatable metadata may be deleted while its rows are still in the schema; got: '
        + JSON.stringify(swept));
});

test('an org that never used datatables is not asked to drop a schema', async () => {
    withOrg({ hasModel: false });
    await organizations.deleteOrganization(ORG);

    assert.strictEqual(idx(e => e.kind === 'reset'), -1,
        'no model row means no schema; asking the engine for one 404s and logs noise');
    // ...and the metadata sweep still runs, so a second teardown is a no-op
    // rather than an error.
    assert.ok(runIdx(/DELETE FROM datatables\b/i) >= 0);
});

test('the per-org consent keys die with the organisation', async () => {
    withOrg();
    await organizations.deleteOrganization(ORG);

    // These two do NOT match the `org_<orgId>_%` wipe, which is exactly how an
    // organisation's "yes, store third-party payloads at rest" decision used to
    // outlive the organisation — and come back ON for a re-created id.
    for (const key of [`org_integration_cache_${ORG}`, `org_ai_context_${ORG}`,
        `org_privacy_shield_${ORG}`, `connector_tenant_key_${ORG}`]) {
        assert.ok(deletedConfigKeys.includes(key), `${key} must be deleted with the org`);
    }
    // The convention-following family still goes by pattern.
    const like = runCalls.find(c => /DELETE FROM config WHERE key LIKE/i.test(c.sql));
    assert.ok(like);
    assert.deepStrictEqual(like.params, [`org_${ORG}_%`]);
});

test('cached third-party answers are purged through the store, not by hand', async () => {
    withOrg();
    await organizations.deleteOrganization(ORG);
    // Through the store because it also drops the memoised per-org row/byte
    // counters; a raw DELETE leaves them claiming the org still stores what was
    // just erased.
    assert.deepStrictEqual(cachePurges, [ORG]);
});

test('a failed child delete stops the teardown before the organisation row', async () => {
    // Twenty child tables used to be deleted inside empty catch blocks, so a
    // voiceprint or credential row that refused to go was left behind — and
    // the organisation that consented to it was deleted anyway.
    withOrg({ hasModel: false });
    runFailsOn = /DELETE FROM voiceprints/i;

    await assert.rejects(organizations.deleteOrganization(ORG), /voiceprints: lock timeout/);

    assert.strictEqual(runIdx(/DELETE FROM organizations/i), -1);
    assert.strictEqual(runIdx(/DELETE FROM connection_grants/i), -1, 'nothing after the failing step runs');
});
