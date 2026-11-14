// @typecheck strict
/**
 * App Studio Builder: the one short human line per tool result that the
 * `tool_call` SSE event carries. One entry per tool in SUMMARISERS; a tool
 * without an entry gets an empty line.
 */

'use strict';

/**
 * @typedef {import('../../../appStudio/builderTools').ToolArgs} ToolArgs
 * @typedef {import('../../../appStudio/builderTools').ToolResult & {
 *   meta?: { name?: string }, screenId?: string, sectionId?: string, removed?: string,
 *   added?: Array<{ id?: string, type?: string, label?: string }>, batch?: boolean, applied?: number, updated?: string,
 *   moved?: string, toParentId?: string, created?: boolean, actionId?: string, hitCount?: number, truncated?: boolean,
 *   automations?: unknown[], automation?: { title?: string }, key?: string, tableId?: string, fields?: unknown[], migration?: string,
 *   table?: { id?: string, name?: string, key?: string, linked?: { kind?: string, mode?: string, rowCount?: number } },
 *   note?: string, todos?: Array<{ done?: boolean }>, next?: string, roles?: string[], inserted?: number, failed?: unknown[],
 *   name?: string, datasetId?: string, rowCount?: number, connectors?: unknown[], more?: boolean,
 *   static?: { errors?: unknown[] }, emptyTables?: unknown[], ok?: boolean,
 *   _screenshotDataUrl?: string, _screenshotCaption?: string, content?: string,
 *   planId?: string, index?: number, label?: string, templates?: unknown[], templateId?: string, finalized?: boolean,
 * }} ToolResult
 * @typedef {(args: ToolArgs, result: ToolResult) => string} Summariser
 */

/**
 * One line, whitespace collapsed, at most 140 characters.
 * @param {unknown} s
 */
function cap(s) {
    const str = String(s || '').replace(/\s+/g, ' ').trim();
    return str.length > 140 ? `${str.slice(0, 140)}…` : str;
}

/** @param {unknown} list */
const countOf = (list) => (Array.isArray(list) ? list.length : 0);

/** @param {number} n */
const plural = (n) => (n === 1 ? '' : 's');

/** @param {unknown} note */
const noteSuffix = (note) => (note ? ` — ${note}` : '');

/**
 * Where a linked table lives, how it may be written and how many rows it has.
 * @param {{ kind?: string, mode?: string, rowCount?: number }} linked
 */
function linkedSuffix(linked) {
    const kind = linked.kind ? ` — ${linked.kind === 'nextcloud' ? 'Nextcloud mirror' : 'Studio table'}` : '';
    const mode = linked.mode ? `, ${linked.mode === 'read' ? 'read-only' : 'read-write'}` : '';
    const rows = Number.isFinite(linked.rowCount) ? `, ${linked.rowCount} live row${plural(/** @type {number} */ (linked.rowCount))}` : '';
    return `${kind}${mode}${rows}`;
}

/** @type {Summariser} */
function summariseLinkedTable(_args, result) {
    const table = result.table || {};
    return `Linked "${table.name || table.key || '?'}" (${table.id || '?'})${linkedSuffix(table.linked || {})}${noteSuffix(result.note)}`;
}

/** @type {Summariser} */
function summarisePlan(_args, result) {
    const todos = Array.isArray(result.todos) ? result.todos : [];
    if (!todos.length) return 'Plan cleared';
    const done = todos.filter((t) => t && t.done).length;
    return `Plan ${done}/${todos.length}${result.next ? ` · next: ${result.next}` : ''}`;
}

/** @type {Summariser} */
function summariseDryRun(_args, result) {
    const errCount = countOf(result.static?.errors);
    const empties = countOf(result.emptyTables);
    if (result.ok) return `Dry-run clean${empties ? ` (${empties} empty table binding${plural(empties)})` : ''}`;
    return `Dry-run found ${errCount} error${plural(errCount)}${empties ? `, ${empties} empty binding${plural(empties)}` : ''} — fix before finalize`;
}

// The patch tools (update component, set action, bind action) take a single
// form OR a batch, and the batch result carries { batch: true, applied }
// instead of the single form's per-call arguments, so the batch shape has its
// own line.

/** @type {Summariser} */
function summariseSetAction(args, result) {
    if (result.batch) return `Configured ${result.applied} action(s)`;
    return `${result.created ? 'Created' : 'Updated'} action ${result.actionId} (${args.action?.kind || '?'})`;
}

/** @type {Summariser} */
function summariseBindAction(args, result) {
    if (result.batch) return `Wired ${result.applied} handler(s)`;
    return args.actionId === null ? `Cleared ${args.event} on ${args.nodeId}` : `${args.event} → ${result.actionId}`;
}

/**
 * Reads only the caption and the text: the success result carries the full
 * base64 data URL on a side channel that must never reach a summary line.
 * @type {Summariser}
 */
function summariseScreenshot(_args, result) {
    return result._screenshotDataUrl ? (result._screenshotCaption || 'Screenshot captured') : (result.content || '');
}

/** @type {Record<string, Summariser>} */
const SUMMARISERS = {
    app_set_meta: (args, result) => `App is now "${result.meta?.name || args.name || 'Untitled app'}"`,
    app_set_theme: () => 'Theme updated',
    app_add_screen: (args, result) => `Added screen "${args.name || 'Screen'}" (${result.screenId})`,
    app_update_screen: (args) => `Updated screen ${args.screenId}`,
    app_remove_screen: (_args, result) => `Removed screen ${result.removed}`,
    app_add_section: (_args, result) => `Added section ${result.sectionId}`,
    app_update_section: (_args, result) => `Restyled section ${result.sectionId}`,
    app_add_components: (_args, result) => `Added ${countOf(result.added)} component(s)`,
    app_update_component: (_args, result) => (result.batch ? `Updated ${result.applied} component(s)` : `Updated ${result.updated}`),
    app_move_node: (_args, result) => `Moved ${result.moved} → ${result.toParentId}`,
    app_remove_node: (_args, result) => `Removed ${result.removed}`,
    app_set_action: summariseSetAction,
    app_remove_action: (_args, result) => `Removed action ${result.removed}`,
    app_bind_action: summariseBindAction,
    app_get_draft: () => 'Read the current draft',
    app_get_node: (_args, result) => `Read ${countOf(result.nodes)} component(s)`,
    app_find_nodes: (_args, result) => `${result.hitCount ?? 0} match(es)${result.truncated ? ' (truncated)' : ''}`,
    app_list_automations: (_args, result) => `${countOf(result.automations)} automation(s) available`,
    app_inspect_automation: (args, result) => `Inspected ${result.automation?.title || args.automationId}`,
    app_upsert_table: (_args, result) => `Table "${result.key}" (${result.tableId}) — ${countOf(result.fields)} field(s), ${result.migration || 'saved'}`,
    app_link_datatable: summariseLinkedTable,
    app_set_plan: summarisePlan,
    app_remove_table: (_args, result) => `Removed table ${result.removed}${noteSuffix(result.note)}`,
    app_set_roles: (_args, result) => `Roles: ${Array.isArray(result.roles) ? result.roles.join(', ') : '?'}`,
    app_seed_records: (args, result) => `Inserted ${result.inserted ?? 0} row(s) into ${result.tableId || args.tableId}${Array.isArray(result.failed) ? `, ${result.failed.length} failed` : ''}`,
    app_upsert_dataset: (_args, result) => `Dataset "${result.name}" (${result.datasetId}) — ${result.rowCount ?? 0} preview row(s)`,
    app_get_data_model: () => 'Read the data model',
    app_list_connectors: (_args, result) => `${countOf(result.connectors)} connector(s) available`,
    app_list_assets: (_args, result) => `${countOf(result.assets)} uploaded file(s)`,
    app_query_data: (_args, result) => `${result.rowCount ?? 0} row(s)${result.more ? ' (more available)' : ''}`,
    app_dry_run: summariseDryRun,
    app_screenshot: summariseScreenshot,
    app_propose_plan: (_args, result) => `Proposed a build plan${result.planId ? ` (${result.planId})` : ''} — review and approve it to build`,
    app_mark_phase: (_args, result) => `Phase ${result.index ?? '?'}: ${result.label || ''}`,
    app_list_templates: (_args, result) => `${countOf(result.templates)} template(s) available`,
    app_apply_template: (args, result) => `Applied template ${result.templateId || args.templateId || '?'}`,
    app_finalize: (_args, result) => (result.finalized ? `App "${result.name}" is valid and saved` : 'Finalize blocked by validation errors'),
};

/**
 * One short human line per tool result: the error when the call failed, else
 * the tool's own line.
 * @param {string} name
 * @param {ToolArgs|null|undefined} args
 * @param {ToolResult|null|undefined} result
 * @returns {string}
 */
function summariseToolResult(name, args, result) {
    if (result && typeof result === 'object' && result.error) return cap(result.error);
    if (!Object.hasOwn(SUMMARISERS, name)) return '';
    return cap(SUMMARISERS[name](args ?? {}, result ?? /** @type {ToolResult} */ ({})));
}

module.exports = { summariseToolResult };
