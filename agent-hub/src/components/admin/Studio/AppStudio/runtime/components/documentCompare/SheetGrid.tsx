// A spreadsheet tab, read-only: the computed values on the A1 grid, with the
// column letters and row numbers a person expects. Large tabs show their first
// MAX_GRID_ROWS rows and say how many more there are.

import useTranslation from '../../../../../../../hooks/useTranslation';

const MAX_GRID_ROWS = 500;
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
const CELL = /^([A-Z])([1-9][0-9]{0,4})$/;

/** The used extent of a tab: the last column and row with anything in them. */
export function gridExtent(display: Record<string, string>): { cols: string[]; rows: number } {
    let col = -1;
    let rows = 0;
    for (const [name, value] of Object.entries(display)) {
        const m = CELL.exec(name);
        if (!m || value === '') continue;
        col = Math.max(col, LETTERS.indexOf(m[1]));
        rows = Math.max(rows, Number(m[2]));
    }
    return { cols: LETTERS.slice(0, col + 1), rows };
}

const HEAD = 'sticky top-0 z-10 border-b border-r border-[var(--border-default)] bg-[var(--bg-secondary)] px-2 py-1 text-left text-[11px] font-medium text-[var(--text-secondary)]';
const ROW_HEAD = 'sticky left-0 border-b border-r border-[var(--border-default)] bg-[var(--bg-secondary)] px-2 py-1 text-right text-[11px] tabular-nums text-[var(--text-secondary)]';
const CELL_CLASS = 'max-w-[16rem] truncate border-b border-r border-[var(--border-subtle)] px-2 py-1 text-[12px]';

export default function SheetGrid({ display, label }: { display: Record<string, string>; label: string }) {
    const { t } = useTranslation();
    const { cols, rows } = gridExtent(display);
    if (!rows) return <p className="m-0 p-6 text-center text-sm text-[var(--text-muted)]">{t('studio_app_documents.sheet_empty', 'This tab is empty.')}</p>;
    const shown = Math.min(rows, MAX_GRID_ROWS);
    return (
        <div className="min-h-0 flex-1 overflow-auto">
            <table className="border-separate border-spacing-0" aria-label={label}>
                <thead>
                    <tr>
                        <th className={HEAD} scope="col"><span className="sr-only">{t('studio_app_documents.row', 'Row')}</span></th>
                        {cols.map((c) => <th key={c} className={HEAD} scope="col">{c}</th>)}
                    </tr>
                </thead>
                <tbody>
                    {Array.from({ length: shown }, (_, i) => i + 1).map((r) => (
                        <tr key={r}>
                            <th className={ROW_HEAD} scope="row">{r}</th>
                            {cols.map((c) => <td key={c} className={CELL_CLASS} title={display[`${c}${r}`] || undefined}>{display[`${c}${r}`] || ''}</td>)}
                        </tr>
                    ))}
                </tbody>
            </table>
            {rows > shown ? (
                <p className="m-0 p-2 text-xs text-[var(--text-muted)]">{t('studio_app_documents.more_rows', '{n} more rows are not shown.', { n: rows - shown })}</p>
            ) : null}
        </div>
    );
}
