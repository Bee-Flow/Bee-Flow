import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { useTranslation } from '../../../../../hooks/useTranslation';
import DataTable from '../../../../shared/DataTable';
import FilterPills from '../../../../shared/FilterPills';
import SegmentedControl from '../../../../shared/SegmentedControl';
import EmptyState from '../../../../shared/EmptyState';
import CheckRow, { CheckCard } from './CheckRow';
import CheckExpansion from './CheckExpansion';
import {
    PILL_TONE, SORT_MODES, countByStatus, filterByStatus, filterBySearch, sortChecks, rowKeyOf, focusRowKey,
    visiblePills, isBusyRow,
} from './checkSort';

/**
 * ChecksTable — toolbar + the checks DataTable of a framework page (1b).
 *
 * The toolbar owns the view state (pill, sort, search); the table owns which
 * rows are open. Every piece of row state — open, focus, the rerun and
 * auto-fix spinners — is keyed by `rowKeyOf` (check + subject), because a
 * per-source check has one row per subject and one click must open one row.
 *
 * `focusId` is the row the overview sent us to, as a row key or a bare check
 * id (then the first row of that check in the sorted list): it starts open
 * and CheckRow scrolls it into view once. The list passed in is already the
 * framework's (FrameworkPage filters by regulation) so the counts on the
 * pills are the framework's counts.
 *
 * A card narrower than 860px (a 1024 window, or beside an open drawer) shows
 * the checks as cards, which open the same expansion, instead of a table
 * whose title column would be squeezed to a word.
 */

export const PILL_LABEL = Object.freeze({
    all: ['compliance.tbl_pill_all', 'All'],
    fail: ['compliance.status_fail', 'Failing'],
    warn: ['compliance.status_warn', 'Needs attention'],
    pass: ['compliance.status_pass', 'Passing'],
    not_applicable: ['compliance.status_na', 'Not applicable'],
});

/** Below this card width the rows become cards (DataTable `cardsBelow`). */
export const CHECK_CARDS_BELOW = 860;

/** The six columns — one array so header and rows can never drift apart. */
export function checkColumns(t) {
    return [
        { id: 'glyph', width: '18px', label: '' },
        { id: 'check', width: '1fr', label: t('compliance.tbl_col_check', 'Check') },
        { id: 'article', width: '84px', label: t('compliance.tbl_col_article', 'Article') },
        { id: 'verification', width: '150px', label: t('compliance.tbl_col_verification', 'Verification') },
        { id: 'last_run', width: '84px', label: t('compliance.tbl_col_last_run', 'Last run'), foldBelow: 900 },
        // One compact action ("Fix ->", or the project arrow + "Fix") plus the
        // chevron; Auto-fix and Re-run live in the expansion.
        { id: 'actions', width: '112px', label: '', align: 'right' },
    ];
}

export function ChecksToolbar({ pill, onPill, counts, sort, onSort, query, onQuery, testId = 'checks-toolbar' }) {
    const { t } = useTranslation();
    const pillOptions = visiblePills(counts, pill).map((value) => {
        const [key, en] = PILL_LABEL[value];
        return { value, label: t(key, en), count: counts ? counts[value] : undefined, tone: PILL_TONE[value] };
    });
    const sortOptions = [
        { value: 'by_status', label: t('compliance.tbl_sort_status', 'By status') },
        { value: 'by_article', label: t('compliance.tbl_sort_article', 'By article') },
    ];
    return (
        <div className="flex items-center gap-3 flex-wrap" data-testid={testId}>
            <FilterPills value={pill} onChange={onPill} options={pillOptions} ariaLabel={t('compliance.tbl_filter_aria', 'Filter checks by status')} testId={`${testId}-pill`} />
            <SegmentedControl size="sm" value={sort} onChange={onSort} options={sortOptions} ariaLabel={t('compliance.tbl_sort_aria', 'Sort checks')} />
            <label className="ml-auto relative flex items-center w-[200px] max-w-full">
                <Search size={12} aria-hidden="true" className="absolute left-2 text-[var(--text-tertiary)]" />
                <input
                    type="search"
                    value={query}
                    onChange={(e) => onQuery(e.target.value)}
                    placeholder={t('compliance.tbl_search_checks', 'Search checks…')}
                    aria-label={t('compliance.tbl_search_checks', 'Search checks…')}
                    data-testid={`${testId}-search`}
                    className="w-full h-8 pl-7 pr-2 rounded-[10px] border border-[var(--border-default)] bg-[var(--bg-card)] text-[12px] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-primary)]"
                />
            </label>
        </div>
    );
}

export default function ChecksTable({
    checks,
    regulation,
    loading = false,
    failed = false,
    focusId = null,
    rerunningId = null,
    autoFixingId = null,
    onRerun,
    onAutoFix,
    onDecide,
    loadTrail,
    onOpenLink,
    canOpenLink = () => true,
    exportsEnabled = true,
    dl = (url) => url,
    lastRunAt = null,
    isMobile = false,
    // Injectable clock. "Ran at 09:05" vs "Ran Sep 14" is decided against NOW,
    // so a row rendered from a fixed fixture changes wording the moment the day
    // rolls over — which is a test that passes only on the day it was written.
    now = undefined,
    testId = 'checks-table',
}) {
    const { t } = useTranslation();
    const [pill, setPill] = useState('all');
    const [sort, setSort] = useState(SORT_MODES[0]);
    const [query, setQuery] = useState('');
    // The row whose button started the current rerun / auto-fix.
    const [asked, setAsked] = useState({ rerun: null, autoFix: null });

    const list = useMemo(() => (Array.isArray(checks) ? checks : []), [checks]);
    const sorted = useMemo(() => sortChecks(list, sort, regulation), [list, sort, regulation]);
    const focusKey = useMemo(() => focusRowKey(sorted, focusId), [sorted, focusId]);
    const [openIds, setOpenIds] = useState(() => new Set(focusKey ? [focusKey] : []));

    // A focus target that resolves later (the list arrives after mount) or
    // anew (navigated again from the overview) opens too.
    useEffect(() => {
        if (!focusKey) return;
        setOpenIds((prev) => (prev.has(focusKey) ? prev : new Set([...prev, focusKey])));
    }, [focusKey]);

    const toggle = useCallback((key) => {
        setOpenIds((prev) => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key); else next.add(key);
            return next;
        });
    }, []);

    const counts = useMemo(() => countByStatus(list), [list]);
    const titleOf = useCallback((c) => (c.titleKey ? t(c.titleKey, c.check_id) : (c.title || c.check_id)), [t]);
    const rows = useMemo(
        () => filterBySearch(filterByStatus(sorted, pill), query, titleOf),
        [sorted, pill, query, titleOf],
    );
    const columns = useMemo(() => checkColumns(t), [t]);

    const expansionFor = (check, key, rowTestId) => (
        <CheckExpansion
            check={check}
            regulation={regulation}
            exportsEnabled={exportsEnabled}
            dl={dl}
            loadTrail={loadTrail}
            onOpenLink={onOpenLink}
            canOpenLink={canOpenLink}
            onAutoFix={typeof onAutoFix === 'function' ? (id) => { setAsked((a) => ({ ...a, autoFix: key })); onAutoFix(id); } : undefined}
            autoFixing={isBusyRow(autoFixingId, check, asked.autoFix)}
            onRerun={typeof onRerun === 'function' ? (id) => { setAsked((a) => ({ ...a, rerun: key })); onRerun(id); } : undefined}
            rerunning={isBusyRow(rerunningId, check, asked.rerun)}
            onDecide={onDecide}
            testId={`${rowTestId}-expansion`}
        />
    );

    // Test ids stay `row-<check_id>` for a global check; a per-subject row
    // adds its scope so every row has its own.
    const rowTestIdOf = (check) => `${testId}-row-${check.scope_id ? `${check.check_id}:${check.scope_id}` : check.check_id}`;

    const renderRow = (check) => {
        const key = rowKeyOf(check);
        const expanded = openIds.has(key);
        const rowTestId = rowTestIdOf(check);
        return (
            <>
                <CheckRow
                    check={check}
                    regulation={regulation}
                    columns={columns}
                    expanded={expanded}
                    onToggle={toggle}
                    focus={focusKey === key}
                    onOpenLink={onOpenLink}
                    canOpenLink={canOpenLink}
                    lastRunAt={lastRunAt}
                    now={now}
                    testId={rowTestId}
                />
                {expanded && expansionFor(check, key, rowTestId)}
            </>
        );
    };

    // Phone (1h) and narrow cards: one ≥44px card per check; tapping opens the same expansion.
    const renderCard = (check) => {
        const key = rowKeyOf(check);
        const expanded = openIds.has(key);
        const rowTestId = rowTestIdOf(check);
        return (
            <div className="w-full min-w-0 flex flex-col" data-testid={rowTestId.replace(`${testId}-row-`, `${testId}-card-`)}>
                <CheckCard
                    check={check}
                    regulation={regulation}
                    expanded={expanded}
                    onToggle={toggle}
                    lastRunAt={lastRunAt}
                    now={now}
                    testId={rowTestId}
                />
                {expanded && expansionFor(check, key, rowTestId)}
            </div>
        );
    };

    let empty = null;
    if (failed) {
        empty = <p className="m-0 text-[12px] text-[var(--text-tertiary)]" data-testid={`${testId}-failed`}>{t('compliance.tbl_checks_unavailable', 'The checks could not be read.')}</p>;
    } else if (list.length === 0) {
        empty = <EmptyState title={t('compliance.no_checks_yet', 'No checks have run yet. Click "Run checks now".')} />;
    } else {
        empty = <p className="m-0 text-[12px] text-[var(--text-tertiary)]" data-testid={`${testId}-no-match`}>{t('compliance.tbl_no_match', 'No checks match this filter.')}</p>;
    }

    return (
        <div className="flex flex-col gap-3" data-testid={testId}>
            <ChecksToolbar pill={pill} onPill={setPill} counts={loading && list.length === 0 ? null : counts} sort={sort} onSort={setSort} query={query} onQuery={setQuery} testId={`${testId}-toolbar`} />
            <DataTable
                columns={columns}
                rows={failed ? [] : rows}
                rowKey={rowKeyOf}
                renderRow={renderRow}
                renderCard={renderCard}
                isMobile={isMobile}
                cardsBelow={CHECK_CARDS_BELOW}
                loading={loading && list.length === 0}
                empty={empty}
                ariaLabel={t('compliance.tbl_aria', 'Compliance checks')}
                testId={`${testId}-table`}
            />
        </div>
    );
}
