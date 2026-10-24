import { useMemo, useState } from 'react';
import type { DtColumn } from './rowBrowserModel';
import { RowCellEditor } from './typedViews';
import useTranslation from '../../../../../hooks/useTranslation';
import { PRIMARY_ACTION_STYLE } from '../../../../shared/StudioSectionHeader';
import { columnKeyTitle, columnLabel } from '../datatableDisplay';

interface AddRowFormProps {
    columns: DtColumn[];
    onCancel: () => void;
    onAdd: (values: Record<string, unknown>) => void;
    /** "required in {source}" beside a required column of a mirror. */
    requiredHint?: string | null;
}

/**
 * A new row, typed by its columns.
 *
 * `values` is seeded from the columns rather than left empty: an unticked
 * checkbox that never enters the object writes NULL, and the grid then shows
 * '—' where the person said No.
 */
export default function AddRowForm({ columns: allColumns, onCancel, onAdd, requiredHint = null }: AddRowFormProps) {
    const { t } = useTranslation();
    // A derived column (a mirror's relation or its label) is the engine's to
    // fill; offering it here would be a field the server refuses.
    const columns = useMemo(() => allColumns.filter(c => !c.derived && c.type !== 'relation'), [allColumns]);
    const seed = useMemo(() => {
        const out: Record<string, unknown> = {};
        for (const c of columns) if (c.type === 'bool') out[c.key] = false;
        return out;
    }, [columns]);
    // Seeded once, at mount. The columns cannot change while this form is open
    // — the schema is loaded with the page — so re-seeding on every change
    // would only be a way to throw away what the person has typed.
    const [values, setValues] = useState(seed);

    return (
        <form
            className="p-3 space-y-2 [border-radius:12px] [background:var(--bg-card)] [border:1px_solid_var(--border-default)] [box-shadow:var(--shadow-sm)]"
            onSubmit={(e) => { e.preventDefault(); onAdd(values); }}
        >
            {columns.map(c => (
                <label key={c.key} className="block">
                    <span className="block text-[11px] mb-0.5 text-[var(--text-secondary)]">
                        <span title={columnKeyTitle(c)}>{columnLabel(c)}</span>
                        {c.required && requiredHint ? <span className="text-[var(--text-tertiary)]">{' · '}{requiredHint}</span> : null}
                    </span>
                    <RowCellEditor
                        field={c}
                        value={values[c.key]}
                        live
                        onCommit={(v: unknown) => setValues(cur => ({ ...cur, [c.key]: v }))}
                    />
                </label>
            ))}
            <div className="flex gap-2 pt-1">
                <button type="submit"
                    className="px-3 py-1.5 rounded-[10px] text-sm font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                    style={{ ...PRIMARY_ACTION_STYLE, outlineColor: 'var(--accent-primary)' }}>
                    {t('datatables.add_row_submit', 'Add row')}
                </button>
                <button type="button" onClick={onCancel}
                    className="px-3 py-1.5 rounded-[10px] text-sm border focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 [border-color:var(--border-default)] [color:var(--text-secondary)]! [outline-color:var(--accent-primary)]!">
                    {t('datatables.cancel', 'Cancel')}
                </button>
            </div>
        </form>
    );
}
