// @typecheck strict
/**
 * Does this instance embed knowledge locally (and so with the configured
 * model), or through the search service? Pure configuration reads, so the
 * embedding migration, the embed step and the helpers can all ask without
 * requiring each other (import cycle).
 */

'use strict';

const configStore = require('../../stores/configStore');

/**
 * Read Azure embedding credentials from configStore.
 * Returns { use_azure, azure_endpoint?, azure_key?, azure_model? }
 */
async function getAzureIngestParams() {
    const useAzure = !!(await configStore.getConfig('use_azure_doc_processing'));
    if (!useAzure) return { use_azure: false };
    return {
        use_azure: true,
        azure_endpoint: await configStore.getConfig('azure_openai_embedding_endpoint') || '',
        azure_key: await configStore.getSecret('azure_openai_embedding_key') || '',
        azure_model: await configStore.getConfig('azure_openai_embedding_model') || 'text-embedding-3-small',
    };
}

/**
 * Local ingestion embeds with the configured model; the search service uses its own.
 * @param {{ use_azure?: boolean }} azureParams
 * @param {string | null | undefined} kbProvider
 */
const isLocalIngest = (azureParams, kbProvider) => !!azureParams.use_azure || kbProvider === 'local';

/** Does this instance embed knowledge locally (and so with the configured model)? */
async function usesLocalIngest() {
    const { resolveKbProvider } = require('./resolveProvider');
    return isLocalIngest(await getAzureIngestParams(), await resolveKbProvider());
}

module.exports = { getAzureIngestParams, isLocalIngest, usesLocalIngest };
