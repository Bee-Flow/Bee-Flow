import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { useTranslation } from '../../../../../hooks/useTranslation';
import DataTable from '../../../../shared/DataTable';
import FilterPills from '../../../../shared/FilterPills';
import SegmentedControl from '../../../../shared/SegmentedControl';
import EmptyState from '../../../../shared/EmptyState';
import VerificationChip from '../../shared/VerificationChip';
import CheckRow, { CheckCard } from './CheckRow';
import CheckExpansion from './CheckExpansion';
import {
    STATUS_PILLS, PILL_TONE, SORT_MODES, countByStatus, filterByStatus, filterBySearch, sortChecks,
} from './checkSort';

/**
 * ChecksTable — toolbar + the checks DataTable of a framework page (1b).
 *
 * The toolbar owns the view state (pill, sort, search); the table owns which
 * rows are open. `focusId` is the row the overview sent us to: it starts
 * open and CheckRow scrolls it into view once. The list passed in is already
 * the framework's (FrameworkPage filters by regulation) so the counts on the
 * pills are the framework's counts.
 */

export const PILL_LABEL = Object.freeze({
    all: ['compliance.tbl_pill_all', 'All'],
    fail: ['compliance.status_fail', 'Failing'],
    warn: ['compliance.status_warn', 'Needs attention'],
    pass: ['compliance.status_pass', 'Passing'],
    not_applicable: ['compliance.status_na', 'Not applicable'],
});

/** The six columns — one array so header and rows can never drift apart. */
export function checkColumns(t) {
    return [
        { id: 'glyph', width: '18px', label: '' },
        { id: 'check', width: '1fr', label: t('compliance.tbl_col_check', 'Check') },
        { id: 'article', width: '84px', label: t('compliance.tbl_col_article', 'Article') },
        { id: 'verification', width: '150px', label: t('compliance.tbl_col_verification', 'Verification') },
        { id: 'last_run', width: '84px', label: t('compliance.tbl_col_last_run', 'Last run'), foldBelow: 1180 },
        { id: 'actions', width: '170px', label: '', align: 'right' },
    ];
}

export function ChecksToolbar({ pill, onPill, counts, sort, onSort, query, onQuery, testId = 'checks-toolbar' }) {
    const { t } = useTranslation();
    const pillOptions = STATUS_PILLS.map((value) => {
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
            <div className="hidden md:flex items-center gap-2 text-[11px] text-[var(--text-tertiary)]" data-testid={`${testId}-legend`}>
                <VerificationChip verification="automated" testId={`${testId}-legend-auto`} />
                <VerificationChip verification="attestation" testId={`${testId}-legend-attested`} />
            </div>
            <label className="ml-auto relative flex items-center" style={{ width: 200 }}>
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
    const [openIds, setOpenIds] = useState(() => new Set(focusId ? [focusId] : []));

    // A new focus target (navigated again from the overview) opens too.
    useEffect(() => {
        if (!focusId) return;
        setOpenIds((prev) => (prev.has(focusId) ? prev : new Set([...prev, focusId])));
    }, [focusId]);

    const toggle = useCallback((id) => {
        setOpenIds((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });
    }, []);

    const list = Array.isArray(checks) ? checks : [];
    const counts = useMemo(() => countByStatus(list), [list]);
    const titleOf = useCallback((c) => t(c.titleKey, c.check_id), [t]);
    const rows = useMemo(
        () => sortChecks(filterBySearch(filterByStatus(list, pill), query, titleOf), sort, regulation),
        [list, pill, query, titleOf, sort, regulation],
    );
    const columns = useMemo(() => checkColumns(t), [t]);

    const renderRow = (check) => {
        const id = check.check_id;
        const expanded = openIds.has(id);
        const rowTestId = `${testId}-row-${id}`;
        return (
            <>
                <CheckRow
                    check={check}
                    regulation={regulation}
                    columns={columns}
                    expanded={expanded}
                    onToggle={toggle}
                    focus={focusId === id}
                    rerunning={rerunningId === id}
                    autoFixing={autoFixingId === id}
                    onRerun={onRerun}
                    onAutoFix={onAutoFix}
                    onOpenLink={onOpenLink}
                    canOpenLink={canOpenLink}
                    lastRunAt={lastRunAt}
                    now={now}
                    testId={rowTestId}
                />
                {expanded && (
                    <CheckExpansion
                        check={check}
                        regulation={regulation}
                        exportsEnabled={exportsEnabled}
                        dl={dl}
                        loadTrail={loadTrail}
                        onOpenLink={onOpenLink}
                        canOpenLink={canOpenLink}
                        onAutoFix={onAutoFix}
                        autoFixing={autoFixingId === id}
                        onDecide={onDecide}
                        testId={`${rowTestId}-expansion`}
                    />
                )}
            </>
        );
    };

    // Phone (1h): one ≥44px card per check; tapping opens the same expansion.
    const renderCard = (check) => {
        const id = check.check_id;
        const expanded = openIds.has(id);
        const rowTestId = `${testId}-row-${id}`;
        return (
            <div className="w-full min-w-0 flex flex-col" data-testid={`${testId}-card-${id}`}>
                <CheckCard
                    check={check}
                    regulation={regulation}
                    expanded={expanded}
                    onToggle={toggle}
                    lastRunAt={lastRunAt}
                    now={now}
                    testId={rowTestId}
                />
                {expanded && (
                    <CheckExpansion
                        check={check}
                        regulation={regulation}
                        exportsEnabled={exportsEnabled}
                        dl={dl}
                        loadTrail={loadTrail}
                        onOpenLink={onOpenLink}
                        canOpenLink={canOpenLink}
                        onAutoFix={onAutoFix}
                        autoFixing={autoFixingId === id}
                        onDecide={onDecide}
                        testId={`${rowTestId}-expansion`}
                    />
                )}
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
                rowKey={(c) => `${c.check_id}:${c.scope_id || ''}`}
                renderRow={renderRow}
                renderCard={renderCard}
                isMobile={isMobile}
                loading={loading && list.length === 0}
                empty={empty}
                ariaLabel={t('compliance.tbl_aria', 'Compliance checks')}
                testId={`${testId}-table`}
            />
        </div>
    );
}
