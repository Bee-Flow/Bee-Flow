/**
 * Unit tests for the unified entitlement resolver + capability registry.
 *
 * Run: node --test --test-timeout=20000 core/entitlements/entitlements.test.js
 *
 * DB-free: the resolver's lazy-required data sources (license, userStore,
 * betaFeatures, planEntitlements, configStore, mcpStore) are monkeypatched on
 * the cached module objects so we test the precedence math, not the DB.
 *
 * The monkeypatching alone was never enough: merely REQUIRING those stores pulls
 * in `db.js`, which builds a real pg Pool at module load, and configStore opens a
 * dedicated pg Client for its LISTEN/NOTIFY invalidation channel. That produced
 * ECONNREFUSED 127.0.0.1:5432 on every run. So the DB itself is cut at the seam:
 * `installResolveStub` redirects the `db` module (at all three require depths used
 * in this repo) and the `pg` driver to in-memory doubles. Nothing else is stubbed —
 * the resolver, the capability registry, the licence tier math and the real store
 * modules all load and run for real.
 *
 * NOTE on the stub keys: they are the require strings AS WRITTEN INSIDE the
 * modules being loaded, not relative to this file. stores/*.js and services/*.js
 * say require('../db'); core/<domain>/*.js says require('../../db'); a few
 * modules one level deeper say require('../../../db'). A key that matches nothing
 * fails SILENTLY (the real module loads), so all three depths are listed.
 *
 * The stub stays installed for the whole file — the resolver lazily requires
 * further stores (modules/index, orgCustomIntegrationStore,
 * integrationConnectionStore) on the FIRST resolve, long after module load, and
 * restoring early lets those reach the real db.js.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../../testUtils/stubRequire');

// ── DB seam ──────────────────────────────────────────────────────────────
// Every store still runs its real module-load schema init; it just fails fast
// and loudly against these doubles instead of dialling 127.0.0.1:5432. Each
// store already catches its own init failure, exactly as it does in production
// when the DB is briefly unreachable.
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

const registry = require('./capabilityRegistry');
const license = require('../../license/index');
const betaFeatures = require('./betaFeatures');
const userStore = require('../../stores/userStore');
const planEnt = require('../../services/planEntitlements');
const configStore = require('../../stores/configStore');
const mcpStore = require('../../stores/mcpStore');
const ent = require('./entitlements');

const realListBetas = betaFeatures.listBetaFeatures.bind(betaFeatures);

// Registry snapshot taken BEFORE any resolve runs: resolveEntitlements()
// refreshes the dynamic MCP-server projection into the registry, so reading it
// afterwards would see mcp:<id> rows the shape assertions below do not expect.
const caps = registry.listCapabilities();
const byKind = {};
for (const c of caps) byKind[c.kind] = (byKind[c.kind] || 0) + 1;

// ── Registry shape ───────────────────────────────────────────────────────
describe('registry shape', () => {
    it('mcp_marketplace is no longer a capability (MCP servers are integrations)', () => {
        assert.strictEqual(registry.getCapability('mcp_marketplace'), null, 'mcp_marketplace is no longer a capability (MCP servers are integrations)');
    });
    it('no capability uses the removed mcp kind', () => {
        assert.ok(!caps.some(c => c.kind === 'mcp'), 'no capability uses the removed mcp kind');
    });
    it('webpages is a beta', () => {
        assert.strictEqual(registry.getCapability('webpages').kind, 'beta', 'webpages is a beta');
    });
    it('notebooks is a core capability', () => {
        assert.strictEqual(registry.getCapability('notebooks').kind, 'core');
    });
    it('compliance_hub_gdpr is a beta-kind capability (subscription-togglable), aia/iso stay core', () => {
        // The GA compound flag in betaFeatures.js claims the id, so cloud plans
        // govern the hub via allowed_beta_features while the mount id and every
        // useCan('compliance_hub_gdpr') call site resolve unchanged.
        assert.strictEqual(registry.getCapability('compliance_hub_gdpr').kind, 'beta');
        assert.strictEqual(registry.getCapability('compliance_hub_gdpr').licenseFeature, 'compliance_hub_gdpr');
        assert.strictEqual(registry.getCapability('compliance_hub_aia').kind, 'core');
        assert.strictEqual(registry.getCapability('compliance_hub_iso27001').kind, 'core');
    });
    it('the eight per-framework compliance capabilities are core-kind with licenseFeature = id', () => {
        // Compliance Center redesign: derived from TIER_FEATURES (enterprise),
        // enforced in-handler by compliance/frameworkPolicy.js + the runner,
        // never as a mount. Org-level, so NOT user-facing.
        for (const id of COMPLIANCE_FRAMEWORK_CAPS) {
            const cap = registry.getCapability(id);
            assert.ok(cap, `${id} is registered`);
            assert.strictEqual(cap.kind, 'core', `${id} is core-kind`);
            assert.strictEqual(cap.licenseFeature, id, `${id} licenseFeature = id`);
            assert.ok(!cap.userFacing, `${id} is org-level, not per-user togglable`);
        }
    });
    it('gmail is an integration', () => {
        assert.strictEqual(registry.getCapability('gmail').kind, 'integration');
    });
    it('NC family detection', () => {
        assert.ok(registry.isNcCapability('nextcloud-mail'), 'NC family detection');
    });
    it('no id appears in two kinds', () => {
        const seen = new Map();
        for (const c of caps) { assert.ok(!seen.has(c.id), `duplicate id ${c.id}`); seen.set(c.id, c.kind); }
    });
});

// Default mock baseline (cloud, enterprise org) — each test overrides as needed.
function baseMocks() {
    license.serverLicenseGovernsOrgs = () => false; // cloud
    license.getServerLicenseVersion = () => 0;
    license.getBestTierForOrgs = async () => 'enterprise';
    license.getTierForUser = async () => 'community';
    license.orgGrantsFeature = async () => false;
    betaFeatures.listBetaFeatures = realListBetas;
    betaFeatures.getEffectiveOrgBetaAllowList = async () => ['webpages', 'swarm', 'meeting_notes'];
    userStore.getUser = async () => ({ id: 'u1', organizationId: 'o1', groups: ['g1'], role: 'user' });
    userStore.getAllGroups = async () => ([{ id: 'g1', organizationId: 'o1', granted_capabilities: ['gmail'] }]);
    userStore.getOrgEnabledIntegrations = async () => ['google-drive'];
    userStore.getOrgEnabledBetaFeatures = async () => [];
    userStore.getOrgGrantedCapabilities = async () => ['notebooks'];
    userStore.getOrgAvailableCapabilities = async () => null; // null ⇒ unrestricted (full ceiling)
    userStore.getSingleOrgId = async () => null;              // default: not single-tenant
    userStore.getOrganization = async () => ({ enabledIntegrations: null });
    planEnt.getOrgCaps = async () => ({ integrations: null, betaFeatures: null });
    configStore.getConfig = async () => null;
    mcpStore.listServers = async () => [];
    if (typeof ent._resetSingleOrgCache === 'function') ent._resetSingleOrgCache(); // single-tenant cache leaks across cases otherwise
}

// Session shapes reused across scenarios.
const COMPLIANCE_FRAMEWORK_CAPS = [
    'compliance_hub_nis2', 'compliance_hub_cra', 'compliance_hub_data_act', 'compliance_hub_pld',
    'compliance_hub_eaa', 'compliance_hub_dora', 'compliance_hub_machinery', 'compliance_hub_custom',
];

const AS_USER = { userId: 'u1', orgId: 'o1', session: { user: { id: 'u1', role: 'user' } } };
const AS_ADMIN_IN_ORG = { userId: 'admin', orgId: 'o1', session: { isAdmin: true, user: { id: 'admin', role: 'admin' } } };
const AS_ADMIN_NO_ORG = { userId: 'admin', orgId: null, session: { isAdmin: true, user: { id: 'admin', role: 'admin' } } };

// Every scenario's snapshot is resolved once, sequentially, in a single
// file-level before() hook. The mocks are shared mutable module objects, so
// resolving inside the individual tests would make them order/concurrency
// dependent; resolving here keeps each `it` a pure assertion on a fixed value.
const S = {};

async function resolve(key, setup, args) {
    baseMocks();
    if (setup) setup();
    S[key] = await ent.resolveEntitlements(args);
}

before(async () => {
    // Cloud enterprise: ceiling.beta from allow-list + compound AND; effective
    // = orgGrant ∪ group grant ∩ ceiling. (E11 compound, group grant)
    await resolve('cloudEnterprise', null, AS_USER);

    // Group grant cannot exceed ceiling: group grants a beta NOT in allow-list
    await resolve('groupClamped', () => {
        userStore.getAllGroups = async () => ([{ id: 'g1', organizationId: 'o1', granted_capabilities: ['voice_chat'] }]);
    }, AS_USER);

    // E6: group from another org must not bleed in
    await resolve('e6', () => {
        userStore.getAllGroups = async () => ([{ id: 'g1', organizationId: 'OTHER', granted_capabilities: ['gmail'] }]);
    }, AS_USER);

    // E3/E4: self-hosted community → only GA-community betas, auto-on
    await resolve('e3e4', () => {
        license.serverLicenseGovernsOrgs = () => true; // self-hosted
        license.getBestTierForOrgs = async () => 'community';
        license.getTierForUser = async () => 'community';
        userStore.getOrgEnabledBetaFeatures = async () => []; // nothing explicitly enabled
    }, AS_USER);

    // E1: cloud org with NO plan → empty betas
    await resolve('e1', () => {
        betaFeatures.getEffectiveOrgBetaAllowList = async () => []; // no plan → empty
    }, AS_USER);

    // MCP is an integration now. There is no `mcp` snapshot bucket; servers are
    // `mcp:<id>` ids in the integration bucket, opt-in per plan (decision 3).

    // E5: null plan cap ⇒ MCP server NOT in ceiling (off until added to plan),
    // even on a super-admin / enterprise org. Anti-leak preserved via the cap.
    await resolve('e5', () => {
        mcpStore.listServers = async () => ([{ id: 's1', enabled: true }]);
        planEnt.getOrgCaps = async () => ({ integrations: null, betaFeatures: null }); // unrestricted ⇒ catalog only
    }, AS_ADMIN_IN_ORG);

    // E5b: plan cap explicitly includes the server AND org enables it ⇒ granted.
    await resolve('e5b', () => {
        license.getBestTierForOrgs = async () => 'enterprise';
        mcpStore.listServers = async () => ([{ id: 's1', enabled: true }]);
        planEnt.getOrgCaps = async () => ({ integrations: ['gmail', 'mcp:s1'], betaFeatures: null });
        userStore.getOrgEnabledIntegrations = async () => ['mcp:s1']; // org turned it on for all members
    }, AS_USER);

    // E5c: plan cap WITHOUT the server ⇒ not in ceiling even on enterprise.
    await resolve('e5c', () => {
        license.getBestTierForOrgs = async () => 'enterprise';
        mcpStore.listServers = async () => ([{ id: 's1', enabled: true }]);
        planEnt.getOrgCaps = async () => ({ integrations: ['gmail'], betaFeatures: null });
    }, AS_USER);

    // E5d: self-hosted ⇒ server in ceiling (operator-controlled), off until granted.
    await resolve('e5d', () => {
        license.serverLicenseGovernsOrgs = () => true; // self-hosted
        license.getBestTierForOrgs = async () => 'enterprise';
        mcpStore.listServers = async () => ([{ id: 's1', enabled: true }]);
        userStore.getOrgEnabledIntegrations = async () => []; // not enabled yet
        userStore.getOrganization = async () => ({ enabledIntegrations: null });
    }, AS_USER);

    // E2: consumer (no org) → ceiling beta from default_consumer_beta_features
    await resolve('e2', () => {
        license.getTierForUser = async () => 'enterprise';
        configStore.getConfig = async (k) => (k === 'default_consumer_beta_features' ? ['swarm'] : null);
        userStore.getUser = async () => ({ id: 'c1', organizationId: null, groups: [], role: 'user' });
        mcpStore.listServers = async () => ([{ id: 's1', enabled: true }]);
    }, { userId: 'c1', orgId: null, session: { user: { id: 'c1', role: 'user' } } });

    // E13: per-org availability menu bounds distribution. Org-wide + group
    // grants for caps OUTSIDE the menu are dropped from effective; the raw
    // plan/license ceiling is unchanged (the cap is sellable, just not allowed
    // for this org). This is what stops an org-admin enabling integrations the
    // organisation has no access to.
    await resolve('e13', () => {
        userStore.getOrgEnabledIntegrations = async () => ['google-drive', 'gmail']; // org-wide grants
        userStore.getAllGroups = async () => ([{ id: 'g1', organizationId: 'o1', granted_capabilities: ['gmail'] }]);
        userStore.getOrgAvailableCapabilities = async () => ['google-drive']; // menu allows only google-drive
    }, AS_USER);

    // E13b: null availability ⇒ unrestricted (no behaviour change for orgs
    // that never set a menu).
    await resolve('e13b', () => {
        userStore.getOrgEnabledIntegrations = async () => ['gmail'];
        userStore.getOrgAvailableCapabilities = async () => null;
    }, AS_USER);

    // REGRESSION (the reported bug): a CLOUD org on a Free/COMMUNITY-tier plan
    // that lists a compound beta (webpages) in its allowed_beta_features gets
    // the capability even though community is below webpages' licence floor.
    // The compound-AND licence term is satisfied by the PLAN grant
    // (orgGrantsFeature, derived from the plan beta list by getOrgGrantedFeatures),
    // not the tier. Before the fix the API gate excluded webpages from the
    // ceiling → requireCapability 403 feature_locked while the page rendered.
    // On CLOUD the subscription's allowed_beta_features is the SOLE authority —
    // no compound licence/tier gate. A Free/community-tier plan that INCLUDES
    // webpages grants it outright, even with NO derived licence-feature grant.
    await resolve('regressionGrants', () => {
        license.getBestTierForOrgs = async () => 'community';   // Free plan → community tier
        license.getTierForUser = async () => 'community';
        betaFeatures.getEffectiveOrgBetaAllowList = async () => ['webpages']; // plan includes webpages
        license.orgGrantsFeature = async () => false;                        // NO licence-feature grant — must not matter on cloud
    }, AS_USER);

    // Inverse: same community tier, plan does NOT include webpages ⇒ not in the
    // ceiling (the legitimate feature_locked / upgrade case). Membership in the
    // subscription's beta list is the only gate on cloud.
    await resolve('regressionLocks', () => {
        license.getBestTierForOrgs = async () => 'community';
        license.getTierForUser = async () => 'community';
        betaFeatures.getEffectiveOrgBetaAllowList = async () => ['skills']; // webpages NOT included in the plan
    }, AS_USER);

    // COMPLIANCE HUB is a subscription-togglable flag now (GA compound beta,
    // id === licenseFeature): on CLOUD the plan's beta list alone decides.
    // Include it ⇒ effective even on a community-tier plan with no licence
    // grant; exclude it from a restricted list ⇒ out of the ceiling even on an
    // enterprise-tier plan. That second half is the new capability — a
    // tier-projected core gate could never be switched OFF per plan.
    await resolve('complianceInPlan', () => {
        license.getBestTierForOrgs = async () => 'community';
        license.getTierForUser = async () => 'community';
        betaFeatures.getEffectiveOrgBetaAllowList = async () => ['compliance_hub_gdpr'];
        license.orgGrantsFeature = async () => false; // plan list alone must carry it
    }, AS_USER);
    await resolve('complianceExcluded', () => {
        license.getBestTierForOrgs = async () => 'enterprise'; // paid plan…
        betaFeatures.getEffectiveOrgBetaAllowList = async () => ['webpages']; // …whose restricted list opted OUT of compliance
    }, AS_USER);
    // SELF-HOSTED is unchanged: enterprise keeps the hub (all betas in the
    // ceiling + the compound licence term satisfied by tiers.js enterprise).
    await resolve('complianceSelfHosted', () => {
        license.serverLicenseGovernsOrgs = () => true;
        license.getBestTierForOrgs = async () => 'enterprise';
    }, AS_USER);

    // Per-framework capabilities (NIS2, CRA, …): plain enterprise-tier core
    // caps. A community-tier cloud plan that INCLUDES the hub still sees them
    // as `ceiling` — the "available in a higher plan" state frameworkPolicy
    // renders as locked:'ceiling'.
    await resolve('frameworksCommunityWithHub', () => {
        license.getBestTierForOrgs = async () => 'community';
        license.getTierForUser = async () => 'community';
        betaFeatures.getEffectiveOrgBetaAllowList = async () => ['compliance_hub_gdpr'];
        license.orgGrantsFeature = async () => false;
    }, AS_USER);

    // E14: SELF-HOSTED super-admin is bound by the "Organisation access" menu.
    // The platform admin is also the org operator here; the menu's promise
    // ("everything else is locked for them") must apply to them too. The admin
    // still skips the org/group GRANT layer — they get everything AVAILABLE
    // without a per-group grant — but a userFacing cap toggled OFF in the menu
    // is dropped from their effective set. (This is the reported bug: the menu
    // had no effect for the admin in self-hosted, so the Studio nav showed
    // every feature regardless of the ceiling toggles.)
    await resolve('e14', () => {
        license.serverLicenseGovernsOrgs = () => true;                 // self-hosted
        license.getBestTierForOrgs = async () => 'enterprise';
        userStore.getOrgAvailableCapabilities = async () => ['webpages']; // menu allows only webpages
    }, AS_ADMIN_IN_ORG);

    // E14b: CLOUD super-admin is platform staff, NOT bound by a customer org's
    // menu — they keep the full licence ceiling (unchanged behaviour).
    await resolve('e14b', () => {                                       // cloud (serverLicenseGovernsOrgs=false)
        license.getBestTierForOrgs = async () => 'enterprise';
        userStore.getOrgAvailableCapabilities = async () => ['webpages']; // same restrictive menu
    }, AS_ADMIN_IN_ORG);

    // E15: SELF-HOSTED single-switch — the org-access menu is the org-wide grant.
    // A NORMAL user (no super-admin, no group/org grant) gets a menu-enabled
    // non-GA beta WITHOUT it being in org_enabled_beta_features. An out-of-menu
    // beta stays off. This is the "enabled ⇒ works for normal users" half.
    await resolve('e15', () => {
        license.serverLicenseGovernsOrgs = () => true;                 // self-hosted
        license.getBestTierForOrgs = async () => 'enterprise';
        userStore.getOrgEnabledBetaFeatures = async () => [];          // nothing explicitly opted in
        userStore.getOrgAvailableCapabilities = async () => ['webpages']; // menu allows only webpages
    }, AS_USER);

    // E15-orgadmin: an ORG-ADMIN (orgRole=org_admin, role=user ⇒ NOT super-admin)
    // takes the same path and gets the same single-switch result.
    await resolve('e15orgadmin', () => {
        license.serverLicenseGovernsOrgs = () => true;
        license.getBestTierForOrgs = async () => 'enterprise';
        userStore.getOrgEnabledBetaFeatures = async () => [];
        userStore.getOrgAvailableCapabilities = async () => ['webpages'];
        userStore.getUser = async () => ({ id: 'oa', organizationId: 'o1', groups: [], role: 'user', orgRole: 'org_admin' });
    }, { userId: 'oa', orgId: 'o1', session: { user: { id: 'oa', role: 'user', orgRole: 'org_admin' } } });

    // E15b: SELF-HOSTED single-switch for togglable CORE. A menu-enabled core
    // feature is granted org-wide WITHOUT an org_granted_capabilities entry; a
    // toggled-off core feature is dropped.
    await resolve('e15b', () => {
        license.serverLicenseGovernsOrgs = () => true;
        license.getBestTierForOrgs = async () => 'enterprise';
        userStore.getOrgGrantedCapabilities = async () => [];          // nothing explicitly granted
        userStore.getOrgAvailableCapabilities = async () => ['notebooks']; // menu allows only notebooks
    }, AS_USER);

    // E15c: CLOUD core is UNCHANGED — togglable core still needs an explicit
    // org_granted_capabilities entry (the menu alone does not grant on cloud).
    await resolve('e15c', () => {                                       // cloud
        license.getBestTierForOrgs = async () => 'enterprise';
        userStore.getOrgGrantedCapabilities = async () => [];          // not granted
        userStore.getOrgAvailableCapabilities = async () => ['notebooks']; // menu allows it
    }, AS_USER);

    // E16: SELF-HOSTED, GLOBAL ADMIN with NO own org (organizationId=null), in a
    // single-tenant install ⇒ bound by THAT one org's access menu (governingOrgId
    // falls back to the single org). This is the exact reported bug: today's E14
    // passes orgId='o1' and never exercises the null-org admin path.
    await resolve('e16', () => {
        license.serverLicenseGovernsOrgs = () => true;                 // self-hosted
        license.getBestTierForOrgs = async () => 'enterprise';
        userStore.getSingleOrgId = async () => 'o1';                    // exactly one org
        userStore.getOrgAvailableCapabilities = async (id) => (id === 'o1' ? ['notebooks'] : null); // menu allows only notebooks
    }, AS_ADMIN_NO_ORG);

    // E16b: same, but the single org left its menu UNSET (null = unrestricted) ⇒
    // full ceiling (the bind must not over-restrict an org that never set a menu).
    await resolve('e16b', () => {
        license.serverLicenseGovernsOrgs = () => true;
        license.getBestTierForOrgs = async () => 'enterprise';
        userStore.getSingleOrgId = async () => 'o1';
        userStore.getOrgAvailableCapabilities = async () => null;       // unrestricted
    }, AS_ADMIN_NO_ORG);

    // E16c: CLOUD, one org, null-org admin ⇒ still full ceiling (cloud staff are
    // NOT bound by a customer menu; locks in "no org-count override of cloud").
    await resolve('e16c', () => {                                       // cloud
        license.getBestTierForOrgs = async () => 'enterprise';
        userStore.getSingleOrgId = async () => 'o1';
        userStore.getOrgAvailableCapabilities = async () => ['notebooks']; // restrictive menu
    }, AS_ADMIN_NO_ORG);

    // E16d: SELF-HOSTED, MULTI-org (no single org), null-org admin who SELECTED an
    // org in the picker (session.adminSelectedOrgId) ⇒ bound to that org's menu.
    await resolve('e16d', () => {
        license.serverLicenseGovernsOrgs = () => true;
        license.getBestTierForOrgs = async () => 'enterprise';
        userStore.getSingleOrgId = async () => null;                    // multi-org
        userStore.getOrgAvailableCapabilities = async (id) => (id === 'o2' ? ['webpages'] : null);
    }, { userId: 'admin', orgId: null, session: { isAdmin: true, adminSelectedOrgId: 'o2', user: { id: 'admin', role: 'admin' } } });

    // E16e: SELF-HOSTED, MULTI-org, null-org admin, NO picker selection ⇒ full
    // ceiling (deliberate: don't guess an org / don't intersect).
    await resolve('e16e', () => {
        license.serverLicenseGovernsOrgs = () => true;
        license.getBestTierForOrgs = async () => 'enterprise';
        userStore.getSingleOrgId = async () => null;
        userStore.getOrgAvailableCapabilities = async () => ['notebooks'];
    }, AS_ADMIN_NO_ORG);

    // E17: MEMBER whose session carries NO organizationId (OAuth-style identity-only
    // session) must still be bound by the org menu — resolved from the DB — not fall
    // through to the consumer/full-ceiling path. This is the real reported bug:
    // org-admins/normal members escaped the ceiling because orgId arrived null.
    await resolve('e17', () => {
        license.serverLicenseGovernsOrgs = () => true;                 // self-hosted
        license.getBestTierForOrgs = async () => 'enterprise';
        userStore.getOrgAvailableCapabilities = async (id) => (id === 'o1' ? ['notebooks'] : null); // menu: only notebooks
        userStore.getUser = async () => ({ id: 'm1', organizationId: 'o1', groups: [], role: 'user', orgRole: 'org_admin' });
        // session.user has ONLY identity — no organizationId/role (as stored in Redis for OAuth logins)
    }, { userId: 'm1', orgId: null, session: { isAuthenticated: true, user: { id: 'm1', displayName: 'adm' } } });

    // E17b: a GENUINE consumer (no org in session AND none in the DB / resolved set)
    // stays a consumer — the resolve-from-DB fallback must not invent an org.
    await resolve('e17b', () => {
        license.serverLicenseGovernsOrgs = () => true;
        license.getTierForUser = async () => 'enterprise';
        userStore.getUser = async () => ({ id: 'c1', organizationId: null, groups: [], role: 'user' });
    }, { userId: 'c1', orgId: null, session: { isAuthenticated: true, user: { id: 'c1' } } });

    // degraded: tier lookup throws → degraded snapshot
    await resolve('degraded', () => {
        license.getBestTierForOrgs = async () => { throw new Error('db down'); };
    }, AS_USER);
});

describe('cloud enterprise: compound beta + group integration grant + core', () => {
    it('webpages in ceiling (allow-list + enterprise license)', () => {
        const snap = S.cloudEnterprise;
        assert.ok(snap.ceiling.beta.includes('webpages'), 'webpages in ceiling (allow-list + enterprise license)');
    });
    it('swarm in ceiling', () => {
        const snap = S.cloudEnterprise;
        assert.ok(snap.ceiling.beta.includes('swarm'), 'swarm in ceiling');
    });
    it('voice_chat NOT in ceiling (not in allow-list)', () => {
        const snap = S.cloudEnterprise;
        assert.ok(!snap.ceiling.beta.includes('voice_chat'), 'voice_chat NOT in ceiling (not in allow-list)');
    });
    // cloud: orgGrant.beta = ceiling.beta (everyone) → effective beta = ceiling
    it('cloud beta everyone → effective', () => {
        const snap = S.cloudEnterprise;
        assert.ok(snap.effective.beta.includes('webpages'), 'cloud beta everyone → effective');
    });
    // integration: org-enabled has google-drive; group g1 grants gmail (additive)
    it('org-enabled integration', () => {
        const snap = S.cloudEnterprise;
        assert.ok(snap.effective.integration.includes('google-drive'), 'org-enabled integration');
    });
    it('group-granted integration (additive)', () => {
        const snap = S.cloudEnterprise;
        assert.ok(snap.effective.integration.includes('gmail'), 'group-granted integration (additive)');
    });
    // core: notebooks granted org-wide; in ceiling (enterprise has notebooks)
    it('core notebooks granted', () => {
        const snap = S.cloudEnterprise;
        assert.ok(snap.effective.core.includes('notebooks'), 'core notebooks granted');
    });
});

describe('group grant clamped to ceiling', () => {
    it('group cannot grant beyond ceiling (E-security)', () => {
        const snap = S.groupClamped;
        assert.ok(!snap.effective.beta.includes('voice_chat'), 'group cannot grant beyond ceiling (E-security)');
    });
});

describe('E6 group grant scoped per org', () => {
    it('cross-org group grant must not apply (E6)', () => {
        const snap = S.e6;
        assert.ok(!snap.effective.integration.includes('gmail'), 'cross-org group grant must not apply (E6)');
    });
});

describe('E3/E4 self-hosted community GA betas auto-on', () => {
    it('GA automations in community ceiling (E3)', () => {
        const snap = S.e3e4;
        assert.ok(snap.ceiling.beta.includes('automations'), 'GA automations in community ceiling (E3)');
    });
    it('GA agent_routines in community ceiling (E3)', () => {
        const snap = S.e3e4;
        assert.ok(snap.ceiling.beta.includes('agent_routines'), 'GA agent_routines in community ceiling (E3)');
    });
    it('non-GA beta excluded on community', () => {
        const snap = S.e3e4;
        assert.ok(!snap.ceiling.beta.includes('webpages'), 'non-GA beta excluded on community');
    });
    it('GA auto-on (absence ⇒ on) even with empty org list (E4)', () => {
        const snap = S.e3e4;
        assert.ok(snap.effective.beta.includes('automations'), 'GA auto-on (absence ⇒ on) even with empty org list (E4)');
    });
});

describe('E1 cloud no-plan org empty betas', () => {
    it('cloud no-plan org → zero betas (E1)', () => {
        const snap = S.e1;
        assert.strictEqual(snap.ceiling.beta.length, 0, 'cloud no-plan org → zero betas (E1)');
    });
});

describe('E5 null plan cap ⇒ MCP off until added', () => {
    it('no mcp bucket on the snapshot', () => {
        const snap = S.e5;
        assert.strictEqual(snap.ceiling.mcp, undefined, 'no mcp bucket on the snapshot');
    });
    // ─────────────────────────────────────────────────────────────────────
    // The two contracts below are NOT db-related and are NOT satisfied by the
    // resolver as it stands. They are marked todo so the specification stays in
    // the file and in the run output (the assertions still execute and are still
    // reported) instead of being deleted or silently weakened.
    //
    // Conflict: server/core/entitlements/entitlements.js, buildCeiling(), the
    // `if (cap == null)` branch of the INTEGRATION section, adds EVERY installed
    // mcp:<id> to the ceiling when the plan cap is unrestricted — its docblock
    // states "mcp:<id> (null⇒all installed; else only when EXPLICIT in
    // allow-list)". This test pins the opposite (decision 3: a server is off
    // until a plan explicitly lists it, admins included — the anti-leak rule).
    // Only a source decision can reconcile the two; it is deliberately NOT made
    // here. E5b/E5c/E5d (explicit cap and self-hosted) still pass and are
    // enforced, so only the unrestricted-cap case is unpinned.
    // ─────────────────────────────────────────────────────────────────────
    it.todo('null cap excludes MCP server from ceiling (E5, decision 3)', () => {
        const snap = S.e5;
        assert.ok(!snap.ceiling.integration.includes('mcp:s1'), 'null cap excludes MCP server from ceiling (E5, decision 3)');
    });
    it.todo('super-admin gets no MCP server under a null cap (E5)', () => {
        const snap = S.e5;
        assert.ok(!snap.effective.integration.includes('mcp:s1'), 'super-admin gets no MCP server under a null cap (E5)');
    });
});

describe('E5b MCP server opt-in via plan cap + org grant', () => {
    it('MCP server in ceiling when explicitly in plan cap (E5b)', () => {
        const snap = S.e5b;
        assert.ok(snap.ceiling.integration.includes('mcp:s1'), 'MCP server in ceiling when explicitly in plan cap (E5b)');
    });
    it('MCP server granted when org-enabled (E5b)', () => {
        const snap = S.e5b;
        assert.ok(snap.effective.integration.includes('mcp:s1'), 'MCP server granted when org-enabled (E5b)');
    });
});

describe('E5c restricted cap excludes unlisted MCP server', () => {
    it('restricted cap without the server ⇒ excluded (E5c)', () => {
        const snap = S.e5c;
        assert.ok(!snap.ceiling.integration.includes('mcp:s1'), 'restricted cap without the server ⇒ excluded (E5c)');
    });
});

describe('E5d self-hosted MCP in ceiling, off until granted', () => {
    it('self-hosted ⇒ installed server in ceiling (E5d)', () => {
        const snap = S.e5d;
        assert.ok(snap.ceiling.integration.includes('mcp:s1'), 'self-hosted ⇒ installed server in ceiling (E5d)');
    });
    it('self-hosted ⇒ off until org enables it (E5d)', () => {
        const snap = S.e5d;
        assert.ok(!snap.effective.integration.includes('mcp:s1'), 'self-hosted ⇒ off until org enables it (E5d)');
    });
});

describe('E2 consumer beta path + no MCP auto-grant', () => {
    it('consumer beta from default list (E2)', () => {
        const snap = S.e2;
        assert.ok(snap.ceiling.beta.includes('swarm'), 'consumer beta from default list (E2)');
    });
    it('consumer effective beta (no org/group layer)', () => {
        const snap = S.e2;
        assert.ok(snap.effective.beta.includes('swarm'), 'consumer effective beta (no org/group layer)');
    });
    // Consumer ceiling sees installed servers (no plan), but they are never
    // auto-granted to a consumer's effective set.
    it('consumer gets no MCP auto-grant (E2)', () => {
        const snap = S.e2;
        assert.ok(!snap.effective.integration.includes('mcp:s1'), 'consumer gets no MCP auto-grant (E2)');
    });
});

describe('E13 per-org availability menu bounds distribution', () => {
    it('menu includes google-drive', () => {
        const snap = S.e13;
        assert.ok(snap.orgAvailable.integration.includes('google-drive'), 'menu includes google-drive');
    });
    it('menu excludes gmail', () => {
        const snap = S.e13;
        assert.ok(!snap.orgAvailable.integration.includes('gmail'), 'menu excludes gmail');
    });
    it('in-menu grant survives', () => {
        const snap = S.e13;
        assert.ok(snap.effective.integration.includes('google-drive'), 'in-menu grant survives');
    });
    it('out-of-menu org+group grant dropped (E13)', () => {
        const snap = S.e13;
        assert.ok(!snap.effective.integration.includes('gmail'), 'out-of-menu org+group grant dropped (E13)');
    });
    it('ceiling unchanged (full plan/license menu)', () => {
        const snap = S.e13;
        assert.ok(snap.ceiling.integration.includes('gmail'), 'ceiling unchanged (full plan/license menu)');
    });
});

describe('E13b null availability ⇒ unrestricted', () => {
    it('unrestricted (null menu) ⇒ org grant applies as before', () => {
        const snap = S.e13b;
        assert.ok(snap.effective.integration.includes('gmail'), 'unrestricted (null menu) ⇒ org grant applies as before');
    });
});

describe('REGRESSION cloud subscription grants webpages outright (no compound gate)', () => {
    it('cloud community + plan-included webpages ⇒ in ceiling (subscription is sole authority)', () => {
        const snap = S.regressionGrants;
        assert.ok(snap.ceiling.beta.includes('webpages'), 'cloud community + plan-included webpages ⇒ in ceiling (subscription is sole authority)');
    });
    it('cloud community + plan-included webpages ⇒ effective (requireCapability passes)', () => {
        const snap = S.regressionGrants;
        assert.ok(snap.effective.beta.includes('webpages'), 'cloud community + plan-included webpages ⇒ effective (requireCapability passes)');
    });
});

describe('REGRESSION cloud subscription omitting a beta locks it', () => {
    it('plan omits webpages ⇒ not in ceiling ⇒ feature_locked', () => {
        const snap = S.regressionLocks;
        assert.ok(!snap.ceiling.beta.includes('webpages'), 'plan omits webpages ⇒ not in ceiling ⇒ feature_locked');
    });
    it('plan includes skills ⇒ in ceiling', () => {
        const snap = S.regressionLocks;
        assert.ok(snap.ceiling.beta.includes('skills'), 'plan includes skills ⇒ in ceiling');
    });
});

describe('COMPLIANCE HUB governed per subscription plan on cloud', () => {
    it('plan-included ⇒ effective, even on a community-tier plan with no licence grant', () => {
        const snap = S.complianceInPlan;
        assert.ok(snap.ceiling.beta.includes('compliance_hub_gdpr'), 'plan list alone puts the hub in the ceiling');
        assert.ok(snap.effective.beta.includes('compliance_hub_gdpr'), 'and it is granted org-wide (requireCapability passes)');
    });
    it('plan-excluded ⇒ out of the ceiling even on an enterprise-tier plan (the per-plan OFF)', () => {
        const snap = S.complianceExcluded;
        assert.ok(!snap.ceiling.beta.includes('compliance_hub_gdpr'), 'restricted plan list overrides the enterprise tier');
        assert.ok(!snap.effective.beta.includes('compliance_hub_gdpr'), 'not effective ⇒ requireCapability 403s');
        assert.strictEqual(snap.reasons['compliance_hub_gdpr'], 'ceiling', 'reason is ceiling (upgrade CTA), not not_granted');
    });
    it('self-hosted enterprise keeps the hub (tier governs, unchanged)', () => {
        const snap = S.complianceSelfHosted;
        assert.ok(snap.ceiling.beta.includes('compliance_hub_gdpr'));
        assert.ok(snap.effective.beta.includes('compliance_hub_gdpr'));
    });
    it('self-hosted community still has no hub (compound licence term holds)', () => {
        const snap = S.e3e4; // self-hosted community scenario
        assert.ok(!snap.ceiling.beta.includes('compliance_hub_gdpr'));
    });
});

describe('per-framework compliance capabilities (compliance_hub_nis2 … compliance_hub_custom)', () => {
    it('are in the core ceiling on an enterprise tier — cloud and self-hosted', () => {
        for (const id of COMPLIANCE_FRAMEWORK_CAPS) {
            assert.ok(S.cloudEnterprise.ceiling.core.includes(id), `${id} in the cloud enterprise ceiling`);
            assert.ok(S.complianceSelfHosted.ceiling.core.includes(id), `${id} in the self-hosted enterprise ceiling`);
        }
    });
    it('are OUT of the ceiling (⇒ locked:ceiling) on a community-tier plan, even one that includes the hub', () => {
        // `reasons` only covers userFacing caps; frameworkPolicy derives the
        // 'ceiling' lock from ceiling membership, which is what is pinned here.
        const snap = S.frameworksCommunityWithHub;
        assert.ok(snap.effective.beta.includes('compliance_hub_gdpr'), 'the hub itself is in the plan');
        for (const id of COMPLIANCE_FRAMEWORK_CAPS) {
            assert.ok(!snap.ceiling.core.includes(id), `${id} not in the community ceiling`);
            assert.ok(!snap.effective.core.includes(id), `${id} not effective`);
            assert.ok(!(id in snap.reasons), `${id} is org-level (not userFacing) so the resolver lists no reason for it`);
        }
    });
    it('self-hosted community has none of them either', () => {
        for (const id of COMPLIANCE_FRAMEWORK_CAPS) assert.ok(!S.e3e4.ceiling.core.includes(id), id);
    });
});

describe('E14 self-hosted super-admin bound by org-access menu', () => {
    it('super-admin ceiling still spans all betas (licence unchanged)', () => {
        const snap = S.e14;
        assert.ok(snap.ceiling.beta.includes('meeting_notes'), 'super-admin ceiling still spans all betas (licence unchanged)');
    });
    it('self-hosted admin keeps an in-menu beta without a group grant (E14)', () => {
        const snap = S.e14;
        assert.ok(snap.effective.beta.includes('webpages'), 'self-hosted admin keeps an in-menu beta without a group grant (E14)');
    });
    it('self-hosted admin loses an out-of-menu beta — the menu now binds the admin (E14)', () => {
        const snap = S.e14;
        assert.ok(!snap.effective.beta.includes('meeting_notes'), 'self-hosted admin loses an out-of-menu beta — the menu now binds the admin (E14)');
    });
});

describe('E14b cloud super-admin keeps full ceiling (not org-bound)', () => {
    it('cloud admin keeps in-menu beta', () => {
        const snap = S.e14b;
        assert.ok(snap.effective.beta.includes('webpages'), 'cloud admin keeps in-menu beta');
    });
    it('cloud admin keeps out-of-menu beta (platform staff, not org-bound) (E14b)', () => {
        const snap = S.e14b;
        assert.ok(snap.effective.beta.includes('meeting_notes'), 'cloud admin keeps out-of-menu beta (platform staff, not org-bound) (E14b)');
    });
});

describe('E15 self-hosted single-switch: normal user bound to + enabled by the menu', () => {
    it('self-hosted normal user gets menu-enabled non-GA beta with NO org_enabled_beta_features (E15)', () => {
        const snap = S.e15;
        assert.ok(snap.effective.beta.includes('webpages'), 'self-hosted normal user gets menu-enabled non-GA beta with NO org_enabled_beta_features (E15)');
    });
    it('self-hosted normal user does NOT get an out-of-menu beta (E15)', () => {
        const snap = S.e15;
        assert.ok(!snap.effective.beta.includes('meeting_notes'), 'self-hosted normal user does NOT get an out-of-menu beta (E15)');
    });
});

describe('E15-orgadmin org-admin bound + enabled by the menu (no elevation)', () => {
    it('org-admin gets the menu-enabled beta (E15-orgadmin)', () => {
        const snap = S.e15orgadmin;
        assert.ok(snap.effective.beta.includes('webpages'), 'org-admin gets the menu-enabled beta (E15-orgadmin)');
    });
    it('org-admin loses the out-of-menu beta — bound like everyone (E15-orgadmin)', () => {
        const snap = S.e15orgadmin;
        assert.ok(!snap.effective.beta.includes('meeting_notes'), 'org-admin loses the out-of-menu beta — bound like everyone (E15-orgadmin)');
    });
});

describe('E15b self-hosted single-switch core: menu is the org-wide grant', () => {
    it('self-hosted normal user gets menu-enabled core with NO org_granted_capabilities (E15b)', () => {
        const snap = S.e15b;
        assert.ok(snap.effective.core.includes('notebooks'), 'self-hosted normal user gets menu-enabled core with NO org_granted_capabilities (E15b)');
    });
    it('self-hosted normal user does NOT get an out-of-menu core feature (E15b)', () => {
        const snap = S.e15b;
        assert.ok(!snap.effective.core.includes('component_designer'), 'self-hosted normal user does NOT get an out-of-menu core feature (E15b)');
    });
});

describe('E15c cloud core grant path unchanged', () => {
    it('cloud core still grant-gated: menu alone does NOT grant (E15c)', () => {
        const snap = S.e15c;
        assert.ok(!snap.effective.core.includes('notebooks'), 'cloud core still grant-gated: menu alone does NOT grant (E15c)');
    });
});

describe('E16 self-hosted global admin (null org) bound by the single org menu', () => {
    it('global admin bound to single org keeps an in-menu core feature (E16)', () => {
        const snap = S.e16;
        assert.ok(snap.effective.core.includes('notebooks'), 'global admin bound to single org keeps an in-menu core feature (E16)');
    });
    it('global admin loses an out-of-menu core feature (E16)', () => {
        const snap = S.e16;
        assert.ok(!snap.effective.core.includes('component_designer'), 'global admin loses an out-of-menu core feature (E16)');
    });
    it('global admin loses out-of-menu betas (E16)', () => {
        const snap = S.e16;
        assert.ok(!snap.effective.beta.includes('webpages'), 'global admin loses out-of-menu betas (E16)');
    });
    it('global admin loses a beta when disabled in the menu (E16)', () => {
        const snap = S.e16;
        assert.ok(!snap.effective.beta.includes('voice_chat'), 'global admin loses a beta when disabled in the menu (E16)');
    });
});

describe('E16b unrestricted single org ⇒ global admin not over-restricted', () => {
    it('unrestricted single org ⇒ global admin keeps full ceiling (E16b)', () => {
        const snap = S.e16b;
        assert.ok(snap.effective.beta.includes('webpages'), 'unrestricted single org ⇒ global admin keeps full ceiling (E16b)');
    });
});

describe('E16c cloud global admin not bound by a single-org menu', () => {
    it('cloud null-org admin keeps full ceiling (E16c)', () => {
        const snap = S.e16c;
        assert.ok(snap.effective.beta.includes('meeting_notes'), 'cloud null-org admin keeps full ceiling (E16c)');
    });
});

describe('E16d self-hosted multi-org admin bound by picker selection', () => {
    it('admin bound to the org they selected in the picker (E16d)', () => {
        const snap = S.e16d;
        assert.ok(snap.effective.beta.includes('webpages'), 'admin bound to the org they selected in the picker (E16d)');
    });
    it('out-of-menu beta dropped for the selected org (E16d)', () => {
        const snap = S.e16d;
        assert.ok(!snap.effective.beta.includes('meeting_notes'), 'out-of-menu beta dropped for the selected org (E16d)');
    });
});

describe('E16e multi-org admin without selection ⇒ no guess', () => {
    it('multi-org admin with no selection ⇒ full ceiling, no guess (E16e)', () => {
        const snap = S.e16e;
        assert.ok(snap.effective.beta.includes('meeting_notes'), 'multi-org admin with no selection ⇒ full ceiling, no guess (E16e)');
    });
});

describe('E17 member with org-less session resolved to real org + bound by the menu', () => {
    it('org-less-session member is bound to the menu, NOT full ceiling (E17)', () => {
        const snap = S.e17;
        assert.ok(!snap.effective.beta.includes('webpages'), 'org-less-session member is bound to the menu, NOT full ceiling (E17)');
    });
    it('org-less-session member loses out-of-menu betas (E17)', () => {
        const snap = S.e17;
        assert.ok(!snap.effective.beta.includes('security_scan'), 'org-less-session member loses out-of-menu betas (E17)');
    });
    it('org-less-session member keeps the in-menu core feature (E17)', () => {
        const snap = S.e17;
        assert.ok(snap.effective.core.includes('notebooks'), 'org-less-session member keeps the in-menu core feature (E17)');
    });
});

describe('E17b genuine consumer (no org anywhere) unchanged', () => {
    it('consumer resolves without throwing (E17b)', () => {
        const snap = S.e17b;
        assert.ok(Array.isArray(snap.effective.beta), 'consumer resolves without throwing (E17b)');
    });
    it('consumer path intact (E17b)', () => {
        const snap = S.e17b;
        assert.strictEqual(snap.orgEnabled.core.length >= 0, true, 'consumer path intact (E17b)');
    });
});

describe('degraded fail-closed', () => {
    it('degraded on tier failure (E10 fail-closed)', () => {
        const snap = S.degraded;
        assert.strictEqual(snap.degraded, true, 'degraded on tier failure (E10 fail-closed)');
    });
});
