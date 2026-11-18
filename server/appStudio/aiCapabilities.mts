/**
 * What the AI of an app can reach on THIS installation, for the owner's "What the AI can do" panel
 * in App settings.
 *
 * Only the run-time facts the editor cannot see itself: whether the workspace allows the owner's
 * Web Search and Browse Web integrations, whether a search provider is configured and whether a
 * browser can be started. The app's own switches (aiWebSearch, aiBrowsing) and which steps use what
 * are in the definition the editor already holds. Every answer is a boolean: no provider name, no
 * address, no key.
 *
 * The checks are the ones the steps make when they run (aiWebSearch.mts, browseStep.js), so the
 * panel cannot say "available" where the step would refuse.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
type FeatureModuleFn = typeof import('../core/featureModules.js').featureModule;
/** Another feature's module, looked up by name (core/featureModules.js) when it is needed. */
const featureModule: FeatureModuleFn = (name) => (nodeRequire('../core/featureModules') as { featureModule: FeatureModuleFn }).featureModule(name);

export type AiCapabilities = {
    webSearch: { integrationAllowed: boolean; providerAvailable: boolean };
    browsing: { integrationAllowed: boolean; backendAvailable: boolean };
};

export type CapabilityDeps = {
    isPermitted: (userId: string, integration: 'agent-search' | 'browser-fetch') => Promise<boolean>;
    searchProviderAvailable: () => Promise<boolean>;
    browserBackendAvailable: () => Promise<boolean>;
};

function defaultDeps(): CapabilityDeps {
    return {
        isPermitted: (userId, appId) => (nodeRequire('../core/integrations/integrationTools') as { isIntegrationPermittedForUser: (a: { userId: string; appId: string }) => Promise<boolean> })
            .isIntegrationPermittedForUser({ userId, appId }),
        // Another feature's modules, looked up by name (core/featureModules.js).
        searchProviderAvailable: async () => (await featureModule('integrations/webSearchAvailability').webSearchProviderStatus()).available,
        browserBackendAvailable: async () => !!process.env.BROWSER_WS_ENDPOINT || !!(await featureModule('services/pwtRunner').dockerAvailable()),
    };
}

/** A check that throws answers false: the panel then says "not available", which is what the step would find. */
async function safely(check: () => Promise<boolean>): Promise<boolean> {
    try { return (await check()) === true; } catch { return false; }
}

/** The run-time facts for an app, resolved for its OWNER (every AI step acts as the owner). */
export async function aiCapabilitiesFor(app: { userId: string }, deps: CapabilityDeps = defaultDeps()): Promise<AiCapabilities> {
    const [searchAllowed, searchProvider, browseAllowed, browseBackend] = await Promise.all([
        safely(() => deps.isPermitted(app.userId, 'agent-search')),
        safely(() => deps.searchProviderAvailable()),
        safely(() => deps.isPermitted(app.userId, 'browser-fetch')),
        safely(() => deps.browserBackendAvailable()),
    ]);
    return {
        webSearch: { integrationAllowed: searchAllowed, providerAvailable: searchProvider },
        browsing: { integrationAllowed: browseAllowed, backendAvailable: browseBackend },
    };
}
