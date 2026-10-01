/**
 * Azure OpenAI v1 GA base URL. Lives on its own (no imports) so the embedding
 * paths (core/embed/dispatch.js, stores/memoryStore.js) can build the same URL
 * as the chat adapter (azure.js) without loading the whole OpenAI provider.
 *
 * `https://res.openai.azure.com`, `…/`, `…/openai`, `…/openai/v1/` and a
 * pasted `…/openai/deployments/x/chat/completions?api-version=…` all become
 * `https://res.openai.azure.com/openai/v1`. v1 takes no `api-version`; the
 * deployment name goes in the request body as `model`.
 *
 * @param {string} endpoint
 * @returns {string}
 */
function toV1BaseUrl(endpoint) {
    const url = new URL(String(endpoint).trim());
    const path = url.pathname.replace(/\/openai(\/.*)?$/i, '').replace(/\/+$/, '');
    return `${url.origin}${path}/openai/v1`;
}

module.exports = { toV1BaseUrl };
