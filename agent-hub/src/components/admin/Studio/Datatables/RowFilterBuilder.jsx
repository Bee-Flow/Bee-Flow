import { Plus, X } from 'lucide-react';
import React from 'react';
import { ColumnKindIcon } from './ColumnKind';
import { columnLabel, columnTypeKind, filterDescriptor, opTakesList, opTakesNoValue, opsForColumn } from './datatableDisplay';
import { PRIMARY_ACTION_STYLE } from '../../../shared/StudioSectionHeader';

/**
 * The row filter (Datatables artboard 1e, the "Filter" control).
 *
 * ── IT IS A PICKER OVER A CLOSED DESCRIPTOR, NOT A QUERY BOX ────────
 * Every part of a condition is CHOSEN from something the table itself
 * declares: the field from the schema's own column list (plus the system
 * columns the server also allows), the operator from `FILTER_OPS`, and
 * `match` from all/any. Nothing here is typed except the VALUE, which the
 * server binds as a parameter. There is no free-text field that reaches a
 * compiler, and there is no escape hatch that could grow into one — the
 * server re-checks the field name and the operator by name anyway and
 * refuses an unknown one (`unknown_filter_field` / `unknown_filter_op`),
 * ANDing its own access predicate in regardless.
 *
 * ── A HALF-TYPED CONDITION IS NOT SENT ──────────────────────────────
 * `filterEntry` drops a row with no value on an operator that needs one.
 * Sending it would be `field = ''`, which comes back as zero rows and reads
 * as "nothing matches" rather than "you have not finished" — the difference
 * between an answer and a bug report.
 *
 * Controlled: the caller owns `rows` (the draft) and decides when to apply,
 * because applying is a fetch.
 */
export default function RowFilterBuilder({
    t, columns, rows, match, onRows, onMatch, onApply, onClear, appliedCount = 0,
}) {
    const fields = usableFields(t, columns);
    const set = (i, patch) => onRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
    const addRow = () => onRows([...rows, { field: fields[0]?.key || '', op: 'eq', value: '' }]);
    const ready = filterDescriptor(rows).length;

    return (
        <div className="p-3 space-y-2" style={{
            borderRadius: 12, background: 'var(--bg-card)',
            border: '1px solid var(--border-default)', boxShadow: 'var(--shadow-sm)',
        }}>
            <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--text-secondary)' }}>
                <span>{t('datatables.filter_rows_that', 'Show rows that match')}</span>
                <select
                    value={match}
                    onChange={(e) => onMatch(e.target.value)}
                    aria-label={t('datatables.filter_match', 'Match all or any condition')}
                    className={SELECT}
                    style={CONTROL_STYLE}
                >
                    <option value="all">{t('datatables.filter_all', 'all conditions')}</option>
                    <option value="any">{t('datatables.filter_any', 'any condition')}</option>
                </select>
            </div>

            {rows.length === 0 && (
                <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                    {t('datatables.filter_empty', 'No conditions yet.')}
                </p>
            )}

            {rows.map((row, i) => {
                const column = fields.find(f => f.key === row.field) || null;
                const ops = opsForColumn(column);
                const op = ops.includes(row.op) ? row.op : ops[0];
                return (
                    <div key={i} className="flex flex-wrap items-center gap-2">
                        <select
                            value={row.field}
                            aria-label={t('datatables.filter_field', 'Column to filter on')}
                            onChange={(e) => {
                                const next = fields.find(f => f.key === e.target.value) || null;
                                const nextOps = opsForColumn(next);
                                set(i, { field: e.target.value, op: nextOps.includes(row.op) ? row.op : nextOps[0], value: '' });
                            }}
                            className={SELECT}
                            style={CONTROL_STYLE}
                        >
                            {fields.map(f => <option key={f.key} value={f.key}>{f.label}</option>)}
                        </select>
                        <ColumnKindIcon kind={columnTypeKind(column?.type)} size={13}
                            style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
                        <select
                            value={op}
                            aria-label={t('datatables.filter_test', 'Test to apply')}
                            onChange={(e) => set(i, { op: e.target.value, value: '' })}
                            className={SELECT}
                            style={CONTROL_STYLE}
                        >
                            {ops.map(o => <option key={o} value={o}>{opWord(t, o)}</option>)}
                        </select>
                        {!opTakesNoValue(op) && (
                            <input
                                value={row.value ?? ''}
                                aria-label={t('datatables.filter_value', 'Value to compare with')}
                                placeholder={opTakesList(op)
                                    ? t('datatables.filter_value_list', 'value, value')
                                    : t('datatables.filter_value_one', 'value')}
                                onChange={(e) => set(i, { value: e.target.value })}
                                className="px-2 py-1 rounded text-xs border flex-1 min-w-[8rem] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1"
                                style={CONTROL_STYLE}
                            />
                        )}
                        <button
                            type="button"
                            onClick={() => onRows(rows.filter((_, j) => j !== i))}
                            aria-label={t('datatables.filter_remove', 'Remove this condition')}
                            className="p-1 rounded shrink-0 focus-visible:outline focus-visible:outline-2"
                            style={{ color: 'var(--text-tertiary)', outlineColor: 'var(--accent-primary)' }}
                        >
                            <X className="w-3.5 h-3.5" aria-hidden="true" />
                        </button>
                    </div>
                );
            })}

            <div className="flex items-center gap-2 pt-1">
                <button
                    type="button"
                    onClick={addRow}
                    disabled={!fields.length}
                    className="text-xs inline-flex items-center gap-1.5 rounded disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                    style={{ color: 'var(--text-secondary)', outlineColor: 'var(--accent-primary)' }}
                >
                    <Plus className="w-3.5 h-3.5" aria-hidden="true" /> {t('datatables.filter_add', 'Add a condition')}
                </button>
                <span className="flex-1" />
                {(appliedCount > 0 || rows.length > 0) && (
                    <button type="button" onClick={onClear}
                        className="text-xs px-2.5 py-1.5 rounded-lg border focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                        style={{ borderColor: 'var(--border-default)', color: 'var(--text-secondary)', outlineColor: 'var(--accent-primary)' }}>
                        {t('datatables.filter_clear', 'Clear')}
                    </button>
                )}
                <button
                    type="button"
                    onClick={onApply}
                    className="text-xs px-2.5 py-1.5 rounded-lg font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                    style={{ ...PRIMARY_ACTION_STYLE, outlineColor: 'var(--accent-primary)' }}
                >
                    {ready
                        ? t('datatables.filter_apply_n', 'Apply {n} conditions', { n: ready })
                        : t('datatables.filter_apply', 'Apply')}
                </button>
            </div>
        </div>
    );
}

const SELECT = 'px-2 py-1 rounded text-xs border focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1';
const CONTROL_STYLE = {
    background: 'var(--bg-primary)', borderColor: 'var(--border-default)',
    color: 'var(--text-primary)', outlineColor: 'var(--accent-primary)',
};

/**
 * The table's own columns, plus the two system dates the server's
 * `filterableKeys` also accepts and a person actually wants ("added before
 * …"). `id`, `created_by` and `org_id` are filterable server-side too but
 * are opaque identifiers, so offering them would be a dropdown of things
 * nobody can fill in.
 */
function usableFields(t, columns) {
    const own = (columns || []).filter(c => c && c.key).map(c => ({
        key: c.key, label: columnLabel(c), type: c.type, options: c.options,
    }));
    return [
        ...own,
        { key: 'created_at', label: t('datatables.col_added', 'Added'), type: 'datetime' },
        { key: 'updated_at', label: t('datatables.col_changed', 'Changed'), type: 'datetime' },
    ];
}

/** Each operator as a phrase, so the row reads as a sentence. */
export function opWord(t, op) {
    switch (op) {
        case 'eq': return t('datatables.op_eq', 'is');
        case 'neq': return t('datatables.op_neq', 'is not');
        case 'gt': return t('datatables.op_gt', 'is more than');
        case 'gte': return t('datatables.op_gte', 'is at least');
        case 'lt': return t('datatables.op_lt', 'is less than');
        case 'lte': return t('datatables.op_lte', 'is at most');
        case 'contains': return t('datatables.op_contains', 'contains');
        case 'notContains': return t('datatables.op_not_contains', 'does not contain');
        case 'startsWith': return t('datatables.op_starts_with', 'starts with');
        case 'endsWith': return t('datatables.op_ends_with', 'ends with');
        case 'in': return t('datatables.op_in', 'is one of');
        case 'notIn': return t('datatables.op_not_in', 'is none of');
        case 'between': return t('datatables.op_between', 'is between');
        case 'isNull': return t('datatables.op_is_null', 'is empty');
        case 'isNotNull': return t('datatables.op_is_not_null', 'is filled in');
        default: return op;
    }
}
