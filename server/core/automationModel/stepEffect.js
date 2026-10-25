// @typecheck
'use strict';
/**
 * The effect of a workflow STEP (the step-level companion of sideEffectMap.js,
 * which classifies tool names). Pure.
 */

const { effectOf, maxEffect } = require('./sideEffectMap');

/**
 * The strongest effect a STEP can have when it executes (`reads` | `writes` |
 * `sends`), decided from its type and fields, never from a run.
 *
 * `effectOf` answers it for a tool name; a step is more than its tool. The
 * rules are the ones the plain-language summary (automation/summarise.js) uses
 * for "a live run will really change something", so the two agree:
 *
 *   integration_action   the effect of its tool (fail-closed on an unknown name)
 *   notification         `sends`
 *   http_request         `writes` for POST / PUT / PATCH / DELETE, else `reads`
 *   code                 `writes`: its sandbox can reach public hosts
 *   ai_step              the strongest of its explicit `tools` allow-list;
 *                        without one, `writes` when it has `allowTools` or an
 *                        agent (their tools are not in the definition)
 *   approval             `sends`: it mails or notifies the approvers
 *   call_block           `writes`: the block's body is not in the definition
 *   parallel             the strongest of every step in its branches
 *   generate_document, fill_document, presentation, knowledge_write,
 *   datatable (a write op)   `writes`: they leave something behind
 *   read_table, table    `reads`: they open and reshape data inside the run (the
 *                        tables they keep expire with the run's other files)
 *   loop                 the strongest of its body
 *   call_layer           the strongest of the flowlet it calls (`ctx.layers`)
 *
 * Everything else reads or reshapes data inside the run. Pure; `ctx.layers` is
 * the definition's `layers` map and is only needed for `call_layer`.
 */
function stepEffect(step, ctx = {}, _seen = new Set()) {
    if (!step || typeof step !== 'object') return 'reads';
    // Lazy: constants.js pulls in the document model, which this file must not.
    const { HTTP_REQUEST_WRITE_METHODS, DATATABLE_WRITE_OPS } = require('./constants');
    switch (step.type) {
        case 'integration_action':
            return effectOf(step.tool);
        case 'notification':
            return 'sends';
        case 'http_request':
            return HTTP_REQUEST_WRITE_METHODS.has(String(step.method || 'GET').toUpperCase()) ? 'writes' : 'reads';
        case 'code':
        case 'generate_document':
        case 'fill_document':
        case 'presentation':
        case 'knowledge_write':
            return 'writes';
        case 'datatable':
            return DATATABLE_WRITE_OPS.has(step.op) ? 'writes' : 'reads';
        case 'approval':
            // Mails or notifies the approvers when it runs.
            return 'sends';
        case 'call_block':
            // The block's body is loaded at run time and is not in the
            // definition, so nothing here can say what it does: fail-closed.
            return 'writes';
        case 'ai_step':
            if (Array.isArray(step.tools)) return maxEffect(step.tools.map(effectOf));
            // No explicit allow-list: `allowTools` offers the user's permitted
            // catalog and an agent binding offers the agent's grants (see
            // core/automationRunner/aiStepTools.js), neither of which is in
            // the definition. Fail-closed.
            if (step.allowTools === true) return 'writes';
            if (typeof step.agentId === 'string' && step.agentId.trim()) return 'writes';
            return 'reads';
        case 'parallel': {
            const branches = Array.isArray(step.branches) ? step.branches : [];
            const inner = branches.flatMap(b => (Array.isArray(b) ? b : []));
            return maxEffect(inner.map(s => stepEffect(s, ctx, _seen)));
        }
        case 'loop':
            return maxEffect((Array.isArray(step.body) ? step.body : []).map(s => stepEffect(s, ctx, _seen)));
        case 'call_layer': {
            // A flowlet that calls itself (directly or not) is walked once.
            if (!step.layerKey || _seen.has(step.layerKey)) return 'reads';
            const layer = ctx.layers && ctx.layers[step.layerKey];
            const inner = Array.isArray(layer && layer.steps) ? layer.steps : [];
            return maxEffect(inner.map(s => stepEffect(s, ctx, new Set([..._seen, step.layerKey]))));
        }
        case 'read_table':
        case 'table':
            // Opens and reshapes data inside the run; the tables expire with it.
            return 'reads';
        default:
            return 'reads';
    }
}

module.exports = { stepEffect };

/**
 * The fields of a workflow step that decide its effect.
 * @typedef {{ type?: string, tool?: string, method?: string, op?: string, tools?: string[], allowTools?: boolean,
 *   agentId?: unknown, branches?: EffectStep[][], body?: EffectStep[], layerKey?: string }} EffectStep
 */
