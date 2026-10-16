// @typecheck
/**
 * App Studio builder tool — app_find_nodes (read-only draft search), split out
 * of inspectionTools.js to keep that file under its size ceiling.
 */

'use strict';

const { EVENT_NAMES, COMPONENT_SPECS, COMPONENT_TYPES } = require('../componentSpecs');
const { canonicalComponentType } = require('./componentAliases');

// ── app_find_nodes ───────────────────────────────────────────────────

const MAX_FIND_HITS = 60;

/**
 * Search the draft instead of reading all of it.
 *
 * The walks this exposes already existed server-side (collectDataBindings for
 * the binding side, collectVariableRefs for variables) — they were simply
 * unreachable from a tool, so the only way to answer "where is this table used"
 * was to pull a 500-node tree and eyeball it. That is what makes a builder
 * delete a table and leave four dangling bindings behind.
 *
 * Read-only and total: an unknown id yields `hits: []` plus a note, never an
 * error, so a speculative check costs nothing.
 */
function applyFindNodes(draftWrap, args = {}) {
    const def = draftWrap.def || {};
    // Same reading as app_inspect_catalog: case-insensitive, "data grid" is data_grid.
    const rawType = typeof args?.componentType === 'string' ? args.componentType.trim() : '';
    const componentType = rawType ? (canonicalComponentType(rawType) || rawType) : '';
    const tableId = typeof args?.tableId === 'string' ? args.tableId.trim() : '';
    const actionId = typeof args?.actionId === 'string' ? args.actionId.trim() : '';
    const variable = typeof args?.variable === 'string' ? args.variable.trim() : '';
    const screenId = typeof args?.screenId === 'string' ? args.screenId.trim() : '';

    if (!componentType && !tableId && !actionId && !variable) {
        return {
            error: 'app_find_nodes needs at least one of componentType, tableId, actionId or variable.',
            _fixHint: 'Pass what you are looking for, e.g. { tableId: "tbl_x" } to find everything bound to that table.',
        };
    }
    if (componentType && !COMPONENT_SPECS[componentType]) {
        return {
            error: `Unknown component type "${componentType}".`,
            _fixHint: `Valid types: ${COMPONENT_TYPES.join(', ')}`,
        };
    }

    // A component matches a table when ANY of its bindings names it; the binding
    // walker already handles nesting (a stat's value, a list's item source).
    // The model's table, by tbl_ id or key: bindings carry the id, an action
    // step may carry either, so both count as a reference to the table.
    const tables = draftWrap.dataModel && Array.isArray(draftWrap.dataModel.tables) ? draftWrap.dataModel.tables : null;
    const table = tableId && tables ? tables.find((t) => t && (t.id === tableId || t.key === tableId)) : null;
    const tableRefs = new Set(table ? [table.id, table.key].filter(Boolean) : tableId ? [tableId] : []);
    const bindingsByNode = new Map();
    if (tableId) {
        const { collectDataBindings } = require('../collectDataBindings');
        for (const { nodeId, prop, binding } of collectDataBindings(def, screenId || null)) {
            if (!nodeId || !tableRefs.has(binding?.tableId)) continue;
            if (!bindingsByNode.has(nodeId)) bindingsByNode.set(nodeId, []);
            bindingsByNode.get(nodeId).push(prop);
        }
    }

    const hits = [];
    let truncated = false;
    const push = (hit) => {
        if (hits.length >= MAX_FIND_HITS) { truncated = true; return; }
        hits.push(hit);
    };

    const nodeMentionsVariable = (node) => {
        if (!variable) return false;
        // A variable is referenced as `vars.<name>` in formulas and templates,
        // wherever they sit on the node — so a raw scan of the node's own props
        // is both the simplest and the most complete test.
        let json;
        try { json = JSON.stringify(node.props ?? {}); } catch { return false; }
        return json.includes(`vars.${variable}`);
    };
    const nodeRunsAction = (node) => {
        if (!actionId) return false;
        return EVENT_NAMES.some((ev) => node[ev] === actionId);
    };

    const visit = (node, screen, path) => {
        if (!node || typeof node !== 'object') return;
        const here = [...path, node.type || 'node'];
        const reasons = [];
        if (componentType && node.type === componentType) reasons.push('type');
        if (tableId && bindingsByNode.has(node.id)) reasons.push(`bound via ${bindingsByNode.get(node.id).join(', ')}`);
        if (actionId && nodeRunsAction(node)) reasons.push('runs action');
        if (variable && nodeMentionsVariable(node)) reasons.push('reads variable');
        if (reasons.length) {
            push({
                kind: 'component',
                id: node.id,
                type: node.type,
                screenId: screen.id,
                screenName: screen.name || screen.id,
                path: here.join(' > '),
                why: reasons.join('; '),
            });
        }
        for (const child of Array.isArray(node.children) ? node.children : []) visit(child, screen, here);
    };

    for (const screen of def.screens || []) {
        if (!screen || typeof screen !== 'object') continue;
        if (screenId && screen.id !== screenId) continue;
        for (const section of screen.sections || []) {
            for (const node of (section && section.children) || []) visit(node, screen, [section.id]);
        }
    }

    // Actions are matched on their serialised form: a step's tableId, a target
    // variable and a nested action id all live in the same object graph, and a
    // structural walk per step kind would go stale the moment a kind is added.
    if (tableId || variable || actionId) {
        for (const [id, action] of Object.entries(def.actions || {})) {
            let json;
            try { json = JSON.stringify(action ?? {}); } catch { continue; }
            const reasons = [];
            if (tableId && [...tableRefs].some((ref) => json.includes(`"${ref}"`))) reasons.push('touches table');
            if (variable && (json.includes(`vars.${variable}`) || json.includes(`"${variable}"`))) reasons.push('reads/writes variable');
            if (actionId && id === actionId) reasons.push('is this action');
            if (reasons.length) {
                push({ kind: 'action', id, type: action?.kind || 'sequence', why: reasons.join('; ') });
            }
        }
    }

    // "No hits" only means "unused" for an id that exists. A typo must not read
    // as a go-ahead to delete, so unknown ids get their own answer.
    const unknown = [];
    // No data model loaded is "unknown" too: never a go-ahead.
    if (tableId && !table) unknown.push(tables ? `tableId "${tableId}" is not a table of this app` : `tableId "${tableId}" could not be checked (the data model is not loaded)`);
    if (variable && !(Array.isArray(def.variables) && def.variables.some((v) => v && v.name === variable))) unknown.push(`variable "${variable}" is not declared in this app`);
    if (actionId && !(def.actions && Object.hasOwn(def.actions, actionId))) unknown.push(`actionId "${actionId}" is not an action of this app`);
    const note = hits.length
        ? (truncated ? `Showing the first ${MAX_FIND_HITS} matches — narrow the query with screenId.` : undefined)
        : unknown.length
            ? `Nothing matches, and ${unknown.join('; ')}. Check the id; this is NOT a confirmation that anything is unused.`
            : 'Nothing in the draft references it: unused, so it is safe to remove.';
    return { hits, hitCount: hits.length, ...(truncated ? { truncated: true } : {}), ...(note ? { note } : {}) };
}

module.exports = { applyFindNodes };
