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
    app_find_nodes: 'Search draft',
    app_inspect_catalog: 'Read catalog',
    app_list_automations: 'List routines',
    app_inspect_automation: 'Inspect routine',
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
    app_dry_run: 'Dry-run app',
    app_screenshot: 'Screenshot',
    app_propose_plan: 'Propose a plan',
    app_mark_phase: 'Start phase',
    app_list_templates: 'List templates',
    app_apply_template: 'Apply template',
    app_finalize: 'Finalize app',
};

function labelForTool(name) {
    return TOOL_LABELS[name] || name;
}

// tool_call payload caps — the arguments of a 40-entry app_add_components
// batch are ~10 KB; anything above is a preview, and the base64 screenshot
// side channel never leaves the server this way.
const TOOL_CALL_PAYLOAD_CHARS = 8_000;

/** What a successful call LANDED, typed, for the activity rows and ghost clearing. */
function addedOf(name, args, result, draftWrap) {
    if (!result || typeof result !== 'object' || result.error) return [];
    const def = draftWrap && draftWrap.def;
    const labelOfNode = (id) => {
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
                .map((a) => ({ id: a.id, type: a.type || null, label: labelOfNode(a.id) }));
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

/** The tool_call SSE payload: the legacy line plus the typed, bounded detail. */
function toolCallEvent(name, args, result, ok, draftWrap) {
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
        // on a side channel that must stay server-side (see summariseToolResult).
        const { _screenshotDataUrl, _screenshotCaption, ...rest } = result;
        void _screenshotDataUrl; void _screenshotCaption;
        payload.result = truncateJson(rest, TOOL_CALL_PAYLOAD_CHARS);
    } else {
        payload.result = truncateJson(result, TOOL_CALL_PAYLOAD_CHARS);
    }
    return payload;
}

/** One short human line per tool result — feeds the tool_call SSE event. */
function summariseToolResult(name, args, result) {
    const cap = (s) => {
        const str = String(s || '').replace(/\s+/g, ' ').trim();
        return str.length > 140 ? `${str.slice(0, 140)}…` : str;
    };
    if (result && typeof result === 'object' && result.error) return cap(result.error);
    switch (name) {
        case 'app_set_meta': return cap(`App is now "${result?.meta?.name || args?.name || 'Untitled app'}"`);
        case 'app_set_theme': return 'Theme updated';
        case 'app_add_screen': return cap(`Added screen "${args?.name || 'Screen'}" (${result?.screenId})`);
        case 'app_update_screen': return cap(`Updated screen ${args?.screenId}`);
        case 'app_remove_screen': return cap(`Removed screen ${result?.removed}`);
        case 'app_add_section': return cap(`Added section ${result?.sectionId}`);
        case 'app_update_section': return cap(`Restyled section ${result?.sectionId}`);
        case 'app_add_components': return cap(`Added ${Array.isArray(result?.added) ? result.added.length : 0} component(s)`);
        // The three patch tools take a single form OR a batch, and the batch
        // result carries { batch:true, applied } instead of the single form's
        // per-call args. Reading args.* on a batch printed "undefined → …" in
        // the user's transcript, so the batch shape gets its own line rather
        // than a template that only happens to work one way round.
        case 'app_update_component':
            return cap(result?.batch ? `Updated ${result.applied} component(s)` : `Updated ${result?.updated}`);
        case 'app_move_node': return cap(`Moved ${result?.moved} → ${result?.toParentId}`);
        case 'app_remove_node': return cap(`Removed ${result?.removed}`);
        case 'app_set_action':
            return cap(result?.batch
                ? `Configured ${result.applied} action(s)`
                : `${result?.created ? 'Created' : 'Updated'} action ${result?.actionId} (${args?.action?.kind || '?'})`);
        case 'app_remove_action': return cap(`Removed action ${result?.removed}`);
        case 'app_bind_action':
            if (result?.batch) return cap(`Wired ${result.applied} handler(s)`);
            return cap(args?.actionId === null ? `Cleared ${args?.event} on ${args?.nodeId}` : `${args?.event} → ${result?.actionId}`);
        case 'app_get_draft': return 'Read the current draft';
        case 'app_find_nodes': return cap(`${result?.hitCount ?? 0} match(es)${result?.truncated ? ' (truncated)' : ''}`);
        case 'app_list_automations': return cap(`${Array.isArray(result?.automations) ? result.automations.length : 0} routine(s) available`);
        case 'app_inspect_automation': return cap(`Inspected ${result?.automation?.title || args?.automationId}`);
        case 'app_upsert_table': return cap(`Table "${result?.key}" (${result?.tableId}) — ${Array.isArray(result?.fields) ? result.fields.length : 0} field(s), ${result?.migration || 'saved'}`);
        case 'app_link_datatable': {
            const t = result?.table || {};
            const l = t.linked || {};
            return cap(`Linked "${t.name || t.key || '?'}" (${t.id || '?'})${l.kind ? ` — ${l.kind === 'nextcloud' ? 'Nextcloud mirror' : 'Studio table'}` : ''}${l.mode ? `, ${l.mode === 'read' ? 'read-only' : 'read-write'}` : ''}${Number.isFinite(l.rowCount) ? `, ${l.rowCount} live row${l.rowCount === 1 ? '' : 's'}` : ''}${result?.note ? ` — ${result.note}` : ''}`);
        }
        case 'app_set_plan': {
            const todos = Array.isArray(result?.todos) ? result.todos : [];
            const done = todos.filter((t) => t && t.done).length;
            return cap(todos.length ? `Plan ${done}/${todos.length}${result?.next ? ` · next: ${result.next}` : ''}` : 'Plan cleared');
        }
        case 'app_remove_table': return cap(`Removed table ${result?.removed}${result?.note ? ` — ${result.note}` : ''}`);
        case 'app_set_roles': return cap(`Roles: ${Array.isArray(result?.roles) ? result.roles.join(', ') : '?'}`);
        case 'app_seed_records': return cap(`Inserted ${result?.inserted ?? 0} row(s) into ${result?.tableId || args?.tableId}${Array.isArray(result?.failed) ? `, ${result.failed.length} failed` : ''}`);
        case 'app_upsert_dataset': return cap(`Dataset "${result?.name}" (${result?.datasetId}) — ${result?.rowCount ?? 0} preview row(s)`);
        case 'app_get_data_model': return 'Read the data model';
        case 'app_list_connectors': return cap(`${Array.isArray(result?.connectors) ? result.connectors.length : 0} connector(s) available`);
        case 'app_query_data': return cap(`${result?.rowCount ?? 0} row(s)${result?.more ? ' (more available)' : ''}`);
        case 'app_dry_run': {
            const errCount = Array.isArray(result?.static?.errors) ? result.static.errors.length : 0;
            const empties = Array.isArray(result?.emptyTables) ? result.emptyTables.length : 0;
            if (result?.ok) return cap(`Dry-run clean${empties ? ` (${empties} empty table binding${empties === 1 ? '' : 's'})` : ''}`);
            return cap(`Dry-run found ${errCount} error${errCount === 1 ? '' : 's'}${empties ? `, ${empties} empty binding${empties === 1 ? '' : 's'}` : ''} — fix before finalize`);
        }
        // NEVER reach into other fields here — the success result carries the
        // full base64 data url on a side channel and must not leak into cap().
        case 'app_screenshot': return cap(result?._screenshotDataUrl ? (result._screenshotCaption || 'Screenshot captured') : (result?.content || ''));
        case 'app_propose_plan': return cap(`Proposed a build plan${result?.planId ? ` (${result.planId})` : ''} — review and approve it to build`);
        case 'app_mark_phase': return cap(`Phase ${result?.index ?? '?'}: ${result?.label || ''}`);
        case 'app_list_templates': return cap(`${Array.isArray(result?.templates) ? result.templates.length : 0} template(s) available`);
        case 'app_apply_template': return cap(`Applied template ${result?.templateId || args?.templateId || '?'}`);
        case 'app_finalize': return result?.finalized ? cap(`App "${result.name}" is valid and saved`) : 'Finalize blocked by validation errors';
        default: return '';
    }
}

module.exports = {
    TOOL_LABELS,
    labelForTool,
    TOOL_CALL_PAYLOAD_CHARS,
    addedOf,
    toolCallEvent,
    summariseToolResult,
};
