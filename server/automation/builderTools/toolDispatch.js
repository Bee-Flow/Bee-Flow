// @typecheck strict
/**
 * Builder tools — the dispatch: which graph a call works on (the main flow, or
 * a flowlet when it passes `scope`) and which apply function a tool name runs.
 * One row per tool in HANDLERS; a row says what its apply function is handed:
 * the graph in scope, the whole draft, or the wrapper around it.
 * Required from the ../builderTools facade.
 */

'use strict';

const { summariseDefinition } = require('../summarise');
const { applyWireErrorBranch } = require('./draftGraph');
const stepBuilders = require('./stepBuilders');
const { applyCreateLayer, applySetLayerContract, applyAddCallLayer } = require('./layers');
const { applyInlineLayer } = require('./inlineLayer');
const { handoverNeeds } = require('./handoverNeeds.mts');
const { applyAddApproval } = require('./approval');
const { applyCreateDatatable } = require('./datatableCreate');
const { applyAddTrigger, applyUpdateTrigger } = require('./triggers');
const { applyUpdateStep, applyUpdateSteps, applyReplaceStep, applyRemoveStep } = require('./stepEditing');
const { applyAddSteps } = require('./addSteps');
const { applyInspectTool } = require('./inspection');
const { applyRequestDryRun } = require('./dryRun');
const { dryRunHint } = require('./dryRunHint');

/**
 * @typedef {Record<string, any>} Args  a tool call's arguments, as the model wrote them
 * @typedef {Record<string, any>} Graph  the main flow or one flowlet: both hold steps and edges
 * @typedef {Record<string, any> & { def: Graph }} Wrap  the draft's wrapper: the definition plus what the turn keeps beside it
 * @typedef {typeof import('./persistence').persistDraft} PersistDraft
 * @typedef {{ args: Args, draftWrap: Wrap, draft: Graph, graph: Graph, scope: string | null, sent: Args, persistDraft: PersistDraft }} ToolCall
 *   one call: `draft` is the whole definition, `graph` the part of it in scope, `sent` the arguments before a repair,
 *   `persistDraft` the facade's own save (the two tools that save go through the facade's binding)
 * @typedef {(call: ToolCall) => any} Handler  answers the JSON report of the call (or a promise of it); its keys depend on the tool
 */

/** @param {Wrap} draftWrap @param {Args} args */
function applySetMetadata(draftWrap, args) {
    if (typeof args.title === 'string') draftWrap.title = args.title;
    if (typeof args.description === 'string') draftWrap.description = args.description;
    return { title: draftWrap.title, description: draftWrap.description };
}

/** @param {Graph} draft */
function applySummarise(draft) {
    const { summary, hasSideEffects } = summariseDefinition(draft);
    return { summary, hasSideEffects };
}

/**
 * Slim echo: the full automation row embeds the entire definition JSON the
 * model already has in context. Callers only read `.automation.id` /
 * `.title`; validation errors stay structured. `needs`: what the person still
 * does before it is of use (switch it on, share the form link, run it once,
 * connect an app the draft uses). The chat's hand-over card and the closing
 * "To use it" line both read it.
 * @param {Wrap} draftWrap
 * @param {PersistDraft} persistDraft
 */
async function applyFinalize(draftWrap, persistDraft) {
    const automation = await persistDraft(/** @type {Parameters<PersistDraft>[0]} */ (draftWrap), { finalize: true });
    if (!automation?.id) return { ok: false, error: automation?.error || 'The automation could not be saved.' }; // store answered false
    return {
        automation: { id: automation.id, title: automation.title },
        ok: !automation.validationErrors,
        ...(automation.validationErrors ? { validationErrors: automation.validationErrors } : {}),
        needs: handoverNeeds(draftWrap.def, { availableToolNames: draftWrap._availableToolNames }),
    };
}

/**
 * A step builder that takes the graph in scope and the arguments.
 * @param {(graph: Graph, args: Args) => any} apply
 * @returns {Handler}
 */
const onGraph = (apply) => (call) => apply(call.graph, call.args);

/**
 * A step builder that also reads the wrapper (catalogues, the turn's memory).
 * @param {(graph: Graph, args: Args, draftWrap: Wrap) => any} apply
 * @returns {Handler}
 */
const onGraphWithWrap = (apply) => (call) => apply(call.graph, call.args, call.draftWrap);

/**
 * A tool of the whole draft: triggers and flowlet management never take a scope.
 * @param {(draft: Graph, args: Args) => any} apply
 * @returns {Handler}
 */
const onDraft = (apply) => (call) => apply(call.draft, call.args);

/** @type {Record<string, Handler>} */
const HANDLERS = {
    builder_propose_trigger: onDraft(stepBuilders.applyTrigger),
    builder_add_trigger: onDraft(applyAddTrigger),
    builder_update_trigger: onDraft(applyUpdateTrigger),
    builder_add_action: onGraphWithWrap(stepBuilders.applyAddAction),
    builder_add_ai_step: onGraphWithWrap(stepBuilders.applyAddAi),
    builder_add_condition: onGraph(stepBuilders.applyAddCondition),
    builder_add_loop: onGraphWithWrap(stepBuilders.applyAddLoop),
    builder_add_code_step: onGraphWithWrap(stepBuilders.applyAddCode),
    builder_add_notification: onGraphWithWrap(stepBuilders.applyAddNotification),
    builder_add_http_request: onGraphWithWrap(stepBuilders.applyAddHttpRequest),
    builder_add_generate_document: onGraph(stepBuilders.applyAddGenerateDocument),
    builder_add_fill_document: onGraphWithWrap(stepBuilders.applyAddFillDocument),
    builder_add_slide: onGraphWithWrap(stepBuilders.applyAddSlide),
    builder_add_presentation: onGraph(stepBuilders.applyAddPresentation),
    builder_add_data_extraction: onGraphWithWrap(stepBuilders.applyAddDataExtraction),
    builder_add_set: onGraphWithWrap(stepBuilders.applyAddSet),
    builder_add_call_layer: ({ draft, args, graph, scope }) => applyAddCallLayer(draft, args, { graph, scope }),
    builder_create_layer: onDraft(applyCreateLayer),
    builder_set_layer_contract: onDraft(applySetLayerContract),
    builder_inline_layer: ({ graph, draft, args }) => applyInlineLayer(graph, draft, /** @type {{ stepId: string }} */ (args)),
    builder_add_datetime: onGraph(stepBuilders.applyAddDateTime),
    builder_add_wait: onGraph(stepBuilders.applyAddWait),
    builder_add_approval: onGraph(applyAddApproval),
    builder_add_form_page: onGraph(stepBuilders.applyAddFormPage),
    builder_add_stop_error: onGraph(stepBuilders.applyAddStopError),
    builder_add_switch: onGraphWithWrap(stepBuilders.applyAddSwitch),
    builder_add_filter: onGraphWithWrap(stepBuilders.applyAddFilter),
    builder_add_limit: onGraphWithWrap(stepBuilders.applyAddLimit),
    builder_add_dedupe: onGraphWithWrap(stepBuilders.applyAddDedupe),
    builder_add_aggregate: onGraphWithWrap(stepBuilders.applyAddAggregate),
    builder_add_summarize: onGraphWithWrap(stepBuilders.applyAddSummarize),
    builder_add_array_op: onGraphWithWrap(stepBuilders.applyAddArrayOp),
    builder_add_datatable: onGraphWithWrap(stepBuilders.applyAddDatatable),
    // A table made at DESIGN time (a side effect outside the draft — never a
    // graph mutation): the catalog on draftWrap is refreshed in place.
    builder_create_datatable: ({ draftWrap, args }) => applyCreateDatatable(/** @type {Parameters<typeof applyCreateDatatable>[0]} */ (draftWrap), args),
    builder_add_knowledge_write: onGraphWithWrap(stepBuilders.applyAddKnowledgeWrite),
    builder_add_note: onGraph(stepBuilders.applyAddNote),
    builder_add_steps: ({ graph, args, draft, scope, sent, draftWrap }) => applyAddSteps(graph, args, { draft, scope, sent }, draftWrap),
    builder_wire_error_branch: onGraph(applyWireErrorBranch),
    builder_remove_step: onGraph(applyRemoveStep),
    builder_update_step: onGraphWithWrap(applyUpdateStep),
    builder_update_steps: onGraphWithWrap(applyUpdateSteps),
    builder_replace_step: ({ graph, args, draft, scope, draftWrap }) => applyReplaceStep(graph, args, { draft, scope }, draftWrap),
    builder_set_metadata: ({ draftWrap, args }) => applySetMetadata(draftWrap, args),
    builder_summarise: ({ draft }) => applySummarise(draft),
    builder_inspect_tool: ({ args, draftWrap }) => applyInspectTool(args, draftWrap),
    builder_request_dry_run: ({ draftWrap, args, persistDraft }) => applyRequestDryRun(/** @type {Parameters<typeof applyRequestDryRun>[0]} */ (draftWrap), args, { persistDraft, annotate: dryRunHint }),
    builder_finalize: ({ draftWrap, persistDraft }) => applyFinalize(draftWrap, persistDraft),
};

/**
 * Central scope resolution (inline flowlets): scoped tools may pass
 * scope:'<layerKey>' to operate on definition.layers[<key>]'s graph instead
 * of the root flow. Resolved ONCE here so every apply function just works on
 * `graph` (mini-definitions share the root shape).
 * @param {string} name
 * @param {Args | null | undefined} args
 * @param {Graph} draft
 * @param {Set<string>} scopedTools  the tools that accept a scope
 * @returns {{ error: string } | { graph: Graph, scope: string | null }}
 */
function resolveScope(name, args, draft, scopedTools) {
    const scope = (args && typeof args.scope === 'string' && args.scope) ? args.scope : null;
    if (!scope) return { graph: draft, scope: null };
    if (!scopedTools.has(name)) {
        return { error: `Tool ${name} does not accept a scope. Flowlet triggers/contracts are managed via builder_create_layer / builder_set_layer_contract.` };
    }
    const graph = draft.layers?.[scope];
    if (!graph) {
        return { error: `Unknown flowlet scope "${scope}". Existing flowlets: ${Object.keys(draft.layers || {}).join(', ') || '(none — create one with builder_create_layer)'}.` };
    }
    return { graph, scope };
}

/**
 * Run the apply function of one tool.
 * @param {string} name
 * @param {ToolCall} call
 * @returns {Promise<any>}  the tool's own report: every tool answers its own keys
 */
async function dispatchTool(name, call) {
    if (!Object.hasOwn(HANDLERS, name)) return { error: `Unknown builder tool: ${name}` };
    return HANDLERS[name](call);
}

module.exports = { resolveScope, dispatchTool };
