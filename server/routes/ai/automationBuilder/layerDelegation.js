/**
 * Automation Builder — flowlet delegation from inside the chat loop: the
 * builder_generate_layer / builder_generate_layers tools that spawn the
 * thinking-model sub-agent(s) and mutate the draft in place.
 */

const { applyToolCall } = require('../../../automation/builderTools');
const { runLayerAgent, runLayersInParallel } = require('../../../automation/flowletAgent');

/**
 * Run a flowlet-delegation tool (builder_generate_layer / _layers). Spawns the
 * thinking-model flowlet sub-agent(s) and mutates draftWrap.def in place; the
 * caller persists + emits the draft snapshot afterwards. Returns a result the
 * orchestrator uses to wire call_layer steps.
 */
async function runDelegationTool(name, args, ctx) {
    const { draftWrap, thinkingModelId, userId, userOrgId, session, catalog, send } = ctx;

    if (name === 'builder_generate_layer') {
        const title = String(args?.title || 'New layer');
        const created = await applyToolCall('builder_create_layer', { title, params: args?.params }, draftWrap);
        if (created?.error) return created;
        const layerKey = created.layerKey;
        send('layer_agent_start', { layerKey, title });
        const r = await runLayerAgent({
            draftWrap, layerKey,
            instruction: String(args?.instruction || title),
            contract: { params: args?.params, outputFields: args?.outputFields },
            mode: 'create', modelId: thinkingModelId, userId, userOrgId, session, catalog, send,
        });
        send('layer_agent_done', { layerKey, outputFields: r.outputFields, summary: r.summary });
        return {
            layerKey, title, outputFields: r.outputFields, summary: r.summary,
            next: `Wire it into the main flow: builder_add_call_layer({ layerKey: "${layerKey}", inputs: {…} }). Bind its results downstream as steps.<callId>.output.<field> for: ${(r.outputFields || []).join(', ') || '(none declared — call builder_set_layer_contract)'}.`,
        };
    }

    // builder_generate_layers — parallel (cap 3, enforced in layerAgent).
    const specs = Array.isArray(args?.layers) ? args.layers.filter(s => s && (s.instruction || s.title)) : [];
    if (specs.length === 0) {
        return { error: 'builder_generate_layers requires a non-empty `layers` array of { title, instruction, params?, outputFields? }.' };
    }
    const results = await runLayersInParallel({
        rootDef: draftWrap.def, specs,
        modelId: thinkingModelId, userId, userOrgId, session, catalog, send, cap: 3,
        inputSchemasByTool: draftWrap._inputSchemasByTool,
        allowedModelTiers: draftWrap._allowedModelTiers || null,
        // The isolated drafts must carry the same two gates the main draft
        // does, or a parallel flowlet agent could bind a tool the user does
        // not have and a table id that is not theirs — both permissive when
        // absent, exactly as on the main draft (null = could not tell).
        datatables: draftWrap._datatables ?? null,
        // The consent gate too (datatableApproval): a sub-agent cannot ask the
        // user, so a table that was not chosen is refused to it and the refusal
        // reaches the main agent, which asks. A copy, so a sub-agent's own
        // creations never widen the main draft's set.
        approvedDatatableIds: draftWrap._approvedDatatableIds ? new Set(draftWrap._approvedDatatableIds) : null,
        documents: draftWrap._documents ?? null,
        availableToolNames: draftWrap._availableToolNames || null,
    });
    return {
        layers: results.map(r => (r.ok
            ? { layerKey: r.layerKey, title: r.title, outputFields: r.outputFields, summary: r.summary }
            : { title: r.title, error: r.error })),
        next: 'Wire each built flowlet into the main flow with builder_add_call_layer({ layerKey, inputs }); bind their results as steps.<callId>.output.<field>.',
    };
}

module.exports = { runDelegationTool };
