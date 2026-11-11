import { ChevronLeft, ChevronRight } from 'lucide-react';
import useTranslation from '@/hooks/useTranslation';
import type { Paging } from '../pagedSource';

/**
 * App Studio runtime — the bar under a paged record list (table, list,
 * data_grid with `pagination`). loadMore: how many rows are shown and a button
 * for the next page. prevNext: the range on screen and the two steps. Nothing
 * is drawn while the whole result fits on the first page.
 */

const BUTTON = 'app-focusable inline-flex items-center gap-1 border px-2.5 py-1 text-xs font-medium '
    + 'disabled:opacity-50 disabled:cursor-default [background:var(--bg-card)] [border-color:var(--border-default)] '
    + '[border-radius:var(--app-radius)] text-[var(--text-primary)]';

const fmt = (n: number) => n.toLocaleString();

function Status({ paging }: { paging: Paging }) {
    const { t } = useTranslation();
    if (paging.failed) return <span role="alert">{t('studio_apps_paging.failed', 'The next page could not be loaded.')}</span>;
    if (paging.loading) return <span aria-live="polite">{t('studio_apps_paging.loading', 'Loading…')}</span>;
    if (paging.mode === 'loadMore') {
        return paging.total !== null
            ? <span>{t('studio_apps_paging.shown_of_total', '{shown} of {total}', { shown: fmt(paging.shown), total: fmt(paging.total) })}</span>
            : <span>{t('studio_apps_paging.shown', '{shown} shown', { shown: fmt(paging.shown) })}</span>;
    }
    if (paging.shown === 0) return null;
    const range = { from: fmt(paging.from + 1), to: fmt(paging.from + paging.shown) };
    return paging.total !== null
        ? <span>{t('studio_apps_paging.range_of_total', '{from}–{to} of {total}', { ...range, total: fmt(paging.total) })}</span>
        : <span>{t('studio_apps_paging.range', '{from}–{to}', range)}</span>;
}

/** One page that holds the whole result needs no bar; anything past it, or on its way, does. */
function showsPager(paging: Paging | null): paging is Paging {
    if (!paging) return false;
    return paging.canNext || paging.canPrev || paging.loading || paging.failed || paging.pages > 1;
}

export default function PagerBar({ paging }: { paging: Paging | null }) {
    const { t } = useTranslation();
    if (!showsPager(paging)) return null;
    return (
        <nav
            className="flex items-center justify-between gap-2 pt-2 text-xs text-[var(--text-secondary)]"
            aria-label={t('studio_apps_paging.nav_label', 'Pages')}
            data-app-pager={paging.mode}
        >
            <Status paging={paging} />
            {paging.mode === 'loadMore' ? (
                paging.canNext ? (
                    <button type="button" className={BUTTON} onClick={paging.next} disabled={paging.loading}>
                        {t('studio_apps_paging.load_more', 'Load more')}
                    </button>
                ) : null
            ) : (
                <span className="inline-flex items-center gap-1.5">
                    <button type="button" className={BUTTON} onClick={paging.prev} disabled={!paging.canPrev}>
                        <ChevronLeft className="w-3.5 h-3.5" aria-hidden="true" />
                        {t('studio_apps_paging.previous', 'Previous')}
                    </button>
                    <button type="button" className={BUTTON} onClick={paging.next} disabled={!paging.canNext || paging.loading}>
                        {t('studio_apps_paging.next', 'Next')}
                        <ChevronRight className="w-3.5 h-3.5" aria-hidden="true" />
                    </button>
                </span>
            )}
        </nav>
    );
}
