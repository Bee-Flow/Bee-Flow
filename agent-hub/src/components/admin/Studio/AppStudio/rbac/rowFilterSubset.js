import { parseExpr } from '@shared/expr/engine.mjs';

/**
 * App Studio RBAC — client mirror of the server's row-filter subset validator.
 *
 * A row filter (access.rowFilters[role]) is the ONLY free-form expression a
 * data model carries, so the RLS gateway (server/appStudio/rlsGateway.js) only
 * accepts a small, safe subset before it becomes parameterised SQL:
 *
 *   comparisons  == === != !== < <= > >=
 *   logic        && ||
 *   unary        !
 *   operands     record.<field> · viewer.<attr> · string/number/bool literal
 *
 * Everything else — function calls, arithmetic (+ - * / %), ternaries, null,
 * bracket/computed access, unknown roots — is rejected. This validator walks the
 * SAME shared-expr AST the gateway parses (byte-identical engine) so the editor
 * can flag an out-of-subset rule BEFORE the owner saves and eats a 422. It is a
 * pre-flight aid, not the enforcement point.
 */

// Mirrors dataModel.SYSTEM_COLUMNS — always addressable as record.<col>.
const SYSTEM_COLUMNS = ['id', 'created_at', 'updated_at', 'created_by', 'org_id'];
const CMP = new Set(['==', '===', '!=', '!==', '<', '<=', '>', '>=']);
const LOGIC = new Set(['&&', '||']);

/**
 * Translate with `t` when the caller has one; otherwise the English default
 * (tests and non-React callers), interpolated the same way.
 */
const tr = (t, key, en, params) => (t
    ? t(key, en, params)
    : en.replace(/\{(\w+)\}/g, (m, k) => (params && k in params ? String(params[k]) : m)));

function fieldKeySet(table) {
    const set = new Set(SYSTEM_COLUMNS);
    const fields = Array.isArray(table?.fields) ? table.fields : [];
    for (const f of fields) {
        if (!f || typeof f.key !== 'string') continue;
        // Read-time computed fields have no physical column — the gateway rejects them.
        if (f.type === 'computed' && !(f.computed && f.computed.stored === true)) continue;
        set.add(f.key);
    }
    return set;
}

function checkPath(node, fieldKeys, t) {
    const segs = node.segments;
    if (!Array.isArray(segs) || segs.length !== 2) {
        throw new Error(tr(t, 'studio_apps_edit.row_filter.path_shape', 'Write record.<column> for the row, or viewer.id / viewer.role / viewer.organizationId for the person opening the app.'));
    }
    const [root, leaf] = segs;
    if (root.kind !== 'name' || leaf.kind !== 'name') {
        throw new Error(tr(t, 'studio_apps_edit.row_filter.plain_names', 'A row rule can only use plain names like record.status — no [brackets].'));
    }
    if (root.v === 'record') {
        if (!fieldKeys.has(leaf.v)) throw new Error(tr(t, 'studio_apps_edit.row_filter.no_column', 'This table has no column called "{name}".', { name: leaf.v }));
        return;
    }
    if (root.v === 'viewer') return; // viewer.<attr> — bound at query time
    throw new Error(tr(t, 'studio_apps_edit.row_filter.unknown_root', 'There is nothing called "{name}" here — a row rule can only use record.<column> and viewer.<attribute>.', { name: root.v }));
}

function checkOperand(node, fieldKeys, t) {
    if (!node || typeof node !== 'object') throw new Error(tr(t, 'studio_apps_edit.row_filter.operand_missing', 'Something is missing on one side of a comparison.'));
    switch (node.kind) {
        case 'num':
        case 'str':
        case 'bool':
            return;
        case 'path':
            return checkPath(node, fieldKeys, t);
        default:
            throw new Error(tr(t, 'studio_apps_edit.row_filter.kind_not_value', 'A {kind} is not allowed as a value here.', { kind: describeKind(node.kind, t) }));
    }
}

function checkNode(node, fieldKeys, t) {
    if (!node || typeof node !== 'object') throw new Error(tr(t, 'studio_apps_edit.row_filter.rule_empty', 'This rule is empty.'));
    switch (node.kind) {
        case 'binop':
            if (LOGIC.has(node.op)) {
                checkNode(node.a, fieldKeys, t);
                checkNode(node.b, fieldKeys, t);
                return;
            }
            if (CMP.has(node.op)) {
                checkOperand(node.a, fieldKeys, t);
                checkOperand(node.b, fieldKeys, t);
                return;
            }
            throw new Error(tr(t, 'studio_apps_edit.row_filter.operator_not_allowed', 'Operator "{op}" is not allowed in a row rule.', { op: node.op }));
        case 'unop':
            if (node.op === '!') { checkNode(node.a, fieldKeys, t); return; }
            throw new Error(tr(t, 'studio_apps_edit.row_filter.unary_not_allowed', 'Unary "{op}" is not allowed in a row rule.', { op: node.op }));
        case 'path':
        case 'num':
        case 'str':
        case 'bool':
            return checkOperand(node, fieldKeys, t);
        default:
            throw new Error(tr(t, 'studio_apps_edit.row_filter.kind_not_allowed', 'A {kind} is not allowed in a row rule.', { kind: describeKind(node.kind, t) }));
    }
}

function describeKind(kind, t) {
    switch (kind) {
        case 'call': return tr(t, 'studio_apps_edit.row_filter.kind_call', 'function call');
        case 'ternary': return tr(t, 'studio_apps_edit.row_filter.kind_ternary', 'conditional (a ? b : c)');
        case 'index': return tr(t, 'studio_apps_edit.row_filter.kind_index', 'bracket access');
        case 'null': return tr(t, 'studio_apps_edit.row_filter.kind_null', 'null literal');
        default: return tr(t, 'studio_apps_edit.row_filter.kind_other', '{kind} expression', { kind });
    }
}

/**
 * Validate a row-filter expression string against the supported subset.
 * @param {string} expr the raw expression (empty = "no rule", always valid)
 * @param {object} [table] the data-model table (for record.<field> resolution)
 * @returns {{ ok: boolean, error: string|null }}
 */
export function validateRowFilterExpr(expr, table, t = null) {
    const src = String(expr ?? '').trim();
    if (!src) return { ok: true, error: null };
    let ast;
    try {
        ast = parseExpr(src);
    } catch (e) {
        return { ok: false, error: tr(t, 'studio_apps_edit.row_filter.unreadable', 'This rule could not be read — {detail}', { detail: e?.message || tr(t, 'studio_apps_edit.row_filter.unreadable_hint', 'check the spelling and the brackets.') }) };
    }
    try {
        checkNode(ast, fieldKeySet(table), t);
        return { ok: true, error: null };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

export default validateRowFilterExpr;
