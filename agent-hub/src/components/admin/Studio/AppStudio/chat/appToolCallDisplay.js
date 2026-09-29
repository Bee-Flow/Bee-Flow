/**
 * One App Studio builder tool call → the row the chat's activity timeline
 * shows for it — the sibling of automation/Builder/chat/toolCallDisplay.js.
 *
 * The pane used to render a flat chip per call from a bare-English
 * TOOL_LABELS table and the server's pre-rendered `summary`. Everything the
 * row needs is on the call now: the server's `tool_call` carries `added`
 * ([{ id, type, label }] — what LANDED, typed, in the order it landed),
 * `error` and `hint` for a refusal, and the bounded `arguments`/`result` for
 * the details view.
 *
 * Every verb is keyed rather than written bare — the i18n guard's helper scan
 * (i18nGuard.test.js check 8) hunts exactly the bare-English table this
 * replaces, and keys mean the row answers in Dutch with the rest of the pane.
 */

import { getComponentEntry } from '../runtime/componentRegistry';

/** Past tense, product wording — the same convention as the routine builder's VERBS. */
export const VERBS = {
    app_set_meta: { key: 'app_studio.builder.act.set_meta', en: 'Named the app' },
    app_set_theme: { key: 'app_studio.builder.act.set_theme', en: 'Picked the look' },
    app_set_nav_groups: { key: 'app_studio.builder.act.set_nav_groups', en: 'Regrouped the menu' },
    app_add_screen: { key: 'app_studio.builder.act.add_screen', en: 'Added a screen' },
    app_update_screen: { key: 'app_studio.builder.act.update_screen', en: 'Adjusted a screen' },
    app_remove_screen: { key: 'app_studio.builder.act.remove_screen', en: 'Removed a screen' },
    app_add_section: { key: 'app_studio.builder.act.add_section', en: 'Added a section' },
    app_update_section: { key: 'app_studio.builder.act.update_section', en: 'Restyled a section' },
    app_add_components: { key: 'app_studio.builder.act.add_components', en: 'Added {n} components' },
    app_update_component: { key: 'app_studio.builder.act.update_component', en: 'Adjusted a component' },
    app_move_node: { key: 'app_studio.builder.act.move_node', en: 'Rearranged the layout' },
    app_remove_node: { key: 'app_studio.builder.act.remove_node', en: 'Removed a component' },
    app_set_action: { key: 'app_studio.builder.act.set_action', en: 'Configured an action' },
    app_remove_action: { key: 'app_studio.builder.act.remove_action', en: 'Removed an action' },
    app_bind_action: { key: 'app_studio.builder.act.bind_action', en: 'Wired a control' },
    app_set_variables: { key: 'app_studio.builder.act.set_variables', en: 'Declared variables' },
    app_set_public_access: { key: 'app_studio.builder.act.set_public_access', en: 'Set public access' },
    app_upsert_table: { key: 'app_studio.builder.act.upsert_table', en: 'Created a table' },
    app_link_datatable: { key: 'app_studio.builder.act.link_datatable', en: 'Linked a table' },
    app_remove_table: { key: 'app_studio.builder.act.remove_table', en: 'Removed a table' },
    app_set_roles: { key: 'app_studio.builder.act.set_roles', en: 'Set up roles' },
    app_seed_records: { key: 'app_studio.builder.act.seed_records', en: 'Added sample rows' },
    app_upsert_dataset: { key: 'app_studio.builder.act.upsert_dataset', en: 'Created a dataset' },
    app_get_data_model: { key: 'app_studio.builder.act.get_data_model', en: 'Read the data model' },
    app_query_data: { key: 'app_studio.builder.act.query_data', en: 'Looked at the data' },
    app_list_connectors: { key: 'app_studio.builder.act.list_connectors', en: 'Listed the connectors' },
    app_dry_run: { key: 'app_studio.builder.act.dry_run', en: 'Checked the data' },
    app_screenshot: { key: 'app_studio.builder.act.screenshot', en: 'Took a screenshot' },
    app_get_draft: { key: 'app_studio.builder.act.get_draft', en: 'Re-read the app' },
    app_find_nodes: { key: 'app_studio.builder.act.find_nodes', en: 'Searched the app' },
    app_list_automations: { key: 'app_studio.builder.act.list_automations', en: 'Looked up the routines' },
    app_inspect_automation: { key: 'app_studio.builder.act.inspect_automation', en: 'Inspected a routine' },
    app_propose_plan: { key: 'app_studio.builder.act.propose_plan', en: 'Proposed a plan' },
    app_set_plan: { key: 'app_studio.builder.act.set_plan', en: 'Updated the plan' },
    app_mark_phase: { key: 'app_studio.builder.act.mark_phase', en: 'Started a phase' },
    app_list_templates: { key: 'app_studio.builder.act.list_templates', en: 'Listed the templates' },
    app_apply_template: { key: 'app_studio.builder.act.apply_template', en: 'Applied a template' },
    app_save_as_template: { key: 'app_studio.builder.act.save_as_template', en: 'Saved as a template' },
    app_finalize: { key: 'app_studio.builder.act.finalize', en: 'Checked and saved the app' },
};

const ONE_COMPONENT = { key: 'app_studio.builder.act.add_component_one', en: 'Added 1 component' };
const REFUSED = { key: 'app_studio.builder.act.refused', en: 'Not applied' };

const str = (v) => (typeof v === 'string' && v ? v : null);
const tr = (t, { key, en }, params) => (t ? t(key, en, params) : (params ? en.replace(/\{(\w+)\}/g, (_, k) => (params[k] !== undefined ? String(params[k]) : `{${k}}`)) : en));

/** A readable name for a landed thing: the component type's label, "Screen", "Table", "Action". */
export function landedTypeLabel(type, t) {
    const ty = str(type);
    if (!ty) return '';
    if (ty === 'screen') return tr(t, { key: 'app_studio.builder.act.kind_screen', en: 'Screen' });
    if (ty === 'table') return tr(t, { key: 'app_studio.builder.act.kind_table', en: 'Table' });
    if (ty === 'action') return tr(t, { key: 'app_studio.builder.act.kind_action', en: 'Action' });
    const entry = getComponentEntry(ty);
    return (entry && entry.label) || ty.replace(/_/g, ' ');
}

/** The lucide icon for a landed thing (a component type's palette icon), or null. */
export function landedIcon(type) {
    const entry = getComponentEntry(str(type));
    return entry ? entry.icon || null : null;
}

/**
 * @returns {{ status:'ok'|'failed', title:string, detail:string|null, added:Array<{id,type,label,title}>, error:string|null, hint:string|null }}
 */
export function describeAppToolCall(tc, t = null) {
    const name = str(tc && tc.name) || '';
    const failed = tc && tc.ok === false;
    const added = (Array.isArray(tc && tc.added) ? tc.added : [])
        .filter((a) => a && typeof a === 'object')
        .map((a) => ({ id: a.id ?? null, type: str(a.type), label: str(a.label), title: str(a.label) || landedTypeLabel(a.type, t) }));
    let title;
    if (failed) {
        title = tr(t, REFUSED);
    } else if (name === 'app_add_components') {
        title = added.length === 1 ? tr(t, ONE_COMPONENT) : tr(t, VERBS.app_add_components, { n: added.length || '' });
        if (!added.length) title = tr(t, { key: 'app_studio.builder.act.add_components_some', en: 'Added components' });
    } else {
        const verb = VERBS[name];
        title = verb ? tr(t, verb) : (name.replace(/^app_/, '').replace(/_/g, ' ') || tr(t, { key: 'app_studio.builder.act.tool', en: 'Tool call' }));
    }
    // The detail line: what landed, by name; a refusal's error; else the
    // server's one-line summary (the legacy field).
    let detail = null;
    if (failed) detail = str(tc.error) || str(tc.summary);
    else if (added.length === 1 && name !== 'app_add_components') detail = added[0].title;
    else if (added.length > 1) detail = added.map((a) => a.title).filter(Boolean).join(' · ');
    else detail = str(tc && tc.summary);
    return {
        status: failed ? 'failed' : 'ok',
        title,
        detail,
        added,
        error: failed ? (str(tc.error) || null) : null,
        hint: failed ? (str(tc.hint) || null) : null,
        verbLabel: VERBS[name] ? tr(t, VERBS[name], { n: added.length }) : null,
    };
}

/** The payload behind "details": the call's own arguments and result, already bounded by the server. */
export function appDetailPayload(tc) {
    const parse = (v) => { if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return v; } };
    return { args: parse(tc && tc.arguments), result: parse(tc && tc.result) };
}
