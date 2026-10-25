// @typecheck noImplicitAny
/**
 * Agentic AI bridge (POST /:id/ai/ask, see ./webpagesPreviewAsk.js): the tool
 * surface built from the page's `bridge_grants`, and the clamp on what a tool
 * result may put into the prompt. Split out of routes/webpagesPreview.js;
 * behaviour unchanged.
 */

const { findOwnerOfTool, loadTools } = require('../automation/toolRegistry');

// Soft cap to keep tool results from blowing up the prompt. Arrays/strings
// above these sizes are truncated with a count indicator; the page still gets
// the full result via the SSE `tool_result` event.
const MAX_TOOL_RESULT_ARRAY_ITEMS = 20;
const MAX_TOOL_RESULT_STRING_LEN = 4000;
/** @param {unknown} result */
function compactToolResultForLLM(result) {
    if (result == null) return result;
    if (typeof result === 'string') {
        return result.length > MAX_TOOL_RESULT_STRING_LEN
            ? `${result.slice(0, MAX_TOOL_RESULT_STRING_LEN)}\n…[truncated ${result.length - MAX_TOOL_RESULT_STRING_LEN} chars]`
            : result;
    }
    if (Array.isArray(result)) {
        if (result.length > MAX_TOOL_RESULT_ARRAY_ITEMS) {
            return { _truncated: true, totalItems: result.length, items: result.slice(0, MAX_TOOL_RESULT_ARRAY_ITEMS) };
        }
        return result;
    }
    if (typeof result === 'object') {
        /** @type {Record<string, unknown>} */
        const out = {};
        for (const [k, v] of Object.entries(result)) {
            if (Array.isArray(v) && v.length > MAX_TOOL_RESULT_ARRAY_ITEMS) {
                out[k] = v.slice(0, MAX_TOOL_RESULT_ARRAY_ITEMS);
                out[`${k}_truncated`] = { totalItems: v.length, shown: MAX_TOOL_RESULT_ARRAY_ITEMS };
            } else if (typeof v === 'string' && v.length > MAX_TOOL_RESULT_STRING_LEN) {
                out[k] = `${v.slice(0, MAX_TOOL_RESULT_STRING_LEN)}…[truncated]`;
            } else {
                out[k] = v;
            }
        }
        return out;
    }
    return result;
}

const automationToolName = (/** @type {string} */ automationId) => `automation_${automationId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;

/**
 * @param {import('../stores/webpage/bridgeGrants').IntegrationGrant} grant
 */
function integrationToolDef(grant) {
    const owner = findOwnerOfTool(grant.tool);
    if (!owner) return null;
    const def = loadTools(owner).find(t => t?.function?.name === grant.tool);
    if (!def) return null;
    // Hide pinned fields from the model — the server merges them in.
    const params = def.function.parameters || { type: 'object', properties: {} };
    let trimmedParams = params;
    if (grant.fixedArgs && typeof grant.fixedArgs === 'object' && params.properties) {
        const props = { ...params.properties };
        for (const key of Object.keys(grant.fixedArgs)) delete props[key];
        trimmedParams = {
            ...params,
            properties: props,
            required: Array.isArray(params.required)
                ? params.required.filter((/** @type {string} */ k) => !(k in grant.fixedArgs))
                : params.required,
        };
    }
    return {
        type: 'function',
        function: {
            name: def.function.name,
            description: def.function.description || '',
            parameters: trimmedParams,
        },
    };
}

/**
 * @param {{ bridgeGrants: import('../stores/webpage/bridgeGrants').BridgeGrants, webpage: { knowledgeBaseIds?: unknown } }} ctx
 */
function buildAskToolSurface(ctx) {
    const tools = [];
    const integrationGrantByTool = new Map();
    const automationGrantById = new Map();

    for (const grant of (ctx.bridgeGrants.integrations || [])) {
        const def = integrationToolDef(grant);
        if (!def) continue;
        integrationGrantByTool.set(grant.tool, grant);
        tools.push(def);
    }

    for (const grant of (ctx.bridgeGrants.automations || [])) {
        automationGrantById.set(grant.automationId, grant);
        tools.push({
            type: 'function',
            function: {
                name: automationToolName(grant.automationId),
                description: `Run the author's automation "${grant.label || grant.automationId}". Returns the automation's final output.`,
                parameters: {
                    type: 'object',
                    properties: {
                        inputs: { type: 'object', description: 'Input values for the automation.' },
                    },
                },
            },
        });
    }

    const kbIds = Array.isArray(ctx.webpage.knowledgeBaseIds) ? ctx.webpage.knowledgeBaseIds : [];
    const groundEnabled = !!ctx.bridgeGrants.ai.groundOnPage && kbIds.length > 0;
    if (groundEnabled) {
        tools.push({
            type: 'function',
            function: {
                name: 'page_knowledge_search',
                description: `Search the webpage's own knowledge base (uploaded sources, attached KBs). Use this first when the user asks about page-specific content.`,
                parameters: {
                    type: 'object',
                    properties: {
                        query: { type: 'string', description: 'What to search for.' },
                        topK: { type: 'integer', description: 'Max chunks to return (default 6).' },
                    },
                    required: ['query'],
                },
            },
        });
    }

    return { tools, integrationGrantByTool, automationGrantById, groundEnabled, kbIds };
}

module.exports = { compactToolResultForLLM, buildAskToolSurface, automationToolName };
