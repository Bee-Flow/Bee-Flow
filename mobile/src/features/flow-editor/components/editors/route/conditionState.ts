/**
 * The clickable condition builder's state, pure — the web's ConditionBuilder
 * (Builder/mapping/ConditionBuilder.jsx) before it touches the screen: an
 * expression opens as rows when the row model can say it, as raw text when it
 * cannot (mixed AND/OR, grammar the rows do not have), and a bare
 * `true`/`false` — what a fresh condition starts with — opens as one blank
 * row rather than as raw text.
 */

import { bindingFromInput, isDataPath, walkPath } from '@/features/flow-editor/bindings';
import { emptyRow, inferType, parseExprToRows, type Binding, type ConditionRow, type ValueType } from '@/features/flow-editor/model';
import { renderBindingValue } from '@/features/flow-editor/model/route/bindingText';

export interface ConditionState {
    rows: ConditionRow[];
    join: '&&' | '||';
    raw: boolean;
}

/** "Not configured yet", not a condition. */
export function isTrivialValue(value: unknown): boolean {
    return /^(true|false)$/.test(String(value ?? '').trim());
}

export function conditionState(value: string): ConditionState {
    const trivial = isTrivialValue(value);
    const parsed = trivial ? null : parseExprToRows(value);
    return {
        rows: parsed?.rows?.length ? parsed.rows : [emptyRow()],
        join: parsed?.join || '&&',
        raw: !!value && !trivial && !parsed,
    };
}

/** Can this expression be shown as rows at all? */
export function canUseVisual(value: string): boolean {
    return !value || !!parseExprToRows(value);
}

/** A row's left-hand side as text: the path, or the expression. */
export function fieldText(row: ConditionRow): string {
    const f = row.field;
    if (!f || typeof f !== 'object') return '';
    if (f.kind === 'ref') return String(f.path || '');
    if (f.kind === 'expr') return String(f.value || '');
    return '';
}

/**
 * A row's field written as an expression — what "Use an expression instead"
 * edits: a reference as its bare path, an expression as itself, and fixed
 * text quoted, because in an expression that is what fixed text is. An empty
 * field is empty, not `""`.
 */
export function fieldAsExpression(field: ConditionRow['field']): string {
    if (!field) return '';
    if (typeof field !== 'object') return String(field);
    if (field.kind === 'literal' && (field.value === '' || field.value == null)) return '';
    return renderBindingValue(field);
}

/**
 * What a field typed as an expression means. A path is a reference — also
 * under `item` and `_index`, the roots a per-item rule is written in, which
 * the web's bindingFromInput does not know — and anything else an
 * expression. Never fixed text: a path saved as the words
 * "steps.x.output.total" compares a constant and silently never matches.
 * Empty is the blank row's empty reference, so an unfinished row is dropped.
 */
export function fieldFromExpression(text: string): Binding {
    const typed = text.trim();
    if (!typed) return { kind: 'ref', path: '' };
    if (isDataPath(typed)) return { kind: 'ref', path: typed };
    return bindingFromInput(typed, 'expression');
}

/** The row's field datatype, from the sample it resolves to. */
export function rowType(row: ConditionRow, sampleRoot: unknown): ValueType {
    const f = row.field;
    const path = f && typeof f === 'object' && f.kind === 'ref' ? String(f.path || '') : '';
    return path && sampleRoot ? inferType(walkPath(path, sampleRoot)) : 'unknown';
}

/** A list path (`[*]`) compared as a whole: worth a warning, except for "has a value". */
export function hasWildcard(rows: readonly ConditionRow[]): boolean {
    return rows.some((r) => r.op !== 'truthy' && fieldText(r).includes('[*]'));
}

/** Rows with one removed; never none — the last row empties instead. */
export function withoutRow(rows: readonly ConditionRow[], i: number): ConditionRow[] {
    const next = rows.filter((_, k) => k !== i);
    return next.length ? next : [emptyRow()];
}
