/**
 * The plain-language notes under one rule row (the web's rowHints in
 * mapping/ConditionBuilderRow.tsx), pure:
 *   - R9: a list of records compared with a test that never matches a list;
 *   - R12: a field the sample data does not have, so the rule matches nothing;
 *   - a list path outside a quantifier, in list mode.
 * Each note is said only when the sample can tell; nothing is guessed.
 */

import type { TranslateFn } from '@/core/i18n';
import { labelFor, type ConditionRow, type ValueType } from '@/features/flow-editor/model';
import { fieldShape, formatPath, getList, getPath, parsePath } from '@/shared/expr';

import { readsListAsValue } from './conditionState';
import { fieldNameOf } from './routeSourceEdits';

/** The tests a list of records can answer: is there one, is there none. */
const LIST_TESTS = new Set(['isEmpty', 'isNotEmpty', 'truthy']);

const refPath = (row: ConditionRow): string => {
    const f = row.field;
    return f && typeof f === 'object' && f.kind === 'ref' ? String(f.path || '') : '';
};

/** The key a path ends in, as written (`frm` for `item.frm`); '' for an index or a match. */
function endKey(path: string): string {
    const tokens = parsePath(path) || [];
    const last = tokens.at(-1);
    return last && last.type === 'prop' && typeof last.key === 'string' ? last.key : '';
}

const isRecord = (v: unknown): boolean => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * The name of a field the sample has room for but not the field itself:
 * a plain path whose parent object exists without it, or a column no record
 * of its (non-empty) list carries. Null when the sample cannot tell.
 */
export function absentFieldName(path: string, sample: unknown): string | null {
    if (sample == null || !path) return null;
    const shape = fieldShape(path);
    if (shape?.kind === 'column') return absentColumn(shape, sample);
    if (shape?.kind !== 'plain') return null;
    const tokens = parsePath(shape.path);
    if (!tokens || tokens.length < 2) return null;
    if (!isRecord(getPath(sample, formatPath(tokens.slice(0, -1))))) return null;
    return getPath(sample, shape.path) === undefined ? endKey(shape.path) || null : null;
}

/** A column none of the records of its (non-empty) list carries; read as the run reads lists. */
function absentColumn(shape: { path: string; list: string }, sample: unknown): string | null {
    const entries = getList(sample, shape.list);
    if (!entries?.some(isRecord)) return null;
    const values = getPath(sample, shape.path);
    return Array.isArray(values) && values.length > 0 ? null : endKey(shape.path) || null;
}

export interface RowHintInput {
    row: ConditionRow;
    type: ValueType;
    sampleRoot: unknown;
    /** 'filter' (each item) or 'condition' (the whole run). */
    context: 'filter' | 'condition';
    /** The option label of a picked field, when the menu knows it. */
    label?: string | null;
}

/** The notes under a row, in words, in the order the row reads. */
export function ruleRowHints({ row, type, sampleRoot, context, label = null }: RowHintInput, t: TranslateFn): string[] {
    const path = refPath(row);
    const out: string[] = [];
    if (path && type === 'records' && !LIST_TESTS.has(row.op)) {
        const list = label || fieldNameOf(path, t);
        out.push(
            t('condition_node.hint.records_op', '{list} is a list, so “{op}” never matches it. Pick a field under {list} instead, for example File type.', {
                list,
                op: labelFor(row.op, type, t),
            }),
        );
    }
    const absent = absentFieldName(path, sampleRoot);
    if (absent) out.push(t('condition_node.hint.field_missing', 'There is no “{field}” in the sample data, so this rule would match nothing.', { field: absent }));
    if (context === 'filter' && readsListAsValue(row)) {
        out.push(t('condition_node.hint.list_field', 'This field holds a list. Pick it from the field menu to check any, every or no item of it.'));
    }
    return out;
}
