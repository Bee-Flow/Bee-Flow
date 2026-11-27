'use strict';
/**
 * Recorder for core/entitlements/capabilityProjection.characterisation.test.js: the capability
 * projection as the entitlement routes serialise it (auth/admin/featureAccessRoutes.js), for an
 * organisation admin and for a plain member of the same organisation, in a cloud and in a
 * self-hosted installation.
 *
 *   GET /auth/my-entitlements                      the snapshot and the registry dump, per person
 *   GET /auth/organizations/o1/group-access        the Access & Permissions matrix the admin edits
 *
 * The routes, the resolver, the capability registry, the licence tier math and the module layer
 * run for real. The database is a recording pool that answers no rows
 * (testUtils/routeHarness.js recordDb), the session gates only ask for a session (openGates),
 * and the data sources the resolver reads are fixed answers below, so the recording depends on
 * the code alone.
 *
 * Usage (the test runs it in a child process): node <this file> <out.json>
 * Which modules are present is up to the caller's environment (BEEFLOW_HIDE_MODULES, BEEFLOW_EDITION).
 */

process.env.NODE_ENV = 'test';

const fs = require('node:fs');
const h = require('../../testUtils/routeHarness');

h.recordDb();
h.openGates();

const license = require('../../license/index');
const betaFeatures = require('./betaFeatures');
const userStore = require('../../stores/userStore');
const planEnt = require('./planEntitlements');
const configStore = require('../../stores/configStore');
const mcpStore = require('../../stores/mcpStore');
const ent = require('./entitlements');

const ORG = 'o1';
const MEMBER = { id: 'member', role: 'user', organizationId: ORG, groups: ['g1'] };
const ORG_ADMIN = { id: 'orgadmin', role: 'user', orgRole: 'org_admin', organizationId: ORG, groups: ['g2'] };
const GROUPS = [
    { id: 'g1', name: 'Members', organizationId: ORG, granted_capabilities: ['gmail', 'nextcloud-mail', 'notebooks'] },
    { id: 'g2', name: 'Admins', organizationId: ORG, granted_capabilities: ['afas-profit', 'sanctions-lists', 'app_studio'] },
];

/**
 * The fixed answers of the resolver's data sources, for one installation mode.
 * @param {'cloud' | 'self-hosted'} mode
 */
function fixAnswers(mode) {
    license.serverLicenseGovernsOrgs = () => mode === 'self-hosted';
    license.getServerLicenseVersion = () => 0;
    license.getBestTierForOrgs = async () => 'enterprise';
    license.getTierForUser = async () => 'enterprise';
    license.getServerTier = () => 'enterprise';
    license.orgGrantsFeature = async () => false;
    betaFeatures.getEffectiveOrgBetaAllowList = async () => ['webpages', 'meeting_notes', 'ai_integration_builder', 'app_studio'];
    userStore.getUser = async (/** @type {string} */ id) => (id === ORG_ADMIN.id ? ORG_ADMIN : MEMBER);
    userStore.getAllGroups = async () => GROUPS;
    userStore.getOrgEnabledIntegrations = async () => ['google-drive', 'outlook', 'github', 'twoba'];
    userStore.getOrgEnabledBetaFeatures = async () => [];
    userStore.getOrgGrantedCapabilities = async () => ['notebooks', 'projects'];
    userStore.getOrgAvailableCapabilities = async () => null;
    userStore.getOrgBetaEveryone = async () => null;
    userStore.getOrgEveryoneRevoked = async () => null;
    userStore.getSingleOrgId = async () => null;
    userStore.getOrganization = async () => ({ id: ORG, enabledIntegrations: null });
    planEnt.getOrgCaps = async () => ({ integrations: null, betaFeatures: null });
    configStore.getConfig = async () => null;
    mcpStore.listServers = async () => [];
    ent._resetSingleOrgCache();
    ent.invalidateForOrg(ORG);
}

const router = require('../../auth/admin/featureAccessRoutes');
const api = h.serve('/auth', router, { user: null });

/**
 * @param {string} url
 * @param {Record<string, unknown>} user
 */
async function body(url, user) {
    const res = await api.call('GET', url, { user });
    if (res.status !== 200) throw new Error(`GET ${url} answered ${res.status}: ${res.text}`);
    return res.body;
}

async function record() {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const mode of /** @type {const} */ (['cloud', 'self-hosted'])) {
        fixAnswers(mode);
        out[mode] = {
            orgAdmin: await body('/auth/my-entitlements', ORG_ADMIN),
            member: await body('/auth/my-entitlements', MEMBER),
            orgAdminMatrix: await body(`/auth/organizations/${ORG}/group-access`, ORG_ADMIN),
        };
    }
    return out;
}

record().then(async (out) => {
    fs.writeFileSync(process.argv[2], JSON.stringify(out));
    await api.close();
    process.exit(0);
}, (err) => {
    process.stderr.write(`${err && err.stack ? err.stack : err}\n`);
    process.exit(1);
});
