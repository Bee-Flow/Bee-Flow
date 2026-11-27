// @typecheck strict
'use strict';

/**
 * The world of the integration availability tests (orgIntegrationAvailability.test.js and its
 * module half, orgIntegrationAvailability.int_saas.test.js): real stores over PGlite
 * (testUtils/pglitePool.js), the organisations a test file names, and `deps`, the injected
 * collaborators with everything configured and on.
 *
 * Require it before anything else of the server: it sets the environment the stores read when
 * they load.
 */

const { before, after } = require('node:test');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'avail-test-session-secret-0123456789abcdef';
process.env.MASTER_ENCRYPTION_KEY = process.env.MASTER_ENCRYPTION_KEY || 'avail-test-master-key-0123456789abcdef0123456789';

const { usePglitePool } = require('../../testUtils/pglitePool');

const ORG_PLAIN = 'org-avail-plain';
const ORG_NC = 'org-avail-nc';
const ORG_NAME = 'Availability Test Organisation';
const AZURE_TENANT = '11111111-2222-4333-8444-555555555555';

/** The per-user families: nothing to set up on the server, a key per person. */
const PER_USER = ['fireflies', 'nmbrs', 'afas-profit', 'frappe-crm', 'firebird', 'vplan', 'signrequest', 'youtrack', 'gamma'];

/** @typedef {{ core: string[], beta: string[], integration: string[] }} CapabilityLists */

/** @type {CapabilityLists} */
const ALL_CAPS = {
    core: ['projects'],
    // mcp_marketplace is a licence string, never a capability row: the real resolver never lists it.
    beta: ['meeting_notes', 'learning_center', 'automations'],
    integration: [
        'gmail', 'google-calendar', 'google-drive', 'outlook', 'ms-calendar', 'github', 'n8n', 'maps', 'image-gen',
        'linkedin', 'withings', 'transcription', ...PER_USER,
    ],
};

/**
 * An entitlement snapshot with this ceiling.
 * @param {CapabilityLists} ceiling
 * @param {CapabilityLists} [orgAvailable]
 */
const snapOf = (ceiling, orgAvailable = ceiling) => async () => ({ mode: 'cloud', ceiling, orgAvailable, orgEnabled: { core: [], beta: [], integration: [] } });

const SSO_BOTH = { providers: { google: { clientId: 'g-id', clientSecret: 'g-secret' }, microsoft: { clientId: 'm-id', clientSecret: 'm-secret', tenantId: AZURE_TENANT } } };

/**
 * Everything configured and on; a test overrides what it is about.
 * @param {Record<string, unknown>} [over]
 */
function deps(over = {}) {
    return {
        loadAuthConfig: async () => SSO_BOTH,
        imageGenerationAvailable: async () => true,
        webSearchAvailable: async () => true,
        isModuleActive: async () => true,
        hasLicenseFeature: async () => true,
        snapshot: snapOf(ALL_CAPS),
        env: {},
        ...over,
    };
}

/** @typedef {{ userStore: typeof import('../../stores/userStore'), configStore: typeof import('../../stores/configStore') }} AvailabilityStores */

/**
 * createOrganization pre-generates each org's webhook signing key in a
 * setImmediate; let those writes land before the database closes.
 * @param {AvailabilityStores['configStore']} configStore
 * @param {string[]} ids
 */
async function settleOrgBackgroundWork(configStore, ids) {
    for (let i = 0; i < 100; i++) {
        const keys = await Promise.all(ids.map(id => configStore.getSecretFresh(`org_webhook_signing_key_${id}`)));
        if (keys.every(Boolean)) return;
        await new Promise(resolve => setImmediate(resolve));
    }
}

/**
 * PGlite with the user store initialised and the organisations `ids` created (before), the
 * database closed once their background writes landed (after). `seed` writes what the file needs.
 * @param {string[]} ids
 * @param {(stores: AvailabilityStores) => Promise<void>} seed
 */
function useAvailabilityWorld(ids, seed) {
    const { close } = usePglitePool();
    /** @type {AvailabilityStores['configStore'] | null} */
    let configStore = null;
    before(async () => {
        const userStore = require('../../stores/userStore');
        configStore = require('../../stores/configStore');
        await userStore.initDB();
        for (const id of ids) await userStore.createOrganization({ id, name: ORG_NAME, email: 'office@avail.test' }, { autoGrantTrial: false });
        await seed({ userStore, configStore });
    }, { timeout: 120_000 });
    after(async () => {
        if (configStore) await settleOrgBackgroundWork(configStore, ids);
        await close();
    });
}

module.exports = { ORG_PLAIN, ORG_NC, ORG_NAME, AZURE_TENANT, PER_USER, ALL_CAPS, snapOf, SSO_BOTH, deps, useAvailabilityWorld };
