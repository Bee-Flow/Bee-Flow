'use strict';
/**
 * Is a web search provider set up on this installation?
 *
 * The one answer getIntegrationTools (direct chat, agents) and the Automation
 * Builder's own chat both read, so a surface can never offer agent_search where
 * the main chat would not, or the other way round. It answers only the
 * installation question; whether THIS user may use the web-search app is the
 * entitlement gate (isAppOn / isIntegrationPermittedForUser) on top of it.
 *
 * When the provider is agent-search but the GPU service URL is gone (a typical
 * CPU-only deploy), a Serper key still gives a working search through
 * node-search; executeWebSearch takes that same fallback at run time.
 */

function defaultDeps() {
    return { configStore: require('../stores/configStore'), env: process.env };
}

/**
 * @returns {Promise<{ available: boolean, provider: string, fallbackToNode: boolean }>}
 */
async function webSearchProviderStatus(deps = defaultDeps()) {
    const { configStore, env } = deps;
    const hasAgentSearchUrl = !!env.SEARCH_SERVICE_URL || !!(await configStore.getConfig('agent_search_url'));
    const provider = await configStore.getConfig('search_provider') || 'agent-search';
    const hasBingSearchKey = !!(await configStore.getSecret('bing_search_key'));
    const hasSerperKey = !!(await configStore.getSecret('serper_api_key'));
    const fallbackToNode = provider === 'agent-search' && !hasAgentSearchUrl && hasSerperKey;
    const available = provider !== 'disabled' && (
        (provider === 'bing' && hasBingSearchKey)
        || (provider === 'node-search' && hasSerperKey)
        || (provider === 'agent-search' && hasAgentSearchUrl)
        || fallbackToNode
    );
    return { available, provider, fallbackToNode };
}

module.exports = { webSearchProviderStatus };
