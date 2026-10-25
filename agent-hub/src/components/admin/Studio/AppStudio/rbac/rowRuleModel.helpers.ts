import type { ExprNode } from './rowFilterSubset';
import type { AccessEntry, AccessPerm, RuleCondition } from './rowRuleModel.types';
import type { TranslateFn, TranslateParams } from '../../../../../hooks/useTranslation';
import { READ_WRITE_SCOPES } from './rowRuleModel.constants';

/**
 * Translate with `t` when the caller has one; otherwise the English default
 * (tests and non-React callers), interpolated the same way.
 */
export const tr = (t: TranslateFn | null | undefined, key: string, en: string, params?: TranslateParams) => (t
    ? t(key, en, params)
    : en.replace(/\{(\w+)\}/g, (m: string, k: string) => (params && k in params ? String(params[k]) : m)));

export function normalizePerm(value: AccessPerm, action: string): AccessPerm {
    if (action === 'create') return value === true || value === 'all' || value === 'own';
    if (READ_WRITE_SCOPES.includes(value)) return value;
    if (value === true) return 'all';
    if (value === false) return 'none';
    return 'none';
}

export function defaultPerm(mode: string | undefined, action: string): AccessPerm {
    switch (mode) {
        case 'app': return action === 'create' ? true : 'all';
        case 'owner': return action === 'create' ? true : 'own';
        default: return action === 'create' ? false : 'none';
    }
}

function quote(s: unknown) {
    return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function serializeValue(condition: RuleCondition) {
    if (condition.source && condition.source !== 'value') return condition.source;
    if (condition.valueType === 'bool') {
        return (condition.value === true || condition.value === 'true') ? 'true' : 'false';
    }
    if (condition.valueType === 'number') {
        const n = Number(condition.value);
        return (condition.value !== '' && Number.isFinite(n) && n >= 0) ? String(n) : null;
    }
    const s = String(condition.value ?? '');
    return s === '' ? null : quote(s);
}

export function flattenLogic(node: ExprNode | undefined, ops: Set<string>, out: Array<ExprNode | undefined>) {
    if (node && node.kind === 'binop' && (node.op === '&&' || node.op === '||')) {
        ops.add(node.op);
        flattenLogic(node.a, ops, out);
        flattenLogic(node.b, ops, out);
        return;
    }
    out.push(node);
}

// A two-segment path → { root, leaf }, or null for anything else.
export function readPath(node: ExprNode | null | undefined) {
    if (!node || node.kind !== 'path') return null;
    const segs = node.segments;
    if (!Array.isArray(segs) || segs.length !== 2) return null;
    if (segs[0].kind !== 'name' || segs[1].kind !== 'name') return null;
    return { root: segs[0].v, leaf: segs[1].v };
}

export function readLiteral(node: ExprNode | null | undefined) {
    if (!node || typeof node !== 'object') return null;
    if (node.kind === 'str') return { value: node.v, valueType: 'string' };
    if (node.kind === 'num') return { value: String(node.v), valueType: 'number' };
    if (node.kind === 'bool') return { value: node.v ? 'true' : 'false', valueType: 'bool' };
    return null;
}

function joinAnd(parts: string[], t: TranslateFn | null) {
    if (parts.length <= 1) return parts[0] || '';
    return tr(t, 'studio_apps_edit.row_rule.list_and', '{head}, and {last}', { head: parts.slice(0, -1).join(', '), last: parts[parts.length - 1] });
}

function joinOr(parts: string[], t: TranslateFn | null) {
    if (parts.length <= 1) return parts[0] || '';
    return tr(t, 'studio_apps_edit.row_rule.list_or', '{head} or {last}', { head: parts.slice(0, -1).join(', '), last: parts[parts.length - 1] });
}

const rowsOf = (scope: AccessPerm, t: TranslateFn | null) => (scope === 'own'
    ? tr(t, 'studio_apps_edit.row_rule.rows_added', 'the rows they added')
    : tr(t, 'studio_apps_edit.row_rule.rows_visible', 'every row they can see'));

/** The adding, changing and deleting an access entry hands out, in one sentence. */
export function describeWrites(entry: AccessEntry, t: TranslateFn | null) {
    const edits = entry.update !== 'none';
    const deletes = entry.delete !== 'none';

    const can: string[] = [];
    if (entry.create) can.push(tr(t, 'studio_apps_edit.row_rule.can_add', 'add new rows'));
    if (edits && deletes && entry.update === entry.delete) can.push(tr(t, 'studio_apps_edit.row_rule.can_change_delete', 'change or delete {rows}', { rows: rowsOf(entry.update, t) }));
    else {
        if (edits) can.push(tr(t, 'studio_apps_edit.row_rule.can_change', 'change {rows}', { rows: rowsOf(entry.update, t) }));
        if (deletes) can.push(tr(t, 'studio_apps_edit.row_rule.can_delete', 'delete {rows}', { rows: rowsOf(entry.delete, t) }));
    }

    const missing: string[] = [];
    if (!entry.create) missing.push(tr(t, 'studio_apps_edit.row_rule.verb_add', 'add'));
    if (!edits) missing.push(tr(t, 'studio_apps_edit.row_rule.verb_change', 'change'));
    if (!deletes) missing.push(tr(t, 'studio_apps_edit.row_rule.verb_delete', 'delete'));

    if (!can.length) return tr(t, 'studio_apps_edit.row_rule.writes_look_only', 'They cannot {missing} anything — they can only look.', { missing: joinOr(missing, t) });
    const allowed = joinAnd(can, t);
    return missing.length
        ? tr(t, 'studio_apps_edit.row_rule.writes_some', 'They can {allowed}, but cannot {missing} anything.', { allowed, missing: joinOr(missing, t) })
        : tr(t, 'studio_apps_edit.row_rule.writes_all', 'They can {allowed}.', { allowed });
}

// Adding is gated on its own, so a role that sees nothing can still be allowed
// to add rows it will never be able to open again.
export function describeNoRows(entry: AccessEntry, roleLabel: string, tableName: string, t: TranslateFn | null): { sees: string; writes: string | null } {
    if (entry.create) {
        return {
            sees: tr(t, 'studio_apps_edit.row_rule.none_can_add', '{role} sees no rows in {table} at all. A row rule changes nothing here.', { role: roleLabel, table: tableName }),
            writes: tr(t, 'studio_apps_edit.row_rule.none_writes', 'They can still add new rows, but never see them afterwards.'),
        };
    }
    return {
        sees: tr(t, 'studio_apps_edit.row_rule.none_cannot_add', '{role} sees no rows in {table} at all, and cannot add any. A row rule changes nothing here.', { role: roleLabel, table: tableName }),
        writes: null,
    };
}
