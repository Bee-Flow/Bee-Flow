import { ChevronLeft, ChevronRight, Loader2, Trash2 } from 'lucide-react';
import { CHIP_BTN, CHIP_STYLE, LINK_BTN, SUBTLE, windowText } from './rowBrowserModel';
import type { RowPages } from './useRowPages';
import type { RowWrites } from './useRowWrites';
import useTranslation from '../../../../../hooks/useTranslation';
import ConfirmDialog from '../../../../shared/ConfirmDialog';

/** The error line and the ticked-rows bar. aria-live: a failed save lands here without moving focus. */
export function RowNotices({ pages, writes, canWrite }: { pages: RowPages; writes: RowWrites; canWrite: boolean }) {
    const { t } = useTranslation();
    const { error, selected, setSelected, busy } = pages;
    return (
        <div aria-live="polite">
            {error && <p className="text-xs px-3 py-2 rounded bg-[var(--bg-secondary)] text-[var(--warning)]">{error}</p>}
            {canWrite && selected.size > 0 && (
                <div className="flex items-center gap-3 px-3 py-2 rounded-lg text-xs bg-[var(--bg-secondary)] text-[var(--text-primary)]">
                    <span>{selected.size === 1
                        ? t('datatables.selected_one', '1 row selected')
                        : t('datatables.selected_n', '{n} rows selected', { n: selected.size })}</span>
                    <button type="button" onClick={() => setSelected(new Set())} className={LINK_BTN} style={SUBTLE}>
                        {t('datatables.selection_clear', 'Clear selection')}
                    </button>
                    <span className="flex-1" />
                    <button
                        type="button"
                        onClick={() => writes.setPendingBulk(true)}
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
    );
}

const PAGER_BTN = 'w-7 h-7 grid place-items-center rounded-lg border disabled:opacity-40 focus-visible:outline focus-visible:outline-2';

/** The count, "Load more" and the ‹ › pager. */
export function RowPager({ pages, fullPage }: { pages: RowPages; fullPage: boolean }) {
    const { t } = useTranslation();
    const { rows, total, page, hasMore, loadMore, busy, goPrev, goNext, cursor } = pages;
    return (
        <div className={fullPage ? 'flex items-center gap-3 text-xs px-4 border-t shrink-0' : 'flex items-center gap-3 text-xs'}
            style={fullPage ? { color: 'var(--text-secondary)', borderColor: 'var(--border-default)', minHeight: 40 } : { color: 'var(--text-secondary)' }}>
            <span>{windowText(t, { rows: (rows || []).length, total, page })}</span>
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
                    className={PAGER_BTN}
                    style={CHIP_STYLE}>
                    <ChevronLeft className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
                <button type="button" onClick={goNext} disabled={!cursor || busy}
                    aria-label={t('datatables.page_next', 'Next page')}
                    className={PAGER_BTN}
                    style={CHIP_STYLE}>
                    <ChevronRight className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
            </div>
        </div>
    );
}

/**
 * The two delete confirmations. A row delete used to be one unconfirmed
 * click, in a section that interposes a full dialog before a COLUMN is
 * dropped.
 */
export function RowDeleteDialogs({ pages, writes }: { pages: RowPages; writes: RowWrites }) {
    const { t } = useTranslation();
    const { pendingDelete, setPendingDelete, removeRow, pendingBulk, setPendingBulk, removeSelected } = writes;
    return (
        <>
            <ConfirmDialog
                open={!!pendingDelete}
                title={t('datatables.row_delete_title', 'Delete this row?')}
                description={t('datatables.row_delete_body', 'It is gone for good, and any automation that reads it by id stops finding it.')}
                confirmLabel={t('datatables.row_delete_confirm', 'Delete the row')}
                destructive
                onConfirm={() => { if (pendingDelete) removeRow(pendingDelete); }}
                onCancel={() => setPendingDelete(null)}
            />
            <ConfirmDialog
                open={pendingBulk}
                title={t('datatables.bulk_delete_title', 'Delete {n} rows?', { n: pages.selected.size })}
                description={t('datatables.bulk_delete_body', 'They are gone for good, in one go, and any automation that reads them by id stops finding them.')}
                confirmLabel={t('datatables.bulk_delete_confirm', 'Delete them')}
                destructive
                onConfirm={removeSelected}
                onCancel={() => setPendingBulk(false)}
            />
        </>
    );
}
