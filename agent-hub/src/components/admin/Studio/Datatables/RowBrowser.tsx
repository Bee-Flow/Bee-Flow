import { Loader2 } from 'lucide-react';
import { gradeAtLeast, isSourceMirror, sourceNameOf, sourceWritable } from './datatableDisplay';
import ImportPanel from './ImportPanel';
import RowFilterBuilder from './RowFilterBuilder';
import AddRowForm from './rowBrowser/AddRowForm';
import type { DtMirror, DtTable, RowFilter } from './rowBrowser/rowBrowserModel';
import { rowsApi } from './rowBrowser/rowBrowserModel';
import { RowDeleteDialogs, RowNotices, RowPager } from './rowBrowser/RowFooter';
import RowsTable from './rowBrowser/RowsTable';
import RowToolbar from './rowBrowser/RowToolbar';
import { useRowPages } from './rowBrowser/useRowPages';
import { useRowWrites } from './rowBrowser/useRowWrites';
import useTranslation from '@/hooks/useTranslation';

/**
 * The rows, as they actually are — and editable (Datatables artboard 1e).
 *
 * This exists because an automation that writes to a table is otherwise
 * writing into the dark: the run summary says "3 rows added" and there is
 * nowhere to go and look. Being able to SEE the rows is what makes a
 * datatable step debuggable, and it is why this tab loads live data rather
 * than a sample.
 *
 * ── THE CELL EDITORS ARE APP STUDIO'S ───────────────────────────────
 * `AppStudio/tables/RowCellEditor` and `rowValues` are already pure and already
 * type the nine column types correctly. The hand-rolled form this replaced
 * typed THREE of them: a multiselect became the literal string 'a, b' in a JSON
 * column, a datetime was free text against TIMESTAMPTZ (an opaque 500), a
 * cleared number sent '' into NUMERIC (another 500), and an unticked checkbox
 * never entered `values` at all — so the column was NULL and the grid showed
 * '—' where the person had said No.
 *
 * ── EVERY READ IS STILL SERVER-SCOPED ───────────────────────────────
 * The filter, the sort and the search here are a CLOSED DESCRIPTOR the server
 * resolves against the table's own declared columns; it ANDs the access
 * predicate in regardless, so nothing here can widen what comes back. There is
 * no way to express SQL from this surface and there is no escape hatch that
 * could grow into one.
 *
 * ── TWO WAYS THROUGH THE ROWS, AND THEY ARE DIFFERENT QUESTIONS ─────
 * "Load more" GROWS the window you are reading; the ‹ › pager MOVES it a page
 * at a time in both directions (rowBrowser/useRowPages). The writes live in
 * rowBrowser/useRowWrites.
 */
export interface RowBrowserProps {
    table: DtTable;
    onChanged?: (() => void) | null;
    mirror?: DtMirror | null;
    reloadKey?: unknown;
    /**
     * Conditions in force from the first read ([{field, op, value}]) — the
     * answers dashboard opens "all responses" narrowed to one question this
     * way. Remount (a `key`) to change them.
     */
    initialFilters?: RowFilter[] | null;
    /**
     * 'card' (default) keeps the toolbar, a bordered card and the pager inside
     * whatever column the caller lays out — the answers dashboard's "every
     * response" section. 'page' is the Rows tab of the table page (Ronde 2,
     * 2b): a 44px toolbar bar, the table edge to edge on the card colour, and
     * a 40px footer bar with the count and the pager.
     */
    layout?: 'card' | 'page';
}

export default function RowBrowser({ table, onChanged, mirror = null, reloadKey = null, initialFilters = null, layout = 'card' }: RowBrowserProps) {
    const fullPage = layout === 'page';
    const { t } = useTranslation();
    const pages = useRowPages(table, t, initialFilters, reloadKey);

    // A mirror — of a Nextcloud table, or of a sheet in a spreadsheet file:
    // writes go to the source first, and the person should see that they are
    // waiting on the source, not on us. A file the server cannot write back
    // (an .xls, a file the linker does not own) is READ here: no Add, no
    // Import, no Edit, no Delete — the row would have nowhere to go.
    const isMirror = isSourceMirror(table);
    const writable = !isMirror || sourceWritable(table, mirror?.source);
    const canWrite = gradeAtLeast(table.grade, 'editor') && writable;
    const sourceName = isMirror ? sourceNameOf(table, mirror?.source) : '';
    const writes = useRowWrites({ table, t, pages, isMirror, onChanged });
    const retention = table.retentionDays && table.retentionField
        ? { retentionDays: table.retentionDays, retentionField: table.retentionField }
        : null;

    const { rows, columns, applied, activeFilters } = pages;
    if (rows === null) {
        return (
            <div className="py-8 flex justify-center text-[var(--text-tertiary)]">
                <Loader2 className="w-5 h-5 animate-spin" aria-hidden="true" />
                <span className="sr-only">{t('datatables.loading', 'Loading…')}</span>
            </div>
        );
    }
    const emptyClass = `text-sm ${fullPage ? 'px-4 py-4' : ''}`;

    return (
        <div className={fullPage ? 'flex-1 min-h-0 flex flex-col' : 'space-y-3'} data-layout={layout}>
            <RowToolbar pages={pages} writes={writes} table={table} mirror={mirror} isMirror={isMirror}
                sourceName={sourceName} canWrite={canWrite} fullPage={fullPage} />

            <div className={fullPage ? 'px-4 flex flex-col gap-3 shrink-0' : 'contents'}>
            {pages.filterOpen && (
                <RowFilterBuilder
                    t={t}
                    columns={columns}
                    rows={pages.filterRows}
                    match={pages.match}
                    onRows={pages.setFilterRows}
                    onMatch={pages.setMatch}
                    onApply={pages.applyFilters}
                    onClear={pages.clearFilters}
                    appliedCount={activeFilters.length}
                />
            )}

            <RowNotices pages={pages} writes={writes} canWrite={canWrite} />

            {writes.importing && (
                <ImportPanel
                    columns={columns}
                    onImport={(values: unknown) => rowsApi.bulkImport(table.id, values)}
                    onDone={writes.afterWrite}
                    onClose={() => writes.setImporting(false)}
                />
            )}

            {writes.adding && (
                <AddRowForm
                    columns={columns}
                    onCancel={() => writes.setAdding(false)}
                    requiredHint={isMirror ? t('datatables.src_required', 'required in {source}', { source: sourceName }) : null}
                    onAdd={writes.addRow}
                />
            )}
            </div>

            {columns.length === 0 ? (
                <p className={emptyClass} style={{ color: 'var(--text-secondary)' }}>
                    {t('datatables.rows_no_columns', 'This table has no columns yet — add some on the Columns tab first.')}
                </p>
            ) : rows.length === 0 ? (
                <p className={emptyClass} style={{ color: 'var(--text-secondary)' }}>
                    {applied || activeFilters.length
                        ? t('datatables.rows_no_match', 'No rows match that search.')
                        : t('datatables.rows_empty', 'No rows yet. An automation with a Datatable step writing to this table will fill it, or you can add one here.')}
                </p>
            ) : (
                <RowsTable pages={pages} writes={writes} table={table} mirror={mirror} canWrite={canWrite}
                    fullPage={fullPage} retention={retention} />
            )}

            {rows.length > 0 && <RowPager pages={pages} fullPage={fullPage} />}

            <RowDeleteDialogs pages={pages} writes={writes} />
        </div>
    );
}
