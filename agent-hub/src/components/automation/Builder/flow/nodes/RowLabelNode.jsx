import React from 'react';
import useTranslation from '../../../../../hooks/useTranslation';

/**
 * "Row 1 · steps 1–5" — the gutter label above a wrapped row (design 1a).
 *
 * Synthetic and canvas-only: derived from node positions by
 * flow/useRenderedGraph.js through flow/rowBands.js, never written to the
 * definition, and stripped from every operation that expects a step (it is
 * not selectable, draggable, connectable or deletable). It pans and zooms
 * with the canvas because it IS a node — a `<Panel>` would stay pinned to
 * the viewport and drift away from the row it names.
 */
export default function RowLabelNode({ data }) {
    const { t } = useTranslation();
    const index = data?.index;
    const first = data?.first;
    const last = data?.last;
    let range = null;
    if (first != null && last != null) {
        range = first === last
            ? t('routines.canvas.row_step', 'step {n}', { n: first })
            : t('routines.canvas.row_steps', 'steps {first}–{last}', { first, last });
    }
    return (
        <div className="flex items-baseline gap-2 pointer-events-none select-none whitespace-nowrap" data-testid="row-label">
            <span className="text-[10px] font-semibold uppercase tracking-[.08em] text-[var(--text-tertiary)]">
                {t('routines.canvas.row_label', 'Row {n}', { n: index })}
            </span>
            {range && <span className="text-[11px] text-[var(--text-tertiary)]">{range}</span>}
        </div>
    );
}
