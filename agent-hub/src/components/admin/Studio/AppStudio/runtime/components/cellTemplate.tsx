import { tryEvaluate } from '@shared/expr/engine.mjs';
import { useRuntime } from '../RuntimeContext';
import { EM_DASH, displayValue } from '../uiBits';
import type { CellColumn } from './cellValue.types';

/**
 * A table or data_grid cell whose column has `format: 'template'` (schema 3): the column's
 * `template` is a formula, evaluated per row with the row as `item` and the cell's own value as
 * `value`, and its result is written as plain text. Markup in the result is text like any other
 * cell's. A template that is missing, errors or answers nothing shows the muted dash of an empty
 * cell.
 */
export function TemplateCell({ col, row, value }: { col: CellColumn | null | undefined; row: unknown; value: unknown }) {
    const { scope } = useRuntime();
    const expr = typeof col?.template === 'string' ? col.template.trim() : '';
    const result = expr ? tryEvaluate(expr, { ...scope, item: row, value }) : null;
    const out = result && !result.error ? result.value : null;
    if (out == null || out === '') return <span className="[color:var(--text-muted)]" data-app-cell-empty="">{EM_DASH}</span>;
    return <span data-app-cell-template="">{displayValue(out)}</span>;
}
