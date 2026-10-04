/**
 * App Studio builder tools — the function-calling surface the conversational
 * app builder agent uses to mutate a draft app definition.
 *
 * Philosophy mirrors automation/builderTools.js:
 *   - every mutating tool applies a pure op from definitionOps.js, then runs
 *     the result through canonicalizeAppDefinition; the canonical def is kept
 *     in draftWrap.def and every repair the canonicalizer made is surfaced on
 *     the result as `_hints` so the model learns the right shape,
 *   - rejected calls return { error, _fixHint } — they NEVER throw,
 *   - persistDraft() writes through to studio_apps (create on first mutation,
 *     CAS save thereafter) so a page refresh recovers the work.
 *
 * The draft wrapper shared with the route:
 *   { userId, orgId?, appId?, version?, builderSessionId, def, finalized?,
 *     // data side (loaded per turn by the route; mutated by the data tools):
 *     dataModel?, dataModelVersion?, rowCounts? (keyed by TABLE ID),
 *     datasetIds? ([{ id, name }]),
 *     // set by the route for app_screenshot (wording + per-turn cap):
 *     modelSupportsVision?, _screenshotsThisTurn? }
 */

'use strict';

// The tool implementations live in ./builderTools/ by family (mirrors
// automation/builderTools/ and builderPrompt/); this facade keeps the module
// path, the dispatch table and the exact public surface.
const { newId } = require('./componentSpecs');
const { TOOL_SCHEMAS } = require('./builderTools/schemas');
const {
    NODE_LOGIC_FIELDS,
    NODE_AUTHORABLE_FIELDS,
    normalizeLogicValue,
    normalizeComputed,
    normalizeValidations,
    normalizeNodeField,
} = require('./builderTools/shared');
const {
    applySetMeta, applySetTheme, applySetNavGroups,
    applyAddScreen, applyUpdateScreen, applyRemoveScreen, applyAddSection, applyUpdateSection,
    applyAddComponents, applyUpdateComponentTool, applyMoveNode, applyRemoveNode,
    applySetActionTool, applyRemoveAction, applyBindActionTool,
    applySetVariables, applySetPublicAccess,
    resolveParent, buildComponentNode, readBatchArg, runPatchBatch, COMPONENT_ENTRY_KEYS,
} = require('./builderTools/definitionTools');
const {
    persistDataModel,
    applyUpsertTable, applyRemoveTable, applySetRoles,
    applySeedRecords, applyUpsertDataset,
    applyGetDataModel, applyListConnectors, applyListDocuments, applyQueryData,
    mergeTableOp, findTableRefs, rowCountsById, MAX_QUERY_LIMIT,
} = require('./builderTools/dataTools');
const {
    applyDryRun, applyAppScreenshot, applyGetDraft, applyFindNodes, applyInspectCatalog,
    applyListAutomations, applyInspectAutomation,
    automationSummaryRow, MAX_SCREENSHOTS_PER_TURN,
} = require('./builderTools/inspectionTools');
const { boundPlanArtifact, applyProposePlan, applyMarkPhase, PLAN_LIMITS } = require('./builderTools/planTools');
const { applyListTemplates, applyApplyTemplate, applySaveAsTemplate, isFreshDraft } = require('./builderTools/templateTools');
const { applyFinalize, persistDraft } = require('./builderTools/persistence');
const { applyLinkDatatable } = require('./builderTools/linkTools');
const { noteRepeatedRejection, isRepeat } = require('../core/llm/toolCallHygiene');
const { applyPatchOps } = require('../automation/builderTools/suggestedPatch');

// ── Mutation bookkeeping ─────────────────────────────────────────────

const MUTATING_TOOLS = new Set([
    'app_set_meta', 'app_set_theme', 'app_set_nav_groups',
    'app_add_screen', 'app_update_screen', 'app_remove_screen',
    'app_add_section', 'app_update_section', 'app_add_components', 'app_update_component',
    'app_move_node', 'app_remove_node',
    'app_set_action', 'app_remove_action', 'app_bind_action',
    'app_upsert_table', 'app_link_datatable', 'app_remove_table', 'app_set_roles',
    'app_seed_records', 'app_upsert_dataset', 'app_set_variables',
    'app_set_public_access',
]);

// The subset of MUTATING_TOOLS that mutates the DATA side (model / rows /
// datasets / roles) — after any of these succeeds the route emits a
// `data_model` SSE event so the editor's table/dataset/role caches refresh.
const DATA_MODEL_TOOLS = new Set([
    'app_upsert_table', 'app_link_datatable', 'app_remove_table', 'app_set_roles',
    'app_seed_records', 'app_upsert_dataset',
]);

// ── Dispatcher ───────────────────────────────────────────────────────

/**
 * Apply one builder tool call against the draft. Returns a small JSON report
 * (the `tool` message back to the LLM and the SSE tool_call summary source).
 * Mutating results carry `_hints` (canonicalize repairs); rejects carry
 * { error, _fixHint } and never throw.
 */
// The generic "never invent ids" hint is stamped ONLY on an id-lookup failure.
// It used to land on every error without a hint — including "fields must be a
// non-empty array" and "this table is linked" — steering the model toward
// re-reading ids when the fix was somewhere else (the automation builder
// reverted the same blanket stamp for the same reason).
const ID_LOOKUP_ERROR_RE = /\bunknown\b[^.]*\b(id|parentId|screenId|sectionId|actionId|nodeId|tableId|datasetId|automationId)\b|does not exist|did you mean/i;

async function applyToolCall(name, args, draftWrap) {
    if (['app_search_documents','app_read_document'].includes(name)) return require('../core/documents/documentDiscovery').execute(name,args || {},draftWrap);
    if (MUTATING_TOOLS.has(name)) {
        const issue = require('../core/documents/documentDiscovery').inspectBindings(args,draftWrap,'app');
        if (issue) return issue;
    }

    // Rung 2 of the repeat ladder: the call that was just rejected comes back
    // unchanged and the rejection carried its own fix (`_suggestedPatch`) —
    // apply the fix and dispatch that. Measured: the small local model cannot
    // edit one field of a call it already sent. A call the model edited itself
    // no longer matches the signature and is left alone.
    let callArgs = args || {};
    let repaired = null;
    const prev = draftWrap && typeof draftWrap === 'object' ? draftWrap._lastRejected : null;
    if (prev && prev.patch && MUTATING_TOOLS.has(name) && isRepeat(draftWrap, name, args)) {
        const { args: patched, applied } = applyPatchOps(callArgs, prev.patch.ops);
        if (applied.length) { callArgs = patched; repaired = applied; }
    }
    let result;
    try {
        result = await _applyToolCallRaw(name, callArgs, draftWrap);
    } catch (e) {
        result = { error: e.message };
    }
    if (repaired && result && typeof result === 'object' && !result.error) {
        result._autoRepaired = repaired;
        result._hints = [`Your resend was identical, so the fix the error named was applied: ${repaired.join('; ')}. It is built now — do NOT resend it; continue with the next step.`, ...(Array.isArray(result._hints) ? result._hints : [])];
    }
    if (result && typeof result === 'object' && result.error && !result._fixHint
        && ID_LOOKUP_ERROR_RE.test(String(result.error))) {
        result._fixHint = 'Fix the arguments and call the tool again. Ids must come from the draft state / earlier tool results — never invent them.';
    }
    // The same call rejected twice → say so; three times → stop and ask.
    noteRepeatedRejection(name, args, result, draftWrap, { mutating: MUTATING_TOOLS });
    return result;
}

async function _applyToolCallRaw(name, args, draftWrap) {
    switch (name) {
        case 'app_set_meta':          return applySetMeta(draftWrap, args);
        case 'app_set_theme':         return applySetTheme(draftWrap, args);
        case 'app_set_nav_groups':    return applySetNavGroups(draftWrap, args);
        case 'app_add_screen':        return applyAddScreen(draftWrap, args);
        case 'app_update_screen':     return applyUpdateScreen(draftWrap, args);
        case 'app_remove_screen':     return applyRemoveScreen(draftWrap, args);
        case 'app_add_section':       return applyAddSection(draftWrap, args);
        case 'app_update_section':    return applyUpdateSection(draftWrap, args);
        case 'app_add_components':    return applyAddComponents(draftWrap, args);
        case 'app_update_component':  return applyUpdateComponentTool(draftWrap, args);
        case 'app_move_node':         return applyMoveNode(draftWrap, args);
        case 'app_remove_node':       return applyRemoveNode(draftWrap, args);
        case 'app_set_action':        return applySetActionTool(draftWrap, args);
        case 'app_remove_action':     return applyRemoveAction(draftWrap, args);
        case 'app_bind_action':       return applyBindActionTool(draftWrap, args);
        case 'app_upsert_table':      return applyUpsertTable(draftWrap, args);
        case 'app_link_datatable':    return applyLinkDatatable(draftWrap, args);
        case 'app_remove_table':      return applyRemoveTable(draftWrap, args);
        case 'app_set_roles':         return applySetRoles(draftWrap, args);
        case 'app_set_variables':     return applySetVariables(draftWrap, args);
        case 'app_set_public_access': return applySetPublicAccess(draftWrap, args);
        case 'app_seed_records':      return applySeedRecords(draftWrap, args);
        case 'app_upsert_dataset':    return applyUpsertDataset(draftWrap, args);
        case 'app_get_data_model':    return applyGetDataModel(draftWrap);
        case 'app_list_connectors':   return applyListConnectors(draftWrap);
        case 'app_list_documents':    return applyListDocuments(draftWrap);
        case 'app_query_data':        return applyQueryData(draftWrap, args);
        case 'app_dry_run':           return applyDryRun(draftWrap, args);
        case 'app_screenshot':        return applyAppScreenshot(draftWrap, args);
        case 'app_get_draft':         return applyGetDraft(draftWrap, args);
        case 'app_find_nodes':        return applyFindNodes(draftWrap, args);
        case 'app_inspect_catalog':   return applyInspectCatalog(args);
        case 'app_list_automations':  return applyListAutomations(draftWrap);
        case 'app_inspect_automation': return applyInspectAutomation(draftWrap, args);
        case 'app_propose_plan':      return applyProposePlan(draftWrap, args);
        case 'app_mark_phase':        return applyMarkPhase(draftWrap, args);
        case 'app_list_templates':    return applyListTemplates(draftWrap);
        case 'app_apply_template':    return applyApplyTemplate(draftWrap, args);
        case 'app_save_as_template':  return applySaveAsTemplate(draftWrap, args);
        case 'app_finalize':          return applyFinalize(draftWrap);
        // Route-handled (the builder route keeps the list and emits the plan
        // event); a direct caller gets a plain answer rather than "unknown tool".
        case 'app_set_plan':          return { error: 'app_set_plan is handled by the builder chat — it records your checklist there and does not change the app.' };
        default:
            return { error: `Unknown app builder tool: ${name}` };
    }
}

module.exports = {
    TOOL_SCHEMAS,
    MUTATING_TOOLS,
    DATA_MODEL_TOOLS,
    applyToolCall,
    persistDraft,
    persistDataModel,
    // exposed for tests + the route (plan bounding is reused route-side)
    boundPlanArtifact,
    _test: {
        resolveParent, buildComponentNode, automationSummaryRow, newId, normalizeLogicValue,
        normalizeComputed, normalizeValidations, normalizeNodeField,
        NODE_LOGIC_FIELDS, NODE_AUTHORABLE_FIELDS, COMPONENT_ENTRY_KEYS,
        readBatchArg, runPatchBatch,
        mergeTableOp, findTableRefs, rowCountsById,
        boundPlanArtifact, isFreshDraft, PLAN_LIMITS, MAX_QUERY_LIMIT,
        MAX_SCREENSHOTS_PER_TURN,
    },
};
