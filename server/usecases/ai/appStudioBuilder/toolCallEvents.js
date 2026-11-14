// @typecheck strict
/**
 * App Studio Builder — the `tool_call` SSE payload.
 *
 * Everything the transcript shows about one tool call: its human label, the
 * one-line summary of what came back, what the call LANDED (typed, for the
 * activity rows and ghost clearing) and the bounded arguments/result pair.
 *
 * The screenshot side channel (`_screenshotDataUrl`) is stripped here and
 * never reaches a client this way — the route emits it as its own `image`
 * event instead.
 */

const { findNode } = require('../../../appStudio/definitionOps');
const { truncateJson } = require('./turnLoop');
const { summariseToolResult } = require('./toolSummaries');

/** @type {Record<string, string>} */
const TOOL_LABELS = {
    app_set_meta: 'Set app details',
    app_set_theme: 'Set theme',
    app_add_screen: 'Add screen',
    app_update_screen: 'Update screen',
    app_remove_screen: 'Remove screen',
    app_add_section: 'Add section',
    app_update_section: 'Restyle section',
    app_add_components: 'Add components',
    app_update_component: 'Update component',
    app_move_node: 'Move component',
    app_remove_node: 'Remove component',
    app_set_action: 'Configure action',
    app_remove_action: 'Remove action',
    app_bind_action: 'Wire action',
    app_get_draft: 'Read draft',
    app_get_node: 'Read components',
    app_find_nodes: 'Search draft',
    app_inspect_catalog: 'Read catalog',
    app_list_automations: 'List automations',
    app_inspect_automation: 'Inspect automation',
    app_upsert_table: 'Create table',
    app_link_datatable: 'Link table',
    app_set_plan: 'Plan',
    app_remove_table: 'Remove table',
    app_set_roles: 'Set up roles',
    app_seed_records: 'Add sample data',
    app_upsert_dataset: 'Create dataset',
    app_get_data_model: 'Read data model',
    app_query_data: 'Query data',
    app_list_connectors: 'List connectors',
    app_list_assets: 'List uploaded files',
    app_dry_run: 'Dry-run app',
    app_screenshot: 'Screenshot',
    app_propose_plan: 'Propose a plan',
    app_ask_questions: 'Ask questions',
    app_mark_phase: 'Start phase',
    app_list_templates: 'List templates',
    app_apply_template: 'Apply template',
    app_finalize: 'Finalize app',
};

/**
 * @param {string} name
 */
function labelForTool(name) {
    return TOOL_LABELS[name] || name;
}

// tool_call payload caps — the arguments of a 40-entry app_add_components
// batch are ~10 KB; anything above is a preview, and the base64 screenshot
// side channel never leaves the server this way.
const TOOL_CALL_PAYLOAD_CHARS = 8_000;

/**
 * @typedef {import('../../../appStudio/builderTools').ToolArgs} ToolArgs
 * @typedef {import('./toolSummaries').ToolResult} ToolResult
 * @typedef {{ id: string, type: string|null, label: string|null }} AddedItem
 */

/**
 * What a successful call LANDED, typed, for the activity rows and ghost clearing.
 * @param {string} name
 * @param {ToolArgs|null|undefined} args
 * @param {ToolResult|null|undefined} result
 * @param {import('../../../appStudio/builderTools').BuilderDraft|null|undefined} draftWrap
 * @returns {AddedItem[]}
 */
function addedOf(name, args, result, draftWrap) {
    if (!result || typeof result !== 'object' || result.error) return [];
    const def = draftWrap && draftWrap.def;
    const labelOfNode = (/** @type {string} */ id) => {
        try {
            const found = def ? findNode(def, id) : null;
            const p = found && found.node && found.node.props;
            const l = p && (p.text || p.label || p.title || p.name);
            return typeof l === 'string' ? l.slice(0, 80) : null;
        } catch (_) { return null; }
    };
    switch (name) {
        case 'app_add_components':
            return (Array.isArray(result.added) ? result.added : [])
                .filter((a) => a && typeof a.id === 'string')
                .map((a) => {
                    const id = /** @type {string} */ (a.id); // the filter kept string ids only
                    return { id, type: a.type || null, label: labelOfNode(id) };
                });
        case 'app_add_screen':
            return result.screenId ? [{ id: result.screenId, type: 'screen', label: (args && typeof args.name === 'string') ? args.name : null }] : [];
        case 'app_link_datatable':
            return result.table && result.table.id ? [{ id: result.table.id, type: 'table', label: result.table.name || result.table.key || null }] : [];
        case 'app_upsert_table':
            return result.tableId ? [{ id: result.tableId, type: 'table', label: (args && (args.name || args.key)) || result.key || null }] : [];
        case 'app_set_action':
            return result.actionId ? [{ id: result.actionId, type: 'action', label: (args && args.action && (args.action.name || args.action.kind)) || null }] : [];
        default:
            return [];
    }
}

/**
 * The tool_call SSE payload: the legacy line plus the typed, bounded detail.
 * @param {string} name
 * @param {ToolArgs|null|undefined} args
 * @param {ToolResult|null|undefined} result
 * @param {boolean} ok
 * @param {import('../../../appStudio/builderTools').BuilderDraft|null|undefined} draftWrap
 */
function toolCallEvent(name, args, result, ok, draftWrap) {
    /** @type {{ name: string, label: string, ok: boolean, summary: string, added?: AddedItem[], error?: string, hint?: string, arguments?: string, result?: string }} */
    const payload = { name, label: labelForTool(name), ok, summary: summariseToolResult(name, args, result) };
    const added = addedOf(name, args, result, draftWrap);
    if (added.length) payload.added = added;
    if (result && typeof result === 'object') {
        if (result.error) payload.error = String(result.error).slice(0, 600);
        if (result._fixHint) payload.hint = String(result._fixHint).slice(0, 600);
    }
    payload.arguments = truncateJson(args, TOOL_CALL_PAYLOAD_CHARS);
    if (result && typeof result === 'object') {
        // Never the screenshot bytes: the success result carries the data URL
        // on a side channel that must stay server-side (see toolSummaries.js).
        const { _screenshotDataUrl, _screenshotCaption, ...rest } = result;
        void _screenshotDataUrl; void _screenshotCaption;
        payload.result = truncateJson(rest, TOOL_CALL_PAYLOAD_CHARS);
    } else {
        payload.result = truncateJson(result, TOOL_CALL_PAYLOAD_CHARS);
    }
    return payload;
}

module.exports = {
    TOOL_LABELS,
    labelForTool,
    TOOL_CALL_PAYLOAD_CHARS,
    addedOf,
    toolCallEvent,
    summariseToolResult,
};
