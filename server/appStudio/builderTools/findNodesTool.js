// @typecheck
/**
 * App Studio builder tool — app_find_nodes (read-only draft search), split out
 * of inspectionTools.js to keep that file under its size ceiling.
 */

'use strict';

const { COMPONENT_SPECS, COMPONENT_TYPES } = require('../componentSpecs');
const { nodeActionRefs } = require('../nodeActionRefs.mts');
const { callTargets } = require('../actionCalls.mts');
const { canonicalComponentType } = require('./componentAliases');

// ── app_find_nodes ───────────────────────────────────────────────────

const MAX_FIND_HITS = 60;

/**
 * The parts of a draft the search reads; any of them may be missing or malformed.
 * @typedef {{ id?: unknown, type?: string, props?: unknown, computed?: unknown, children?: unknown }} DraftNode
 * @typedef {{ id?: unknown, name?: unknown, sections?: Array<{ id?: unknown, children?: unknown[] } | null> }} DraftScreen
 * @typedef {{ screens?: Array<DraftScreen | null>, actions?: Record<string, { kind?: unknown } | null>, variables?: unknown }} DraftDef
 * @typedef {{ def?: DraftDef, dataModel?: { tables?: unknown } }} FindWrap
 *
 * @typedef {{ componentType: string, tableId: string, actionId: string, variable: string, screenId: string }} FindQuery
 * @typedef {{ kind: 'component', id: unknown, type: unknown, screenId: unknown, screenName: unknown, path: string, why: string }
 *   | { kind: 'action', id: string, type: unknown, why: string }} FindHit
 */

/** The hits, capped at MAX_FIND_HITS; a hit past the cap only sets `truncated`. */
class HitList {
    constructor() {
        /** @type {FindHit[]} */
        this.hits = [];
        this.truncated = false;
    }

    /** @param {FindHit} hit */
    push(hit) {
        if (this.hits.length >= MAX_FIND_HITS) { this.truncated = true; return; }
        this.hits.push(hit);
    }
}

/**
 * @typedef {{ q: FindQuery, tableRefs: Set<unknown>, bindingsByNode: Map<unknown, unknown[]>, actionIdNeedle: string, found: HitList }} FindCtx
 */

/** @param {Record<string, unknown> | null | undefined} args @param {string} key */
const trimmedArg = (args, key) => {
    const v = args?.[key];
    return typeof v === 'string' ? v.trim() : '';
};

/**
 * @param {Record<string, unknown> | null | undefined} args
 * @returns {FindQuery}
 */
function readFindQuery(args) {
    // Same reading as app_inspect_catalog: case-insensitive, "data grid" is data_grid.
    const rawType = trimmedArg(args, 'componentType');
    return {
        componentType: rawType ? (canonicalComponentType(rawType) || rawType) : '',
        tableId: trimmedArg(args, 'tableId'),
        actionId: trimmedArg(args, 'actionId'),
        variable: trimmedArg(args, 'variable'),
        screenId: trimmedArg(args, 'screenId'),
    };
}

/** @param {FindQuery} q */
function findQueryRefusal(q) {
    if (!q.componentType && !q.tableId && !q.actionId && !q.variable) {
        return {
            error: 'app_find_nodes needs at least one of componentType, tableId, actionId or variable.',
            _fixHint: 'Pass what you are looking for, e.g. { tableId: "tbl_x" } to find everything bound to that table.',
        };
    }
    if (q.componentType && !COMPONENT_SPECS[q.componentType]) {
        return {
            error: `Unknown component type "${q.componentType}".`,
            _fixHint: `Valid types: ${COMPONENT_TYPES.join(', ')}`,
        };
    }
    return null;
}

/**
 * The model's table, by tbl_ id or key: bindings carry the id, an action step
 * may carry either, so both count as a reference to the table. Without a data
 * model the id itself is the only reference.
 * @param {FindWrap} draftWrap
 * @param {string} tableId
 */
function resolveTable(draftWrap, tableId) {
    const tables = draftWrap.dataModel && Array.isArray(draftWrap.dataModel.tables) ? draftWrap.dataModel.tables : null;
    const table = tableId && tables ? tables.find((t) => t && (t.id === tableId || t.key === tableId)) : null;
    const tableRefs = new Set(table ? [table.id, table.key].filter(Boolean) : tableId ? [tableId] : []);
    return { tables, table, tableRefs };
}

/**
 * A component matches a table when ANY of its bindings names it; the binding
 * walker already handles nesting (a stat's value, a list's item source).
 * @param {DraftDef} def
 * @param {FindQuery} q
 * @param {Set<unknown>} tableRefs
 */
function bindingsByNodeOf(def, q, tableRefs) {
    /** @type {Map<unknown, unknown[]>} */
    const bindingsByNode = new Map();
    if (!q.tableId) return bindingsByNode;
    const { collectDataBindings } = require('../collectDataBindings');
    for (const { nodeId, prop, binding } of collectDataBindings(def, q.screenId || null)) {
        if (!nodeId || !tableRefs.has(binding?.tableId)) continue;
        if (!bindingsByNode.has(nodeId)) bindingsByNode.set(nodeId, []);
        /** @type {unknown[]} */ (bindingsByNode.get(nodeId)).push(prop);
    }
    return bindingsByNode;
}

/**
 * A variable is referenced as `vars.<name>` in formulas and templates,
 * wherever they sit on the node, so a raw scan of the node's own props is both
 * the simplest and the most complete test.
 * @param {DraftNode} node
 * @param {string} variable
 */
function nodeMentionsVariable(node, variable) {
    /** @type {string} */
    let json;
    try { json = JSON.stringify(node.props ?? {}); } catch { return false; }
    return json.includes(`vars.${variable}`);
}

/**
 * A component that only READS the action's result (an actionResult binding) does not run it.
 * @param {DraftNode} node
 * @param {string} actionIdNeedle
 */
function nodeReadsActionResult(node, actionIdNeedle) {
    /** @type {string} */
    let json;
    try { json = JSON.stringify({ props: node.props ?? {}, computed: node.computed ?? {} }); } catch { return false; }
    return json.includes(actionIdNeedle);
}

/**
 * Why a component matches, in a fixed order. Where the node RUNS the action (an
 * event, a row/toolbar/bulk/item action, a column, the add-row action) comes
 * from the validator's unreachable rule's reader, so the two cannot disagree.
 * @param {DraftNode} node
 * @param {FindCtx} ctx
 */
function nodeReasons(node, { q, bindingsByNode, actionIdNeedle }) {
    /** @type {string[]} */
    const reasons = [];
    if (q.componentType && node.type === q.componentType) reasons.push('type');
    if (q.tableId && bindingsByNode.has(node.id)) reasons.push(`bound via ${/** @type {unknown[]} */ (bindingsByNode.get(node.id)).join(', ')}`);
    if (q.actionId) {
        const places = nodeActionRefs(node).filter((r) => r.actionId === q.actionId).map((r) => r.via);
        if (places.length) reasons.push(`runs action (${places.join(', ')})`);
        else if (nodeReadsActionResult(node, actionIdNeedle)) reasons.push('reads its result');
    }
    if (q.variable && nodeMentionsVariable(node, q.variable)) reasons.push('reads variable');
    return reasons;
}

/**
 * @param {unknown} raw
 * @param {DraftScreen} screen
 * @param {unknown[]} path
 * @param {FindCtx} ctx
 */
function visitNode(raw, screen, path, ctx) {
    if (!raw || typeof raw !== 'object') return;
    const node = /** @type {DraftNode} */ (raw);
    const here = [...path, node.type || 'node'];
    const reasons = nodeReasons(node, ctx);
    if (reasons.length) {
        ctx.found.push({
            kind: 'component',
            id: node.id,
            type: node.type,
            screenId: screen.id,
            screenName: screen.name || screen.id,
            path: here.join(' > '),
            why: reasons.join('; '),
        });
    }
    for (const child of Array.isArray(node.children) ? node.children : []) visitNode(child, screen, here, ctx);
}

/** @param {DraftDef} def @param {FindCtx} ctx */
function walkScreens(def, ctx) {
    for (const screen of def.screens || []) {
        if (!screen || typeof screen !== 'object') continue;
        if (ctx.q.screenId && screen.id !== ctx.q.screenId) continue;
        for (const section of screen.sections || []) {
            for (const node of (section && section.children) || []) visitNode(node, screen, [section.id], ctx);
        }
    }
}

/**
 * Why an action matches. Actions are matched on their serialised form: a
 * step's tableId, a target variable and a nested action id all live in the
 * same object graph, and a structural walk per step kind would go stale the
 * moment a kind is added.
 * @param {string} id
 * @param {unknown} action
 * @param {string} json
 * @param {FindCtx} ctx
 */
function actionReasons(id, action, json, { q, tableRefs, actionIdNeedle }) {
    /** @type {string[]} */
    const reasons = [];
    if (q.tableId && [...tableRefs].some((ref) => json.includes(`"${ref}"`))) reasons.push('touches table');
    if (q.variable && (json.includes(`vars.${q.variable}`) || json.includes(`"${q.variable}"`))) reasons.push('reads/writes variable');
    if (q.actionId && id === q.actionId) reasons.push('is this action');
    else if (q.actionId && json.includes(actionIdNeedle)) {
        // A call_action names the step that runs it; anything else stays generic.
        const call = callTargets(action).find((t) => t.actionId === q.actionId);
        reasons.push(call ? `calls this action (${call.path})` : 'references this action');
    }
    return reasons;
}

/** @param {DraftDef} def @param {FindCtx} ctx */
function walkActions(def, ctx) {
    const { q } = ctx;
    if (!(q.tableId || q.variable || q.actionId)) return;
    for (const [id, action] of Object.entries(def.actions || {})) {
        /** @type {string} */
        let json;
        try { json = JSON.stringify(action ?? {}); } catch { continue; }
        const reasons = actionReasons(id, action, json, ctx);
        if (reasons.length) ctx.found.push({ kind: 'action', id, type: action?.kind || 'sequence', why: reasons.join('; ') });
    }
}

/**
 * "No hits" only means "unused" for an id that exists. A typo must not read as
 * a go-ahead to delete, so unknown ids get their own answer; no data model
 * loaded is "unknown" too.
 * @param {DraftDef} def
 * @param {FindQuery} q
 * @param {unknown[]|null} tables
 * @param {unknown} table
 */
function unknownIds(def, q, tables, table) {
    /** @type {string[]} */
    const unknown = [];
    if (q.tableId && !table) unknown.push(tables ? `tableId "${q.tableId}" is not a table of this app` : `tableId "${q.tableId}" could not be checked (the data model is not loaded)`);
    if (q.variable && !(Array.isArray(def.variables) && def.variables.some((v) => v && v.name === q.variable))) unknown.push(`variable "${q.variable}" is not declared in this app`);
    if (q.actionId && !(def.actions && Object.hasOwn(def.actions, q.actionId))) unknown.push(`actionId "${q.actionId}" is not an action of this app`);
    return unknown;
}

/**
 * An action nothing runs, calls or reads: only its own entry was found, for a
 * search on that action alone over the whole app.
 * @param {FindQuery} q
 * @param {string[]} unknown
 * @param {HitList} found
 */
function onlyItselfFound(q, unknown, found) {
    if (!q.actionId || q.screenId || q.componentType || q.tableId || q.variable) return false;
    if (unknown.length || found.truncated || !found.hits.length) return false;
    return found.hits.every((h) => h.kind === 'action' && h.id === q.actionId);
}

/**
 * @param {FindQuery} q
 * @param {string[]} unknown
 * @param {HitList} found
 */
function findNote(q, unknown, found) {
    // With the validator's name for an unreachable action.
    if (onlyItselfFound(q, unknown, found)) return `Nothing runs, calls or reads action "${q.actionId}" — it is unreachable (validator warning action.unreachable), so it is safe to remove.`;
    if (found.hits.length) return found.truncated ? `Showing the first ${MAX_FIND_HITS} matches — narrow the query with screenId.` : undefined;
    if (unknown.length) return `Nothing matches, and ${unknown.join('; ')}. Check the id; this is NOT a confirmation that anything is unused.`;
    return 'Nothing in the draft references it: unused, so it is safe to remove.';
}

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
    const q = readFindQuery(args);
    const refusal = findQueryRefusal(q);
    if (refusal) return refusal;
    const { tables, table, tableRefs } = resolveTable(draftWrap, q.tableId);
    const found = new HitList();
    /** @type {FindCtx} */
    const ctx = { q, tableRefs, bindingsByNode: bindingsByNodeOf(def, q, tableRefs), actionIdNeedle: `"actionId":${JSON.stringify(q.actionId)}`, found };
    walkScreens(def, ctx);
    walkActions(def, ctx);
    const note = findNote(q, unknownIds(def, q, tables, table), found);
    const { hits, truncated } = found;
    return { hits, hitCount: hits.length, ...(truncated ? { truncated: true } : {}), ...(note ? { note } : {}) };
}

module.exports = { applyFindNodes };
