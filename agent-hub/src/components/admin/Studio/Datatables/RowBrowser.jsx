import {
    Check, ChevronLeft, ChevronRight, ClipboardPaste, Download, Filter, Link2, Loader2,
    Pencil, Plus, RefreshCw, Search, Trash2, X,
} from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ColumnKindIcon } from './ColumnKind';
import {
    columnKeyTitle, columnLabel, columnTypeKind, filterDescriptor, gradeAtLeast, isSourceMirror, MANAGED_COLUMNS,
    rowExpiry, sourceErrorMessage, sourceNameOf, sourceWritable,
} from './datatableDisplay';
import { datatablesApi } from './datatablesApi';
import ImportPanel from './ImportPanel';
import RowFilterBuilder from './RowFilterBuilder';
import useRelativeTime from '../../../../hooks/useRelativeTime';
import useTranslation from '../../../../hooks/useTranslation';
import ConfirmDialog from '../../../shared/ConfirmDialog';
import { PRIMARY_ACTION_STYLE } from '../../../shared/StudioSectionHeader';
import RowCellEditor from '../AppStudio/tables/RowCellEditor';
// App Studio's formatter, not the local one: it takes the FIELD rather than a
// type string, so it can render a select's label and a multiselect's list.
import { cellText } from '../AppStudio/tables/rowValues';

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
 * "Load more" GROWS the window you are reading — the answer to "keep going,
 * I am scanning". The ‹ › pager MOVES it a page at a time in both
 * directions — the answer to "there are 412 of these and I want the next
 * fifty". Both ride the same keyset cursor: a `cursorStack` of the token each
 * visited page started at, so going back re-asks with a cursor rather than
 * an offset. That matters on a table two automations are writing to, where an
 * offset both skips and repeats rows between pages.
 */

const PAGE = 50;
/** The server's own cap on one bulk delete (413 `too_many_ids` above it). */
const BULK_DELETE_MAX = 200;

const LINK_BTN = 'text-xs inline-flex items-center gap-1.5 px-2 py-1.5 rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2';
const CHIP_BTN = 'text-xs inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2';
const ICON_BTN = 'p-1 rounded focus-visible:outline focus-visible:outline-2';
const SUBTLE = { color: 'var(--text-secondary)', outlineColor: 'var(--accent-primary)' };
const CHIP_STYLE = {
    background: 'var(--bg-card)', borderColor: 'var(--border-default)',
    color: 'var(--text-secondary)', outlineColor: 'var(--accent-primary)',
};

/** Columns a `?q=` search reaches, mirroring the server's SEARCHABLE_TYPES. */
const SEARCHABLE = new Set(['text', 'richtext', 'select', 'multiselect']);

// `initialFilters`: conditions in force from the first read ([{field, op,
// value}]) — the answers dashboard opens "all responses" narrowed to one
// question this way. Remount (a `key`) to change them.
// `layout`: 'card' (default) keeps the toolbar, a bordered card and the
// pager inside whatever column the caller lays out — the answers dashboard's
// "every response" section. 'page' is the Rows tab of the table page (Ronde 2,
// 2b): a 44px toolbar bar, the table edge to edge on the card colour, and a
// 40px footer bar with the count and the pager.
export default function RowBrowser({ table, onChanged, mirror = null, reloadKey = null, initialFilters = null, layout = 'card' }) {
    const fullPage = layout === 'page';
    const { t } = useTranslation();
    const rel = useRelativeTime();
    const [rows, setRows] = useState(null);
    const [columns, setColumns] = useState([]);
    const [hasMore, setHasMore] = useState(false);
    const [cursor, setCursor] = useState(null);
    const [total, setTotal] = useState(table.rowCount ?? 0);
    const [error, setError] = useState(null);
    const [busy, setBusy] = useState(false);
    const [adding, setAdding] = useState(false);
    const [importing, setImporting] = useState(false);
    const [editing, setEditing] = useState(null);      // rowId
    const [draft, setDraft] = useState({});
    const [pendingDelete, setPendingDelete] = useState(null);  // row
    const [pendingBulk, setPendingBulk] = useState(false);
    const [selected, setSelected] = useState(() => new Set());
    const [sort, setSort] = useState({ field: null, dir: 'desc' });
    const [query, setQuery] = useState('');
    const [applied, setApplied] = useState('');
    // The filter draft, and the descriptor actually in force. Two states,
    // because building a condition is not the same act as asking for it.
    const [filterOpen, setFilterOpen] = useState(false);
    const seeded = Array.isArray(initialFilters) ? initialFilters : [];
    const [filterRows, setFilterRows] = useState(seeded);
    const [match, setMatch] = useState('all');
    const [activeFilters, setActiveFilters] = useState(seeded);
    const [activeMatch, setActiveMatch] = useState('all');
    // The keyset token each visited page started at. [null] is page one.
    const [stack, setStack] = useState([null]);
    const [page, setPage] = useState(0);

    // A mirror — of a Nextcloud table, or of a sheet in a spreadsheet file:
    // writes go to the source first, and the person should see that they are
    // waiting on the source, not on us. A file the server cannot write back
    // (an .xls, a file the linker does not own) is READ here: no Add, no
    // Import, no Edit, no Delete — the row would have nowhere to go.
    const isMirror = isSourceMirror(table);
    const writable = !isMirror || sourceWritable(table, mirror?.source);
    const canWrite = gradeAtLeast(table.grade, 'editor') && writable;
    const sourceName = isMirror ? sourceNameOf(table, mirror?.source) : '';
    const [writing, setWriting] = useState(false);
    const searchable = useMemo(() => columns.some(c => SEARCHABLE.has(c.type)), [columns]);
    const filterKey = JSON.stringify(activeFilters);
    const startCursor = stack[page] ?? null;
    const retention = table.retentionDays && table.retentionField
        ? { retentionDays: table.retentionDays, retentionField: table.retentionField }
        : null;

    const load = useCallback(async () => {
        setBusy(true);
        setError(null);
        try {
            const [schema, pageBody] = await Promise.all([
                datatablesApi.getSchema(table.id),
                datatablesApi.listRows(table.id, {
                    limit: PAGE,
                    cursor: startCursor,
                    sort: sort.field || null,
                    dir: sort.field ? sort.dir : null,
                    q: applied || null,
                    filters: JSON.parse(filterKey),
                    match: activeMatch,
                }),
            ]);
            setColumns(schema.fields || []);
            setRows(pageBody.rows || []);
            setHasMore(!!pageBody.hasMore);
            setCursor(pageBody.nextCursor || null);
            setSelected(new Set());
            if (typeof pageBody.total === 'number') setTotal(pageBody.total);
        } catch (e) {
            setError(e.message || t('datatables.err_rows', 'Could not read the rows'));
            setRows([]);
        } finally {
            setBusy(false);
        }
    }, [table.id, sort.field, sort.dir, applied, filterKey, activeMatch, startCursor, t]);

    // `reloadKey` is the mirror's lastSyncAt: a refresh that finished while
    // this tab was open re-reads the page, so the rows shown are the rows.
    useEffect(() => { load(); }, [load, reloadKey]);

    /** Back to page one — what any change to WHAT is being asked for means. */
    const restart = useCallback(() => { setStack([null]); setPage(0); }, []);

    /** Another page, APPENDED — the cursor is keyset, so there is no overlap. */
    const loadMore = async () => {
        if (!cursor) return;
        setBusy(true);
        try {
            const body = await datatablesApi.listRows(table.id, {
                limit: PAGE,
                cursor,
                sort: sort.field || null,
                dir: sort.field ? sort.dir : null,
                q: applied || null,
                filters: activeFilters,
                match: activeMatch,
            });
            setRows(cur => [...(cur || []), ...(body.rows || [])]);
            setHasMore(!!body.hasMore);
            setCursor(body.nextCursor || null);
        } catch (e) {
            setError(e.message || t('datatables.err_next_page', 'Could not read the next page'));
        } finally {
            setBusy(false);
        }
    };

    /** The next page REPLACES the window; its start cursor joins the stack. */
    const goNext = () => {
        if (!cursor) return;
        setStack(s => [...s.slice(0, page + 1), cursor]);
        setPage(p => p + 1);
    };
    const goPrev = () => { if (page > 0) setPage(p => p - 1); };

    /**
     * A write happened. `onChanged` refreshes the table row in the list, which
     * carries `rowCount` — the number the destructive-column dialog prices an
     * irreversible decision on.
     */
    const afterWrite = async (body = null) => {
        await load();
        onChanged?.();
        // A write that RENUMBERED the rows (a row-number-keyed sheet after a
        // delete or a mid-sheet insert) moved every id below it. The page just
        // loaded already shows the new ids; a row still in edit would be
        // holding an id that now names its neighbour, so it is closed.
        if (body && body.renumbered === true) { setEditing(null); setDraft({}); }
    };

    const removeRow = async (row) => {
        setWriting(isMirror);
        try {
            const body = await datatablesApi.deleteRow(table.id, row.id);
            setPendingDelete(null);
            await afterWrite(body);
        } catch (e) {
            setPendingDelete(null);
            setError(sourceErrorMessage(t, e, table) || e.message || t('datatables.err_row_delete', 'Could not delete the row'));
        } finally {
            setWriting(false);
        }
    };

    /**
     * Everything ticked, in ONE request and ONE transaction.
     *
     * The answer's `deleted` is what Postgres actually removed after the
     * access predicate, which can be fewer than were asked for — a row a
     * colleague deleted a second ago, or one this account may not see. Say the
     * real number rather than the requested one; claiming a delete that did
     * not happen is worse than a smaller number.
     */
    const removeSelected = async () => {
        const ids = [...selected];
        setPendingBulk(false);
        if (!ids.length) return;
        setBusy(true);
        try {
            const body = await datatablesApi.bulkDeleteRows(table.id, ids);
            const deleted = Number(body?.deleted) || 0;
            // The refresh FIRST, the message after: load() clears the error as
            // it starts, so setting it before reloading wipes the very
            // sentence that explains what just happened.
            await afterWrite();
            if (deleted < ids.length) {
                setError(t('datatables.bulk_partial', 'Deleted {n} of {asked} rows — the rest were already gone.', { n: deleted, asked: ids.length }));
            }
        } catch (e) {
            setBusy(false);
            setError(e.code === 'too_many_ids'
                ? t('datatables.bulk_too_many', 'You can delete at most {limit} rows at a time.', { limit: e.body?.limit ?? BULK_DELETE_MAX })
                : (e.message || t('datatables.err_bulk_delete', 'Could not delete those rows')));
        }
    };

    const saveEdit = async (row) => {
        setWriting(isMirror);
        try {
            // The updated_at the row was READ with. Without it two colleagues
            // with this tab open silently overwrite each other; with it, the
            // second save comes back 409 and says so.
            const body = await datatablesApi.updateRow(table.id, row.id, draft, row.updated_at);
            setEditing(null);
            setDraft({});
            await afterWrite(body);
        } catch (e) {
            const conflict = e.code === 'row_conflict';
            // The refresh FIRST, the message after: load() clears the error as
            // it starts, so setting the message before reloading wipes the very
            // sentence that explains what just happened.
            if (conflict) { setEditing(null); setDraft({}); await load(); }
            // A source's refusal keeps the row IN EDIT with the draft: the
            // person fixes the value and saves again; nothing changed anywhere.
            // A `spreadsheet_conflict` (the file moved under the write) too —
            // the draft is the person's work, and the rows reload by
            // themselves when the pulse sees the version move.
            setError(conflict
                ? t('datatables.err_row_conflict', 'Someone else changed this row while you had it open — the list has been refreshed.')
                : (sourceErrorMessage(t, e, table) || e.message || t('datatables.err_row_save', 'Could not save the row')));
        } finally {
            setWriting(false);
        }
    };

    const exportCsv = async () => {
        try {
            const text = await datatablesApi.exportCsv(table.id);
            // A Blob and a revoked object URL, NEVER an <a href download>
            // pointing at the API: that link carries no auth header, and on
            // this stack a same-origin download navigates the SPA away from
            // itself (the automations library learned it the hard way).
            const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
            const a = document.createElement('a');
            a.href = url;
            a.download = `${table.key || 'datatable'}.csv`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
        } catch (e) {
            setError(e.message || t('datatables.err_export', 'Could not export the rows'));
        }
    };

    const toggleSort = (key) => {
        restart();
        setSort(cur => (cur.field === key
            ? { field: key, dir: cur.dir === 'asc' ? 'desc' : 'asc' }
            : { field: key, dir: 'asc' }));
    };

    const applyFilters = () => {
        restart();
        setActiveFilters(filterDescriptor(filterRows));
        setActiveMatch(match);
    };
    const clearFilters = () => {
        restart();
        setFilterRows([]);
        setActiveFilters([]);
        setActiveMatch('all');
    };

    const toggleRow = (id) => setSelected((cur) => {
        const next = new Set(cur);
        if (next.has(id)) next.delete(id); else next.add(id);
        return next;
    });
    const allShownSelected = !!rows?.length && rows.every(r => selected.has(r.id));
    const toggleAll = () => setSelected(allShownSelected ? new Set() : new Set((rows || []).map(r => r.id)));

    if (rows === null) {
        return (
            <div className="py-8 flex justify-center" style={{ color: 'var(--text-tertiary)' }}>
                <Loader2 className="w-5 h-5 animate-spin" aria-hidden="true" />
                <span className="sr-only">{t('datatables.loading', 'Loading…')}</span>
            </div>
        );
    }

    const cols = columns.length;

    return (
        <div className={fullPage ? 'flex-1 min-h-0 flex flex-col' : 'space-y-3'} data-layout={layout}>
            {/* ── The toolbar: one row, the artboard's order ── */}
            <div className={fullPage ? 'flex flex-wrap items-center gap-2 px-4 py-2 border-b shrink-0' : 'flex flex-wrap items-center gap-2'}
                style={fullPage ? { borderColor: 'var(--border-default)', minHeight: 44 } : undefined}>
                {searchable && (
                    <form
                        className="flex items-center gap-1.5"
                        onSubmit={(e) => { e.preventDefault(); restart(); setApplied(query.trim()); }}
                    >
                        <label className="relative block" style={{ width: 260 }}>
                            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
                                style={{ color: 'var(--text-tertiary)' }} aria-hidden="true" />
                            <input
                                value={query}
                                onChange={(e) => setQuery(e.target.value)}
                                placeholder={t('datatables.rows_search', 'Search the text columns…')}
                                aria-label={t('datatables.rows_search_label', 'Search the rows')}
                                className="w-full pl-8 pr-2 py-1.5 rounded-lg text-xs border focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1"
                                style={CHIP_STYLE}
                            />
                        </label>
                        {applied && (
                            <button type="button" onClick={() => { restart(); setQuery(''); setApplied(''); }}
                                className={LINK_BTN} style={SUBTLE}>{t('datatables.clear', 'Clear')}</button>
                        )}
                    </form>
                )}

                <button
                    type="button"
                    onClick={() => setFilterOpen(o => !o)}
                    aria-expanded={filterOpen}
                    className={CHIP_BTN}
                    style={activeFilters.length
                        ? { ...CHIP_STYLE, borderColor: 'var(--accent-primary)', color: 'var(--text-primary)' }
                        : CHIP_STYLE}
                >
                    <Filter className="w-3.5 h-3.5" aria-hidden="true" />
                    {activeFilters.length
                        ? t('datatables.filter_n', 'Filter ({n})', { n: activeFilters.length })
                        : t('datatables.filter', 'Filter')}
                </button>

                <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                    {rowsWord(t, total)}
                    {isMirror && mirror?.sync?.lastSuccessAt
                        ? <>{' · '}{t('datatables.nc_rows_refreshed', 'refreshed {when}', { when: rel(mirror.sync.lastSuccessAt) })}</>
                        : table.updatedAt && <>{' · '}{t('datatables.rows_updated', 'updated {when}', { when: rel(table.updatedAt) })}</>}
                    {writing && (
                        <span className="inline-flex items-center gap-1 ml-2" style={{ color: 'var(--text-secondary)' }}>
                            <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />
                            {t('datatables.src_writing', 'Writing to {source}…', { source: sourceName })}
                        </span>
                    )}
                </span>

                <span className="flex-1" />

                <button type="button" onClick={load} disabled={busy} className={LINK_BTN} style={SUBTLE}>
                    <RefreshCw className={`w-3.5 h-3.5 ${busy ? 'animate-spin' : ''}`} aria-hidden="true" />
                    {t('datatables.refresh', 'Refresh')}
                </button>
                {canWrite && cols > 0 && (
                    <button type="button" onClick={() => { setImporting(i => !i); setAdding(false); }}
                        className={CHIP_BTN} style={CHIP_STYLE}>
                        {/* clipboard-paste, not upload: this reads a paste out of
                            a spreadsheet. An upload glyph promises a file picker
                            that is not here. */}
                        <ClipboardPaste className="w-3.5 h-3.5" aria-hidden="true" /> {t('datatables.import', 'Import')}
                    </button>
                )}
                <button type="button" onClick={exportCsv} className={CHIP_BTN} style={CHIP_STYLE}>
                    <Download className="w-3.5 h-3.5" aria-hidden="true" /> {t('datatables.export_csv', 'Export CSV')}
                </button>
                {canWrite && cols > 0 && (
                    <button type="button" onClick={() => { setAdding(a => !a); setImporting(false); }}
                        className="text-xs inline-flex items-center gap-1.5 h-[30px] px-3 rounded-lg font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                        style={{ ...PRIMARY_ACTION_STYLE, outlineColor: 'var(--accent-primary)' }}>
                        <Plus className="w-3.5 h-3.5" aria-hidden="true" /> {t('datatables.add_row', 'Add a row')}
                    </button>
                )}
            </div>

            <div className={fullPage ? 'px-4 flex flex-col gap-3 shrink-0' : 'contents'}>
            {filterOpen && (
                <RowFilterBuilder
                    t={t}
                    columns={columns}
                    rows={filterRows}
                    match={match}
                    onRows={setFilterRows}
                    onMatch={setMatch}
                    onApply={applyFilters}
                    onClear={clearFilters}
                    appliedCount={activeFilters.length}
                />
            )}

            {/* aria-live: a failed save or a row conflict lands here without
                moving focus, so silently is exactly how it reads otherwise. */}
            <div aria-live="polite">
                {error && <p className="text-xs px-3 py-2 rounded" style={{ background: 'var(--bg-secondary)', color: 'var(--warning)' }}>{error}</p>}
                {canWrite && selected.size > 0 && (
                    <div className="flex items-center gap-3 px-3 py-2 rounded-lg text-xs"
                        style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)' }}>
                        <span>{selected.size === 1
                            ? t('datatables.selected_one', '1 row selected')
                            : t('datatables.selected_n', '{n} rows selected', { n: selected.size })}</span>
                        <button type="button" onClick={() => setSelected(new Set())} className={LINK_BTN} style={SUBTLE}>
                            {t('datatables.selection_clear', 'Clear selection')}
                        </button>
                        <span className="flex-1" />
                        <button
                            type="button"
                            onClick={() => setPendingBulk(true)}
                            disabled={busy}
                            className={`${CHIP_BTN} disabled:opacity-50`}
                            style={{ ...CHIP_STYLE, borderColor: 'var(--error)', color: 'var(--error)' }}
                        >
                            <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                            {t('datatables.selection_delete', 'Delete selected')}
                        </button>
                    </div>
                )}
            </div>

            {importing && (
                <ImportPanel
                    columns={columns}
                    onImport={(values) => datatablesApi.bulkImport(table.id, values)}
                    onDone={afterWrite}
                    onClose={() => setImporting(false)}
                />
            )}

            {adding && (
                <AddRowForm
                    columns={columns}
                    onCancel={() => setAdding(false)}
                    requiredHint={isMirror ? t('datatables.src_required', 'required in {source}', { source: sourceName }) : null}
                    onAdd={async (values) => {
                        setWriting(isMirror);
                        try {
                            const body = await datatablesApi.addRow(table.id, values);
                            setAdding(false);
                            await afterWrite(body);
                        } catch (e) {
                            setError(sourceErrorMessage(t, e, table) || e.message || t('datatables.err_row_add', 'Could not add the row'));
                        } finally {
                            setWriting(false);
                        }
                    }}
                />
            )}
            </div>

            {cols === 0 ? (
                <p className={`text-sm ${fullPage ? 'px-4 py-4' : ''}`} style={{ color: 'var(--text-secondary)' }}>
                    {t('datatables.rows_no_columns', 'This table has no columns yet — add some on the Columns tab first.')}
                </p>
            ) : rows.length === 0 ? (
                <p className={`text-sm ${fullPage ? 'px-4 py-4' : ''}`} style={{ color: 'var(--text-secondary)' }}>
                    {applied || activeFilters.length
                        ? t('datatables.rows_no_match', 'No rows match that search.')
                        : t('datatables.rows_empty', 'No rows yet. An automation with a Datatable step writing to this table will fill it, or you can add one here.')}
                </p>
            ) : (
                // The table scrolls INSIDE its own box: a wide datatable must
                // never make the whole Studio page scroll sideways. On the
                // page layout the box is the whole main area (2b).
                <div className={fullPage ? 'flex-1 min-h-0 overflow-auto' : 'overflow-x-auto'} style={fullPage ? {
                    background: 'var(--bg-card)', borderTop: '1px solid var(--border-default)',
                } : {
                    borderRadius: 12, background: 'var(--bg-card)',
                    border: '1px solid var(--border-default)', boxShadow: 'var(--shadow-sm)',
                }}>
                    <table className="w-full text-xs">
                        <thead>
                            <tr style={{ background: 'var(--bg-secondary)' }}>
                                {canWrite && (
                                    <th className="px-3 py-2.5 w-10">
                                        <input
                                            type="checkbox"
                                            checked={allShownSelected}
                                            onChange={toggleAll}
                                            aria-label={t('datatables.select_all', 'Select every row on this page')}
                                        />
                                    </th>
                                )}
                                {columns.map(c => (
                                    <HeadCell key={c.key} t={t} sort={sort} field={c.key} onSort={() => toggleSort(c.key)}
                                        label={columnLabel(c)} title={columnKeyTitle(c)}
                                        kind={columnTypeKind(c.type)} numeric={columnTypeKind(c.type) === 'number'} />
                                ))}
                                <HeadCell t={t} sort={sort} field="created_at" onSort={() => toggleSort('created_at')}
                                    label={t('datatables.col_added', 'Added')} kind="date" muted />
                                {retention && (
                                    <th className="px-3 py-2.5 text-left font-semibold whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>
                                        {t('datatables.col_expires', 'Expires')}
                                    </th>
                                )}
                                {canWrite && <th className="px-2 py-2.5"><span className="sr-only">{t('datatables.row_actions', 'Actions')}</span></th>}
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map(r => {
                                const isEditing = editing === r.id;
                                return (
                                    <tr key={r.id} style={{ borderTop: '1px solid var(--border-default)' }}>
                                        {canWrite && (
                                            <td className="px-3 py-2.5 align-top">
                                                <input
                                                    type="checkbox"
                                                    checked={selected.has(r.id)}
                                                    onChange={() => toggleRow(r.id)}
                                                    aria-label={t('datatables.select_row', 'Select this row')}
                                                />
                                            </td>
                                        )}
                                        {columns.map(c => (
                                            <td key={c.key} className={`px-3 py-2.5 align-top ${isEditing ? '' : 'max-w-[16rem] truncate'} ${columnTypeKind(c.type) === 'number' ? 'text-right tabular-nums' : ''}`}
                                                style={{ color: 'var(--text-primary)' }}
                                                title={isEditing ? undefined : cellText(r[c.key], c)}>
                                                {isEditing && !c.derived && c.type !== 'relation' ? (
                                                    <RowCellEditor
                                                        field={c}
                                                        value={draft[c.key] !== undefined ? draft[c.key] : r[c.key]}
                                                        live
                                                        onCommit={(v) => setDraft(d => ({ ...d, [c.key]: v }))}
                                                    />
                                                ) : c.type === 'relation'
                                                    ? <RelationCell t={t} column={c} row={r} columns={columns} mirror={mirror} />
                                                    : <ManagedCell t={t} managedKind={table.managedKind} column={c} row={r} />}
                                            </td>
                                        ))}
                                        <td className="px-3 py-2.5 align-top whitespace-nowrap" style={{ color: 'var(--text-tertiary)' }}
                                            title={r.created_at ? String(r.created_at).slice(0, 16).replace('T', ' ') : undefined}>
                                            {r.created_at ? rel(r.created_at) : '—'}
                                        </td>
                                        {retention && (
                                            <td className="px-3 py-2.5 align-top whitespace-nowrap">
                                                <ExpiryCell t={t} row={r} retention={retention} />
                                            </td>
                                        )}
                                        {canWrite && (
                                            <td className="px-2 py-2.5 align-top whitespace-nowrap">
                                                {isEditing ? (
                                                    <>
                                                        <button type="button" onClick={() => saveEdit(r)}
                                                            aria-label={t('datatables.row_save', 'Save this row')} className={ICON_BTN}
                                                            style={{ color: 'var(--accent-primary)', outlineColor: 'var(--accent-primary)' }}>
                                                            <Check className="w-3.5 h-3.5" aria-hidden="true" />
                                                        </button>
                                                        <button type="button" onClick={() => { setEditing(null); setDraft({}); }}
                                                            aria-label={t('datatables.row_stop_edit', 'Stop editing this row')} className={ICON_BTN}
                                                            style={{ color: 'var(--text-tertiary)', outlineColor: 'var(--accent-primary)' }}>
                                                            <X className="w-3.5 h-3.5" aria-hidden="true" />
                                                        </button>
                                                    </>
                                                ) : (
                                                    <>
                                                        <button type="button" onClick={() => { setEditing(r.id); setDraft({}); }}
                                                            aria-label={t('datatables.row_edit', 'Edit this row')} className={ICON_BTN}
                                                            style={{ color: 'var(--text-tertiary)', outlineColor: 'var(--accent-primary)' }}>
                                                            <Pencil className="w-3.5 h-3.5" aria-hidden="true" />
                                                        </button>
                                                        <button type="button" onClick={() => setPendingDelete(r)}
                                                            aria-label={t('datatables.row_delete', 'Delete this row')} className={ICON_BTN}
                                                            style={{ color: 'var(--text-tertiary)', outlineColor: 'var(--accent-primary)' }}>
                                                            <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                                                        </button>
                                                    </>
                                                )}
                                            </td>
                                        )}
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                    {fullPage && canWrite && !adding && (
                        <button type="button" onClick={() => { setAdding(true); setImporting(false); }}
                            className="w-full text-left text-xs font-medium inline-flex items-center gap-1.5 px-4 py-2.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px]"
                            style={{ color: 'var(--text-secondary)', outlineColor: 'var(--accent-primary)' }} data-testid="rows-add-ghost">
                            <Plus className="w-3.5 h-3.5" aria-hidden="true" /> {t('datatables.add_row', 'Add a row')}
                        </button>
                    )}
                </div>
            )}

            {rows.length > 0 && (
                <div className={fullPage ? 'flex items-center gap-3 text-xs px-4 border-t shrink-0' : 'flex items-center gap-3 text-xs'}
                    style={fullPage ? { color: 'var(--text-secondary)', borderColor: 'var(--border-default)', minHeight: 40 } : { color: 'var(--text-secondary)' }}>
                    <span>{windowText(t, { rows: rows.length, total, page })}</span>
                    {hasMore && (
                        <button type="button" onClick={loadMore} disabled={busy} className={CHIP_BTN} style={CHIP_STYLE}>
                            {busy && <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />}
                            {t('datatables.load_more', 'Load more')}
                        </button>
                    )}
                    <span className="flex-1" />
                    <div className="flex gap-1">
                        <button type="button" onClick={goPrev} disabled={page === 0 || busy}
                            aria-label={t('datatables.page_prev', 'Previous page')}
                            className="w-7 h-7 grid place-items-center rounded-lg border disabled:opacity-40 focus-visible:outline focus-visible:outline-2"
                            style={CHIP_STYLE}>
                            <ChevronLeft className="w-3.5 h-3.5" aria-hidden="true" />
                        </button>
                        <button type="button" onClick={goNext} disabled={!cursor || busy}
                            aria-label={t('datatables.page_next', 'Next page')}
                            className="w-7 h-7 grid place-items-center rounded-lg border disabled:opacity-40 focus-visible:outline focus-visible:outline-2"
                            style={CHIP_STYLE}>
                            <ChevronRight className="w-3.5 h-3.5" aria-hidden="true" />
                        </button>
                    </div>
                </div>
            )}

            {/* A row delete used to be one unconfirmed click, in a section that
                interposes a full dialog before a COLUMN is dropped. */}
            <ConfirmDialog
                open={!!pendingDelete}
                title={t('datatables.row_delete_title', 'Delete this row?')}
                description={t('datatables.row_delete_body', 'It is gone for good, and any automation that reads it by id stops finding it.')}
                confirmLabel={t('datatables.row_delete_confirm', 'Delete the row')}
                destructive
                onConfirm={() => removeRow(pendingDelete)}
                onCancel={() => setPendingDelete(null)}
            />
            <ConfirmDialog
                open={pendingBulk}
                title={t('datatables.bulk_delete_title', 'Delete {n} rows?', { n: selected.size })}
                description={t('datatables.bulk_delete_body', 'They are gone for good, in one go, and any automation that reads them by id stops finding them.')}
                confirmLabel={t('datatables.bulk_delete_confirm', 'Delete them')}
                destructive
                onConfirm={removeSelected}
                onCancel={() => setPendingBulk(false)}
            />
        </div>
    );
}

/** "412 rows", grouped. */
function rowsWord(t, n) {
    const count = Number(n) || 0;
    if (count === 1) return t('datatables.one_row', '1 row');
    return t('datatables.n_rows', '{n} rows', { n: new Intl.NumberFormat().format(count) });
}

/**
 * What part of the table is on screen.
 *
 * On page one the sentence names the RIGHT END of the table — the sort is
 * created_at DESC, so "the first 50" named the wrong one. Past page one an
 * honest range is not available (a keyset window has no offset, and that is
 * the point), so it says which page instead of inventing "51–100".
 */
function windowText(t, { rows, total, page }) {
    if (page > 0) {
        return t('datatables.rows_page', 'page {p} · {n} of {total}', { p: page + 1, n: rows, total });
    }
    if (rows === total) {
        return total === 1 ? t('datatables.one_row', '1 row') : t('datatables.n_rows', '{n} rows', { n: total });
    }
    return t('datatables.rows_recent', 'the {n} most recent of {total}', { n: rows, total });
}

/**
 * A sortable column heading, with its kind's glyph — artboard 1e. A number
 * column's heading sits over its right-aligned figures (2b); the "Added"
 * heading is muted, as its values are.
 */
// `title` is the column's real key when the heading is a humanised version of
// it — the exact spelling stays one hover away for whoever is writing
// `{{steps.x.output.contact_email}}`. Undefined when the two are the same, so
// a tooltip never just repeats what is already on screen.
function HeadCell({ t, label, title, kind, field, sort, onSort, numeric = false, muted = false }) {
    return (
        <th className={`${numeric ? 'text-right' : 'text-left'} font-semibold px-3 py-2.5 whitespace-nowrap`}
            style={{ color: muted ? 'var(--text-tertiary)' : 'var(--text-secondary)' }}
            title={title}>
            <button type="button" onClick={onSort}
                className="inline-flex items-center gap-1.5 rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                style={{ outlineColor: 'var(--accent-primary)' }}
                aria-label={t('datatables.sort_by', 'Sort by {name}', { name: label })}>
                <ColumnKindIcon kind={kind} size={12} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
                {label}
                {sort.field === field && <span aria-hidden="true">{sort.dir === 'asc' ? '↑' : '↓'}</span>}
            </button>
        </th>
    );
}

/**
 * A cell, with the two managed columns that are not really text.
 *
 * `response_status` is an HTTP answer code, and 200-vs-429 is the whole
 * reason someone opens a cache table — so it wears the success/error tint
 * rather than sitting in the row as a number. The keys come from
 * `MANAGED_COLUMNS`, so a table whose contract changes cannot leave a
 * renderer pointing at a column that is gone.
 */
/**
 * A relation cell on a mirror: the LABEL of the linked row, not its id.
 *
 * The label is a column of this same row — the `<key>_label` the engine
 * fills beside a Nextcloud relation, or the local match column a declared
 * relation was matched on — so no second request is needed. Falls back to
 * `#<id>` when there is an id and no label, and to a dash when the row has
 * no link at all. A relation is derived: it is not edited here (the column
 * it derives from is), which is what the title says.
 */
function RelationCell({ t, column, row, columns, mirror }) {
    const id = row[column.key];
    const relations = (mirror && mirror.source && mirror.source.relations) || [];
    const rel = relations.find(r => r.fieldId === column.id);
    let label = null;
    if (rel && rel.kind === 'nc') {
        const labelCol = columns.find(c => c.id === rel.labelFieldId);
        label = labelCol ? row[labelCol.key] : null;
    } else if (rel && rel.kind === 'match') {
        const localCol = columns.find(c => c.id === rel.localFieldId);
        label = localCol ? row[localCol.key] : null;
    }
    if (id === null || id === undefined || id === '') return <span style={{ color: 'var(--text-tertiary)' }}>—</span>;
    return (
        <span
            className="inline-flex items-center gap-1 text-[11px] max-w-full"
            style={{ padding: '1px 7px', borderRadius: 999, background: 'var(--bg-secondary)', color: 'var(--text-secondary)', border: '1px solid var(--border-default)' }}
            title={rel && rel.kind === 'match'
                ? t('datatables.nc_relation_derived', 'Filled in from another column — change that column instead.')
                : t('datatables.nc_relation_cell_title', 'A row of the linked table')}
        >
            <Link2 className="w-3 h-3 shrink-0" aria-hidden="true" />
            <span className="truncate">{label !== null && label !== undefined && label !== '' ? String(label) : `#${id}`}</span>
        </span>
    );
}

function ManagedCell({ t, managedKind, column, row }) {
    const value = row[column.key];
    const managed = (MANAGED_COLUMNS[managedKind] || []).some(f => f.key === column.key);
    if (managed && column.key === 'response_status' && value !== null && value !== undefined && value !== '') {
        const code = Number(value);
        const ok = Number.isFinite(code) && code >= 200 && code < 300;
        const tone = ok ? 'success' : 'error';
        return (
            <span
                className="inline-flex items-center text-[11px] font-semibold"
                style={{
                    padding: '1px 7px',
                    borderRadius: 999,
                    background: ok
                        ? 'color-mix(in srgb, var(--success) 14%, transparent)'
                        : 'color-mix(in srgb, var(--error) 12%, transparent)',
                    color: ok ? 'var(--success-ink)' : 'var(--error-ink)',
                }}
                title={t('datatables.managed_status', 'The answer code the service gave')}
                data-tone={tone}
            >
                {String(value)}
            </span>
        );
    }
    if (managed && column.key === 'request_method') {
        return <span className="font-mono uppercase">{cellText(value, column)}</span>;
    }
    // An empty choice reads as what it is — "no status yet" — in a dimmed,
    // dashed pill (2b), not as a dash that could pass for a value.
    if ((column.type === 'select' || column.type === 'multiselect') && (value === null || value === undefined || value === '' || (Array.isArray(value) && !value.length))) {
        return (
            <span className="inline-flex items-center text-[11px] whitespace-nowrap"
                style={{ padding: '2px 8px', borderRadius: 999, border: '1px dashed var(--border-default)', color: 'var(--text-tertiary)' }}
                data-testid="cell-empty-choice">
                {t('datatables.cell_no_choice', 'no {name} yet', { name: columnLabel(column).toLowerCase() })}
            </span>
        );
    }
    return <>{cellText(value, column)}</>;
}

/**
 * When this row goes (artboard 1e's "Verloopt" column).
 *
 * Derived, not stored: the server keeps no per-row expiry, the sweep works
 * it out from `retentionDays` + `retentionField` when it runs. So the column
 * only appears when BOTH are set, and it uses exactly those two — a
 * countdown from a column the sweep does not read would be a confident lie.
 */
function ExpiryCell({ t, row, retention }) {
    const e = rowExpiry(row, retention);
    if (!e) return <span style={{ color: 'var(--text-tertiary)' }}>—</span>;
    if (e.overdue) {
        return (
            <span className="text-[11px] font-semibold" style={{
                padding: '1px 7px', borderRadius: 999,
                background: 'color-mix(in srgb, var(--warning) 16%, transparent)',
                color: 'var(--warning-ink)',
            }}>
                {t('datatables.expiry_due', 'due to go')}
            </span>
        );
    }
    if (e.days <= 7) {
        return (
            <span className="text-[11px] font-semibold" style={{
                padding: '1px 7px', borderRadius: 999,
                background: 'color-mix(in srgb, var(--warning) 16%, transparent)',
                color: 'var(--warning-ink)',
            }}>
                {e.days <= 1
                    ? t('datatables.expiry_today', 'today')
                    : t('datatables.expiry_in_days', 'in {n} days', { n: e.days })}
            </span>
        );
    }
    return (
        <span style={{ color: 'var(--text-secondary)' }}>
            {t('datatables.expiry_in_days', 'in {n} days', { n: e.days })}
        </span>
    );
}

/**
 * A new row, typed by its columns.
 *
 * `values` is seeded from the columns rather than left empty: an unticked
 * checkbox that never enters the object writes NULL, and the grid then shows
 * '—' where the person said No.
 */
function AddRowForm({ columns: allColumns, onCancel, onAdd, requiredHint = null }) {
    const { t } = useTranslation();
    // A derived column (a mirror's relation or its label) is the engine's to
    // fill; offering it here would be a field the server refuses.
    const columns = useMemo(() => allColumns.filter(c => !c.derived && c.type !== 'relation'), [allColumns]);
    const seed = useMemo(() => {
        const out = {};
        for (const c of columns) if (c.type === 'bool') out[c.key] = false;
        return out;
    }, [columns]);
    // Seeded once, at mount. The columns cannot change while this form is open
    // — the schema is loaded with the page — so re-seeding on every change
    // would only be a way to throw away what the person has typed.
    const [values, setValues] = useState(seed);

    return (
        <form
            className="p-3 space-y-2"
            style={{
                borderRadius: 12, background: 'var(--bg-card)',
                border: '1px solid var(--border-default)', boxShadow: 'var(--shadow-sm)',
            }}
            onSubmit={(e) => { e.preventDefault(); onAdd(values); }}
        >
            {columns.map(c => (
                <label key={c.key} className="block">
                    <span className="block text-[11px] mb-0.5" style={{ color: 'var(--text-secondary)' }}>
                        <span title={columnKeyTitle(c)}>{columnLabel(c)}</span>
                        {c.required && requiredHint ? <span style={{ color: 'var(--text-tertiary)' }}>{' · '}{requiredHint}</span> : null}
                    </span>
                    <RowCellEditor
                        field={c}
                        value={values[c.key]}
                        live
                        onCommit={(v) => setValues(cur => ({ ...cur, [c.key]: v }))}
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
                    className="px-3 py-1.5 rounded-[10px] text-sm border focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                    style={{ borderColor: 'var(--border-default)', color: 'var(--text-secondary)', outlineColor: 'var(--accent-primary)' }}>
                    {t('datatables.cancel', 'Cancel')}
                </button>
            </div>
        </form>
    );
}
