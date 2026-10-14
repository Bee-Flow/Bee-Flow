import { ClipboardPaste, Download, Filter, Loader2, Plus, RefreshCw, Search } from 'lucide-react';
import { CHIP_BTN, CHIP_STYLE, LINK_BTN, SUBTLE, rowsWord } from './rowBrowserModel';
import type { DtMirror, DtTable } from './rowBrowserModel';
import type { RowPages } from './useRowPages';
import type { RowWrites } from './useRowWrites';
import useRelativeTime from '../../../../../hooks/useRelativeTime';
import useTranslation from '../../../../../hooks/useTranslation';
import { PRIMARY_ACTION_STYLE } from '../../../../shared/StudioSectionHeader';

interface RowToolbarProps {
    pages: RowPages;
    writes: RowWrites;
    table: DtTable;
    mirror: DtMirror | null;
    isMirror: boolean;
    sourceName: string;
    canWrite: boolean;
    fullPage: boolean;
}

/** The search box, with its Clear once a search is in force. */
function RowSearch({ pages }: { pages: RowPages }) {
    const { t } = useTranslation();
    const { query, setQuery, applied, search } = pages;
    return (
        <form
            className="flex items-center gap-1.5"
            onSubmit={(e) => { e.preventDefault(); search(query.trim()); }}
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
                <button type="button" onClick={() => { setQuery(''); search(''); }}
                    className={LINK_BTN} style={SUBTLE}>{t('datatables.clear', 'Clear')}</button>
            )}
        </form>
    );
}

/** The toolbar: one row, the artboard's order. */
export default function RowToolbar({ pages, writes, table, mirror, isMirror, sourceName, canWrite, fullPage }: RowToolbarProps) {
    const { t } = useTranslation();
    const rel = useRelativeTime();
    const { searchable, filterOpen, setFilterOpen, activeFilters, total, load, busy, columns } = pages;
    const { writing, setImporting, setAdding, exportCsv } = writes;
    const cols = columns.length;
    return (
        <div className={fullPage ? 'flex flex-wrap items-center gap-2 px-4 py-2 border-b shrink-0' : 'flex flex-wrap items-center gap-2'}
            style={fullPage ? { borderColor: 'var(--border-default)', minHeight: 44 } : undefined}>
            {searchable && <RowSearch pages={pages} />}

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

            <span className="text-xs text-[var(--text-tertiary)]">
                {rowsWord(t, total)}
                {isMirror && mirror?.sync?.lastSuccessAt
                    ? <>{' · '}{t('datatables.nc_rows_refreshed', 'refreshed {when}', { when: rel(mirror.sync.lastSuccessAt) })}</>
                    : table.updatedAt && <>{' · '}{t('datatables.rows_updated', 'updated {when}', { when: rel(table.updatedAt) })}</>}
                {writing && (
                    <span className="inline-flex items-center gap-1 ml-2 text-[var(--text-secondary)]">
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
    );
}
