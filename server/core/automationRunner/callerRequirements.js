// @typecheck
const { fallback } = require('../../utils/bestEffort');

/** Providers whose connection is a per-user OAuth / vault entry. */
const PERSONAL_PROVIDERS = Object.freeze(['google', 'microsoft', 'nextcloud', 'withings']);

const MAX_BLOCK_DEPTH = 20;

/** Step types that write somewhere the owner controls, and what the notice calls the place. */
const DESTINATION_OF_STEP = Object.freeze({
    knowledge_write: 'knowledge_base',
    datatable: 'tables',
    generate_document: 'generated_files',
    fill_document: 'generated_files',
    presentation: 'generated_files',
});

/**
 * What the flow needs from the person it runs as: per-user providers named by
 * integration steps (root, flowlets, nested bodies, published Steps called by
 * `call_block`), the providers of an agent behind an AI step, the saved HTTP
 * credentials, and whether any step dispatches tools at all.
 *
 * @param {any} definition
 * @param {{ providerForTool: (t: string) => string|null,
 *           loadBlockDefinition?: (id: string) => Promise<any|null>,
 *           stepProviders?: (aiStep: any) => Promise<string[]> }} lookups
 * @returns {Promise<{ providers: string[], httpConnections: Array<{stepId: string, connectionId: string}>, usesTools: boolean, destinations: string[] }>}
 */
async function collectRequirements(definition, lookups) {
    const providers = new Set();
    const destinations = new Set();
    const httpConnections = [];
    let usesTools = false;
    const seen = new Set();
    const blocks = new Set();
    const queue = [definition];
    while (queue.length) {
        const node = queue.pop();
        if (!node || typeof node !== 'object' || seen.has(node)) continue;
        seen.add(node);
        if (Array.isArray(node)) { queue.push(...node); continue; }
        // Places the OWNER controls and can read back: named in the one-time notice.
        const sink = DESTINATION_OF_STEP[node.type];
        if (sink) destinations.add(sink);
        if ((node.type === 'fill_document' || node.type === 'presentation') && node.saveCopy) destinations.add('document_library');
        if (node.type === 'http_request' && node.cacheInto && node.cacheInto.datatableId) destinations.add('tables');
        if (node.type === 'integration_action' && typeof node.tool === 'string') {
            usesTools = true;
            /** @type {string | null} */
            let provider = null;
            try { provider = lookups.providerForTool(node.tool); } catch (_) { provider = null; }
            if (provider && PERSONAL_PROVIDERS.includes(provider)) providers.add(provider);
        }
        if (node.type === 'ai_step' && (node.allowTools || node.agentId || Array.isArray(node.tools))) usesTools = true;
        if (Array.isArray(node.allowedTools) && node.allowedTools.length) usesTools = true;
        // The apps an AI step is granted: the agent behind it and its skills.
        if (node.type === 'ai_step' && lookups.stepProviders && (node.agentId || (Array.isArray(node.skillIds) && node.skillIds.length))) {
            for (const p of await lookups.stepProviders(node).catch((e) => fallback('core/automationRunner/callerConnections:collectRequirements', e, []))) {
                if (PERSONAL_PROVIDERS.includes(p)) providers.add(p);
            }
        }
        if (node.type === 'http_request' && node.auth && typeof node.auth.connectionId === 'string' && node.auth.connectionId) {
            httpConnections.push({ stepId: String(node.id || ''), connectionId: node.auth.connectionId });
        }
        if (node.type === 'call_block' && typeof node.blockId === 'string' && lookups.loadBlockDefinition
            && !blocks.has(node.blockId) && blocks.size < MAX_BLOCK_DEPTH) {
            blocks.add(node.blockId);
            const def = await lookups.loadBlockDefinition(node.blockId).catch((e) => fallback('core/automationRunner/callerConnections:collectRequirements#2', e, null));
            if (def) queue.push(def);
        }
        queue.push(...Object.values(node));
    }
    return { providers: [...providers], httpConnections, usesTools, destinations: [...destinations].sort() };
}

module.exports = { PERSONAL_PROVIDERS, collectRequirements };
