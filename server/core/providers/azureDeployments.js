// @typecheck
/**
 * Azure deployment → model registry.
 *
 * On Azure the "model" in a request is a deployment name the admin chose
 * (`prod-chat`), and nothing in that name says which model runs behind it. The
 * deployment list therefore accepts `name=model` (`prod-chat=gpt-6-astra,
 * gpt-4.1`), and this registry is how code far from the provider record —
 * pricing, the context window, the reasoning defaults — gets from one to the
 * other. Same pattern as the local, Scaleway and EU-served registries.
 *
 * Filled from the `azure_models` config by the Azure adapter and on every
 * Azure model resolution (modelCache), so it is current before the first
 * request of a process as well as after an admin edits the list.
 */

const log = require('../../telemetry/log');

/** deployment name → model id, only for deployments NOT named after their model. */
let _models = new Map();

/** Reads the raw `azure_models` value. Swappable for tests via configureAzureDeployments. */
let _readDeploymentList = async () => require('../../stores/configStore').getConfig('azure_models');

/**
 * Injection seam: replace where the deployment list is read from.
 * @param {{ readDeploymentList?: () => Promise<unknown> }} [seams]
 */
function configureAzureDeployments({ readDeploymentList } = {}) {
    if (typeof readDeploymentList === 'function') _readDeploymentList = readDeploymentList;
}

/**
 * Parse the admin's deployment list. `prod-chat=gpt-5.6-sol, gpt-4.1` →
 * [{ deployment:'prod-chat', model:'gpt-5.6-sol' }, { deployment:'gpt-4.1', model:'gpt-4.1' }].
 */
function parseDeployments(raw) {
    return String(raw || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
        .map(entry => {
            const eq = entry.indexOf('=');
            if (eq < 0) return { deployment: entry, model: entry };
            const deployment = entry.slice(0, eq).trim();
            const model = entry.slice(eq + 1).trim();
            return { deployment, model: model || deployment };
        })
        .filter(d => d.deployment);
}

function setAzureDeployments(list) {
    _models = new Map((list || []).filter(d => d.model !== d.deployment).map(d => [d.deployment, d.model]));
}

/**
 * Re-read the deployment list from config. Returns the parsed list, or null
 * when config could not be read (the registry then keeps what it had).
 */
async function refreshAzureDeployments() {
    try {
        const list = parseDeployments(await _readDeploymentList());
        setAzureDeployments(list);
        return list;
    } catch (e) {
        log.warn('[Azure] Could not read the deployment list:', e.message);
        return null;
    }
}

/**
 * The model behind an Azure deployment, or the id itself when it is not a
 * mapped deployment. Accepts an `azure/` routing prefix.
 */
function azureModelFor(id) {
    if (typeof id !== 'string' || _models.size === 0) return id;
    return _models.get(id) || _models.get(id.replace(/^azure\//i, '')) || id;
}

module.exports = { parseDeployments, setAzureDeployments, refreshAzureDeployments, azureModelFor, configureAzureDeployments };
