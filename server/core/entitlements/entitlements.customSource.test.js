/**
 * Which licence admits an org-scoped custom integration ('custom:<uuid>') to
 * the integration ceiling (entitlements.js buildCeiling, `_customSource` from
 * capabilityRegistry.listCustomIntegrationCapabilities):
 *
 *   - MCP-library rows (_customSource 'mcp_library') iff the org may use the
 *     MCP marketplace: the tier has 'mcp_marketplace', or the plan grants it
 *     (license.orgGrantsFeature). Asked at most once per resolve.
 *   - builder rows (anything else, including a descriptor without the field)
 *     iff the ceiling holds the 'ai_integration_builder' beta, as before.
 *
 * No module mocking. The database is cut at core/http/routeHarness's db.pool
 * seam (queries are recorded, never sent), and the resolver's data sources are
 * swapped as functions on their module objects with testUtils/swaps, the same
 * sources entitlements.test.js controls. `tierHint` fixes the tier so no
 * licence lookup is needed.
 *
 * Run: cd server && node --test core/entitlements/entitlements.customSource.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');

const h = require('../http/routeHarness');
const db = h.recordDb();
const { makeSwaps } = require('../../testUtils/swaps');

const license = require('../../license/index');
const registry = require('./capabilityRegistry');
const betaFeatures = require('./betaFeatures');
const userStore = require('../../stores/userStore');
const planEnt = require('../../services/planEntitlements');
const configStore = require('../../stores/configStore');
const mcpStore = require('../../stores/mcpStore');
const ent = require('./entitlements');

const ORG = 'o1';
const LIB_A = 'custom:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const LIB_B = 'custom:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const BUILT = 'custom:cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const LEGACY = 'custom:dddddddd-dddd-4ddd-8ddd-dddddddddddd'; // a descriptor without _customSource

const custom = (id, source) => ({
    id, kind: 'integration', name: id, _custom: true, _customOrgId: ORG,
    ...(source ? { _customSource: source } : {}),
});

const swaps = makeSwaps();
const fx = {};

function baseline() {
    fx.selfHosted = true;
    fx.marketplaceGrant = false;  // license.orgGrantsFeature(..., 'mcp_marketplace')
    fx.grantFails = false;
    fx.grantAsks = [];
    fx.planBetas = [];            // cloud: the plan's beta allow-list
    fx.customs = [custom(LIB_A, 'mcp_library'), custom(LIB_B, 'mcp_library'), custom(BUILT, 'builder'), custom(LEGACY, null)];
    fx.customAsks = [];
}

before(async () => {
    await db.settle();
    swaps.swap(license, 'serverLicenseGovernsOrgs', () => fx.selfHosted);
    swaps.swap(license, 'getServerLicenseVersion', () => 0);
    swaps.swap(license, 'orgGrantsFeature', async (orgIds, feature) => {
        if (feature !== 'mcp_marketplace') return false;
        fx.grantAsks.push([...orgIds]);
        if (fx.grantFails) throw new Error('licence lookup down');
        return fx.marketplaceGrant;
    });
    swaps.swap(registry, 'refreshMcpIntegrationDescriptors', async () => {});
    swaps.swap(registry, 'refreshModuleCapabilityFilter', async () => {});
    swaps.swap(registry, 'listCustomIntegrationCapabilities', async (orgId) => {
        fx.customAsks.push(orgId);
        return orgId === ORG ? fx.customs : [];
    });
    swaps.swap(betaFeatures, 'getEffectiveOrgBetaAllowList', async () => [...fx.planBetas]);
    swaps.swap(userStore, 'getUser', async () => null);
    swaps.swap(userStore, 'getAllGroups', async () => []);
    swaps.swap(userStore, 'getOrgEnabledIntegrations', async () => []);
    swaps.swap(userStore, 'getOrgEnabledBetaFeatures', async () => []);
    swaps.swap(userStore, 'getOrgGrantedCapabilities', async () => []);
    swaps.swap(userStore, 'getOrgAvailableCapabilities', async () => null);
    swaps.swap(userStore, 'getOrgBetaEveryone', async () => null);
    swaps.swap(userStore, 'getOrgEveryoneRevoked', async () => null);
    swaps.swap(userStore, 'getSingleOrgId', async () => null);
    swaps.swap(userStore, 'getOrganization', async () => ({ enabledIntegrations: null }));
    swaps.swap(planEnt, 'getOrgCaps', async () => ({ integrations: null, betaFeatures: null }));
    swaps.swap(configStore, 'getConfig', async () => null);
    swaps.swap(mcpStore, 'listServers', async () => []);
});
after(() => swaps.restore());
beforeEach(baseline);

async function ceilingFor({ tier, orgId = ORG }) {
    const snap = await ent.resolveEntitlements({ userId: null, orgId, tierHint: tier });
    assert.strictEqual(snap.degraded, false);
    return new Set(snap.ceiling.integration);
}

describe('custom integrations in the integration ceiling', () => {
    it('community, no marketplace grant: neither family enters', async () => {
        const ceil = await ceilingFor({ tier: 'community' });
        for (const id of [LIB_A, LIB_B, BUILT, LEGACY]) assert.ok(!ceil.has(id), id);
    });

    it('community with the marketplace granted by the plan: library rows enter, builder rows do not', async () => {
        fx.marketplaceGrant = true;
        const ceil = await ceilingFor({ tier: 'community' });
        assert.ok(ceil.has(LIB_A) && ceil.has(LIB_B));
        assert.ok(!ceil.has(BUILT), 'the builder still needs its own beta');
        assert.ok(!ceil.has(LEGACY), 'a descriptor without a source is a builder row');
    });

    it('the marketplace grant is asked once per resolve, for this org', async () => {
        fx.marketplaceGrant = true;
        await ceilingFor({ tier: 'community' });
        assert.deepStrictEqual(fx.grantAsks, [[ORG]]);
    });

    it('a licence lookup that fails admits no library row (fail closed)', async () => {
        fx.grantFails = true;
        const ceil = await ceilingFor({ tier: 'community' });
        assert.ok(!ceil.has(LIB_A) && !ceil.has(LIB_B));
    });

    it('enterprise (marketplace in the tier, every beta self-hosted): both families enter, no plan lookup needed', async () => {
        const ceil = await ceilingFor({ tier: 'enterprise' });
        for (const id of [LIB_A, LIB_B, BUILT, LEGACY]) assert.ok(ceil.has(id), id);
        assert.deepStrictEqual(fx.grantAsks, [], 'the tier answers; the plan is not asked');
    });

    it('cloud, a plan with the builder beta but no marketplace: builder rows enter, library rows do not', async () => {
        fx.selfHosted = false;
        fx.planBetas = ['ai_integration_builder'];
        const ceil = await ceilingFor({ tier: 'community' });
        assert.ok(ceil.has(BUILT) && ceil.has(LEGACY));
        assert.ok(!ceil.has(LIB_A) && !ceil.has(LIB_B));
    });

    it('cloud, the marketplace granted but not the builder beta: only library rows', async () => {
        fx.selfHosted = false;
        fx.marketplaceGrant = true;
        const ceil = await ceilingFor({ tier: 'community' });
        assert.ok(ceil.has(LIB_A) && ceil.has(LIB_B));
        assert.ok(!ceil.has(BUILT) && !ceil.has(LEGACY));
    });

    it('a resolve without an organisation never consults the customs', async () => {
        fx.marketplaceGrant = true;
        const ceil = await ceilingFor({ tier: 'enterprise', orgId: null });
        assert.deepStrictEqual(fx.customAsks, []);
        assert.ok(![...ceil].some(id => id.startsWith('custom:')));
    });

    it('nothing in this resolution reached the database', () => {
        assert.deepStrictEqual(db.queries, []);
    });
});
