/**
 * Build-stamped `_ent:` session memo — U3.
 *
 * resolveEntitlements memoises the full entitlement snapshot on req.session.
 * That session record is cross-process state (Postgres user_sessions + the
 * bf:sess Redis cache), while the v<N> slot in the key reads the IN-PROCESS
 * server-licence counter — so during a rolling deploy an old and a new pod
 * would read each other's snapshots under the same v<N>. buildKey() stamps the
 * build version into the key to close that gap. Pinned here:
 *   - the memo is written under exactly buildKey(`_ent:<uid>:o<org>:v<ver>`),
 *     i.e. the key contains the stamp;
 *   - a memo under the SAME stamp is honoured (read path uses the same key);
 *   - a memo under ANOTHER build's stamp is ignored — two different stamps
 *     are two different keys, so the foreign entry is simply a miss.
 *
 * DB seam + mock baseline copied from entitlements.test.js (see the NOTE there
 * on stub keys and why the stub stays installed for the whole file).
 *
 * Run: cd server && node --test --test-force-exit core/entitlements/entitlements.cacheStamp.test.js
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { installResolveStub } = require('../../testUtils/stubRequire');

// ── DB seam (identical to entitlements.test.js) ──────────────────────────
const noDb = async () => { throw new Error('[test] DB access is stubbed out in this unit test'); };
const dbStub = {
    pool: { query: noDb, connect: noDb, on() {}, end: async () => {}, totalCount: 0, idleCount: 0, waitingCount: 0 },
    getRedis: () => null,
    redisHealthy: () => false,
    disconnectRedis: async () => {},
    run: noDb,
    getOne: noDb,
    getAll: noDb,
    exec: noDb,
    getClient: noDb,
    withTransaction: noDb,
    makeStoreInit: () => async () => {},
    getPoolStats: () => ({ total: 0, idle: 0, waiting: 0 }),
    _runTransaction: noDb,
    _instrumentClient: (c) => c,
};
class StubPgClient {
    on() { return this; }
    async connect() { throw new Error('[test] pg is stubbed out in this unit test'); }
    async query() { throw new Error('[test] pg is stubbed out in this unit test'); }
    async end() {}
}
const pgStub = { Client: StubPgClient, Pool: StubPgClient, types: { setTypeParser() {} } };

const restore = installResolveStub({
    '../db': dbStub,
    '../../db': dbStub,
    '../../../db': dbStub,
    pg: pgStub,
});
after(() => restore());

const license = require('../../license/index');
const betaFeatures = require('./betaFeatures');
const userStore = require('../../stores/userStore');
const planEnt = require('../../services/planEntitlements');
const configStore = require('../../stores/configStore');
const mcpStore = require('../../stores/mcpStore');
const ent = require('./entitlements');
const { buildKey, APP_BUILD_SHA } = require('../../utils/buildInfo');

// Mock baseline (cloud, enterprise org) — mirrors entitlements.test.js.
function baseMocks() {
    license.serverLicenseGovernsOrgs = () => false; // cloud
    license.getServerLicenseVersion = () => 0;
    license.getBestTierForOrgs = async () => 'enterprise';
    license.getTierForUser = async () => 'community';
    license.orgGrantsFeature = async () => false;
    betaFeatures.getEffectiveOrgBetaAllowList = async () => ['webpages'];
    userStore.getUser = async () => ({ id: 'u1', organizationId: 'o1', groups: [], role: 'user' });
    userStore.getAllGroups = async () => [];
    userStore.getOrgEnabledIntegrations = async () => [];
    userStore.getOrgEnabledBetaFeatures = async () => [];
    userStore.getOrgGrantedCapabilities = async () => [];
    userStore.getOrgAvailableCapabilities = async () => null;
    userStore.getSingleOrgId = async () => null;
    userStore.getOrganization = async () => ({ enabledIntegrations: null });
    planEnt.getOrgCaps = async () => ({ integrations: null, betaFeatures: null });
    configStore.getConfig = async () => null;
    mcpStore.listServers = async () => [];
    if (typeof ent._resetSingleOrgCache === 'function') ent._resetSingleOrgCache();
}

// tierHint short-circuits resolveTierContext so no license middleware (and no
// `_lic:` memo) is involved — this file pins the `_ent:` key only.
const ARGS = { userId: 'u1', orgId: 'o1', tierHint: 'enterprise' };
const STAMPED_KEY = buildKey('_ent:u1:oo1:v0'); // `_ent:<uid>:o<org>:v<ver>` + build stamp

test('the snapshot memo is written under the build-stamped key', async () => {
    baseMocks();
    const req = { session: { user: { id: 'u1', role: 'user' } } };
    const snap = await ent.resolveEntitlements({ ...ARGS, session: req.session, req });
    assert.equal(snap.degraded, false);

    const entKeys = Object.keys(req.session).filter(k => k.startsWith('_ent:'));
    assert.deepEqual(entKeys, [STAMPED_KEY]);
    assert.ok(STAMPED_KEY.endsWith(`:b${APP_BUILD_SHA}`), 'the key must contain this build\'s stamp');
});

test('a memo under the SAME stamp is honoured on the read path', async () => {
    baseMocks();
    const sentinel = { mode: 'cloud', tier: 'sentinel-tier', degraded: false };
    const req = {
        session: {
            user: { id: 'u1', role: 'user' },
            [STAMPED_KEY]: { expiresAt: Date.now() + 60_000, value: sentinel },
        },
    };
    const out = await ent.resolveEntitlements({ ...ARGS, session: req.session, req });
    assert.equal(out, sentinel, 'the primed stamped memo must be returned as-is');
});

test('a memo under ANOTHER build\'s stamp is ignored (rolling-deploy isolation)', async () => {
    baseMocks();
    // The "other pod" cached a snapshot under ITS stamp: same user, same org,
    // same v<N> — only the build stamp differs. Must be a miss.
    const foreign = { mode: 'cloud', tier: 'sentinel-tier', degraded: false };
    const req = {
        session: {
            user: { id: 'u1', role: 'user' },
            ['_ent:u1:oo1:v0:bother-build']: { expiresAt: Date.now() + 60_000, value: foreign },
        },
    };
    const out = await ent.resolveEntitlements({ ...ARGS, session: req.session, req });
    assert.notEqual(out, foreign, 'the foreign memo must not be served');
    assert.notEqual(out.tier, 'sentinel-tier');
    // ...and this build wrote its own stamped key next to the foreign one.
    assert.ok(req.session[STAMPED_KEY], 'own stamped memo must be written');
});
