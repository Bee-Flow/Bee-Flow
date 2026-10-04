import React, { useEffect, useMemo, useRef } from 'react';
import ExecutionRow, { FROM_WIDE, FROM_WIDEST, RUN_LOG_GRID } from './ExecutionRow';
import ExecutionsFilterBar from './ExecutionsFilterBar';
import { canOpenRun, runStreamEnabled } from './runScope';
import useExecutions from './useExecutions';
import useRunStream from './useRunStream';
import useAutomationApi from '../../../../hooks/useAutomationApi';
import { useTranslation } from '../../../../hooks/useTranslation';
import { dayBucketLabel } from '../AutomationsStudio/historyUtils';

/**
 * The runs list — status / what ran / what happened / timing / trigger, in
 * sentences rather than machine words (runLanguage.js). Server-side filters +
 * cursor pagination (infinite scroll) + live SSE updates, grouped under
 * sticky day headers. Clicking a row opens it full-screen via `onOpenRun`.
 *
 * scope: 'global' shows the Name column + an automation picker; 'automation'
 * and 'step' are fixed to one id. `active=false` (hidden-mounted panel)
 * stands fetching and streaming down entirely.
 *
 * runScope: 'mine' (default) | 'org' — WHOSE runs, which is a different
 * question from WHICH (runScope.js). Only the global surface has both, and
 * only the owning screen may set it; the value the HOOK reports back is the
 * one this component obeys, because that one has been through
 * effectiveRunScope.
 */
export default function ExecutionsTable({ scope, automationId, stepId, runScope = 'mine', active = true, onOpenRun, onOpenEditor }) {
    const api = useAutomationApi();
    const { t } = useTranslation();
    const {
        rows, loading, loadingMore, error, hasMore, loadMore, refresh,
        filters, setFilters, facets, applyEvent, patchRow,
        runScope: activeRunScope,
    } = useExecutions({ scope, automationId, stepId, runScope, enabled: active });

    // Live updates merge into the list — in the PERSONAL scope only. The
    // stream drops other people's events and its polling fallback reads the
    // user-scoped list, so leaving it on for the organisation's log would keep
    // the viewer's own rows ticking inside everybody's and freeze the rest: a
    // list that looks live and is not. `liveState` then reports 'paused',
    // which the filter bar already draws, and RunsStudio says it in words.
    const streaming = runStreamEnabled(activeRunScope);
    const { state: liveState } = useRunStream({
        enabled: active && streaming,
        automationId: scope === 'global' ? null : (automationId || stepId),
        onEvent: applyEvent,
    });

    const isGlobal = scope === 'global';

    // Sticky automation options for the global picker — accumulated from rows so
    // filtering by one automation doesn't drop the others from the dropdown.
    //
    // AND EMPTIED WHEN THE SCOPE CHANGES, which it was not. The map is fed from
    // whatever rows happen to have been loaded, so a visit to the organisation
    // scope filled it with colleagues' automation NAMES — and switching back to
    // "my runs" kept them in the dropdown. The rows were scoped correctly the
    // whole time; the picker above them was not, so the scoping lived in the
    // query and leaked in the chrome.
    //
    // Reset during render rather than in an effect: an effect would let one
    // paint go out with the previous scope's names still listed.
    const seenAutosRef = useRef(new Map());
    const seenScopeRef = useRef(runScope);
    if (seenScopeRef.current !== runScope) {
        seenScopeRef.current = runScope;
        seenAutosRef.current = new Map();
    }
    if (isGlobal) {
        for (const r of rows) if (r.automationId && r.automationTitle) seenAutosRef.current.set(r.automationId, r.automationTitle);
    }
    const automationOptions = useMemo(
        () => [...seenAutosRef.current.entries()].map(([id, title]) => ({ id, title })).sort((a, b) => a.title.localeCompare(b.title)),
        // eslint-disable-next-line react-hooks/exhaustive-deps -- the ref's Map is rebuilt during render from rows/runScope; they are the invalidation signal
        [rows, runScope],
    );

    // Infinite scroll sentinel.
    const sentinelRef = useRef(null);
    useEffect(() => {
        const el = sentinelRef.current;
        if (!el || !hasMore) return undefined;
        const io = new IntersectionObserver((entries) => {
            if (entries.some(e => e.isIntersecting)) loadMore();
        }, { rootMargin: '200px' });
        io.observe(el);
        return () => io.disconnect();
    }, [hasMore, loadMore]);

    // Day buckets — 200 rows of "Started 3h ago" carry no shape without them.
    const rowsWithDays = useMemo(() => {
        const out = [];
        let lastDay = null;
        for (const run of rows) {
            const day = dayBucketLabel(run.startedAt);
            if (day !== lastDay) { out.push({ day, key: `day:${day}:${run.id}` }); lastDay = day; }
            out.push({ run, key: run.id });
        }
        return out;
    }, [rows]);

    // The list adapts by its OWN width (@container/runlog; the sidebar takes a
    // share of the screen), and on a wide screen it stays in one centred
    // column, the same 110rem as the library overview, so the filters sit
    // above the rows they act on. Columns per stage: ExecutionRow.
    return (
        <div className="@container/runlog flex flex-col h-full min-h-0">
            <ExecutionsFilterBar
                filters={filters}
                setFilters={setFilters}
                facets={facets}
                liveState={liveState}
                onRefresh={refresh}
                onOpenRunById={(id) => onOpenRun({ id })}
                showAutomationPicker={isGlobal}
                automationOptions={automationOptions}
                showModePicker={scope !== 'step'}
            />

            <div className="flex-shrink-0">
                <div className={`${RUN_LOG_GRID} mx-auto max-w-[110rem] px-4 py-1.5 border-b border-[var(--border-default)] text-[10px] uppercase tracking-wide font-semibold text-[var(--text-tertiary)]`}>
                    <span>{t('runs.log.col_outcome', 'Outcome')}</span>
                    <span>{t('runs.log.col_what_ran', 'What ran')}</span>
                    <span className={FROM_WIDE}>{t('runs.tab.what_happened', 'What happened')}</span>
                    <span className={FROM_WIDEST}>{t('runs.log.col_steps', 'Steps')}</span>
                    <span>{t('runs.log.col_started', 'Started')}</span>
                    <span className={FROM_WIDE}>{t('runs.log.col_took', 'Took')}</span>
                    <span className={FROM_WIDEST}>{t('runs.log.col_started_by', 'Started by')}</span>
                    <span />
                </div>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto">
                <div className="mx-auto max-w-[110rem]">
                {loading ? (
                    <div className="py-10 text-center text-sm text-[var(--text-tertiary)]">Loading runs…</div>
                ) : error ? (
                    <div className="py-10 text-center space-y-2">
                        <div className="text-sm text-red-600 dark:text-red-400">We couldn't load the runs.</div>
                        {/* refresh exists on the hook but used to be reachable
                            only from the filter bar — which this branch never
                            rendered. A dead end with a working retry one
                            variable away. */}
                        <button
                            type="button"
                            onClick={refresh}
                            className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition"
                        >
                            Try again
                        </button>
                    </div>
                ) : rows.length === 0 ? (
                    <EmptyState scope={scope} range={filters.range} onShowAllTime={() => setFilters(prev => ({ ...prev, range: 'all' }))} />
                ) : (
                    <>
                        {rowsWithDays.map(entry => (entry.run ? (
                            <ExecutionRow
                                key={entry.key}
                                run={entry.run}
                                isGlobal={isGlobal}
                                api={api}
                                patchRow={patchRow}
                                refresh={refresh}
                                /* Every per-run route — open, retry, cancel,
                                   approve — is scoped to the run's OWNER and
                                   403s for anybody else, org admin included.
                                   So a colleague's row in the organisation's
                                   log is shown and not opened, rather than
                                   opened into an error. */
                                canOpen={canOpenRun(entry.run, activeRunScope)}
                                onOpen={() => onOpenRun(entry.run)}
                                onOpenEditor={onOpenEditor}
                            />
                        ) : (
                            <div
                                key={entry.key}
                                className="sticky top-0 z-10 px-4 py-1 text-[10px] uppercase tracking-wide font-semibold text-[var(--text-tertiary)] bg-[var(--bg-primary)] border-b border-[var(--border-subtle,var(--border-default))]"
                            >
                                {entry.day}
                            </div>
                        )))}
                        {hasMore && (
                            <div ref={sentinelRef} className="py-4 text-center text-xs text-[var(--text-tertiary)]">
                                {loadingMore ? 'Loading more…' : ' '}
                            </div>
                        )}
                    </>
                )}
                </div>
            </div>
        </div>
    );
}

function EmptyState({ scope, range, onShowAllTime }) {
    if (range && range !== 'all') {
        return (
            <div className="py-12 text-center px-6 space-y-2">
                <div className="text-sm text-[var(--text-primary)]">No runs in this time range.</div>
                <div className="text-xs text-[var(--text-secondary)]">Older runs are still here — widen the time range to see them.</div>
                <button
                    type="button"
                    onClick={onShowAllTime}
                    className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition"
                >
                    Show all time
                </button>
            </div>
        );
    }
    const msg = scope === 'step'
        ? 'No runs yet. Test this Step or call it from an automation to see its runs.'
        : 'No runs yet. Run the automation to see what happened here, step by step.';
    return (
        <div className="py-12 text-center text-sm text-[var(--text-tertiary)] px-6">{msg}</div>
    );
}
