import { AlertTriangle, Info, Search } from 'lucide-react';
import React from 'react';
import SolutionCard from './SolutionCard';
import SolutionCardSkeleton from './SolutionCardSkeleton';
import { Strip, sectionNames } from './solutionNotices';
import useRemote from './useRemote';
import { useTranslation } from '../../../../hooks/useTranslation';
import { API_BASE } from '../../../../utils/helpers';
import EmptyState from '../../../shared/EmptyState';
import FilterPills from '../../../shared/FilterPills';
import { kindTileStyle } from '../../../shared/kindColors';

/* The grids, notices and tabs of the Solutions overview (SolutionsOverview.jsx composes them). */

type Row = Record<string, any>;

/**
 * Cards, or the one true reason there are none.
 *
 * The empty sentence arrives already TRANSLATED rather than as a key to look
 * up. A key handed over in a prop is a key i18nGuard cannot see — it scans for
 * literal `t('…')` calls and for a fixed list of carrier properties, and a
 * home-made `emptyKey=` is neither. It would go missing from the dictionaries
 * one day and nothing would go red.
 */
export function SolutionGrid({ rows, empty, onOpen, filtered = false }: { rows: Row[]; empty: React.ReactNode; onOpen?: (row: Row) => void; filtered?: boolean }) {
    if (rows.length === 0) {
        if (typeof empty !== 'string') return <>{empty}</>;
        return (
            <p className="px-3 py-2.5 rounded-[var(--radius-md)] text-sm bg-[var(--bg-secondary)] text-[var(--text-tertiary)]" data-testid="solutions-empty">
                {empty}
            </p>
        );
    }
    return (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4" data-filtered={filtered || undefined}>
            {rows.map(row => <SolutionCard key={row.id} row={row} onOpen={onOpen} />)}
        </div>
    );
}

/** Six placeholder cards while the overview loads. */
export function GridSkeleton() {
    const { t } = useTranslation();
    return (
        <div aria-busy="true" aria-label={t('solutions.loading', 'Loading Solutions')} data-testid="solutions-loading"
             className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
            {[0, 1, 2, 3, 4, 5].map(i => <SolutionCardSkeleton key={i} />)}
        </div>
    );
}

/**
 * The Blueprints kept on this instance.
 *
 * Loaded when the tab opens rather than with the screen: most visits never come
 * here, and the list is org-wide. An empty catalogue and one that could not be
 * listed get different sentences — the second is the same sentence the install
 * button's own gallery uses, because it is the same failure.
 */
export function CatalogueTab({ onInstall }: { onInstall: (id: string) => void }) {
    const { t } = useTranslation();
    const catalogue = useRemote(`${API_BASE}/api/projects/package/blueprints`, true);
    const blueprints: Row[] = (catalogue.data as { blueprints?: Row[] } | null)?.blueprints || [];

    if (catalogue.status === 'loading' || catalogue.status === 'idle') {
        return (
            <GridSkeleton />
        );
    }
    if (catalogue.status === 'error') {
        return (
            <Strip tone="var(--warning)" icon={AlertTriangle} testId="solutions-catalogue-unavailable">
                {t('solutions.install_gallery_failed',
                    'The Blueprints kept on this instance could not be listed, so this is not "there are none". Installing from a file still works.')}
            </Strip>
        );
    }
    if (blueprints.length === 0) {
        return (
            <p className="px-3 py-2.5 rounded-[var(--radius-md)] text-sm bg-[var(--bg-secondary)] text-[var(--text-tertiary)]" data-testid="solutions-catalogue-empty">
                {t('solutions.catalogue_empty',
                    'No Blueprints are kept on this instance yet. Publish a Solution and it appears here for colleagues to install.')}
            </p>
        );
    }
    return (
        <div className="space-y-3">
            <p className="text-xs text-[var(--text-tertiary)]">
                {t('solutions.catalogue_intro',
                    'Installing one of these creates a new Solution. Everything arrives as a draft.')}
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
                {blueprints.map(b => {
                    const tile = kindTileStyle('solution', 36);
                    return (
                        <div key={b.id} className="flex flex-col gap-3 p-4 lg:p-5 rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--bg-card)]"
                             data-testid="solutions-catalogue-card">
                            <div className="flex items-start gap-2.5">
                                <span style={tile.tile} aria-hidden="true">
                                    <span className="text-lg leading-none">{b.icon || '📦'}</span>
                                </span>
                                <div className="flex-1 min-w-0">
                                    <span className="block text-[15px] font-semibold truncate text-[var(--text-primary)]">
                                        {b.name}
                                    </span>
                                    <span className="block text-[11px] text-[var(--text-tertiary)]">
                                        {t('solutions.blueprint_version', 'Blueprint v{version}', { version: b.version })}
                                    </span>
                                </div>
                            </div>
                            {b.description && (
                                <p className="text-[13px] line-clamp-2 text-[var(--text-secondary)]">{b.description}</p>
                            )}
                            <button
                                type="button"
                                onClick={() => onInstall(b.id)}
                                className="mt-auto self-start px-3 py-2 min-h-[40px] rounded-[var(--radius-sm)] text-xs font-medium border border-[var(--border-default)] text-[var(--text-primary)] hover:bg-[var(--bg-card-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]"
                                data-testid="solutions-catalogue-install"
                            >
                                {t('solutions.install_confirm', 'Install')}
                            </button>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

/**
 * What the overview could not tell you, above the cards it could.
 *
 * `unavailable` names the gaps that hit every card at once, so they are said
 * once here instead of twenty times below; a gap that belongs to a single
 * Solution stays on that Solution's card.
 */
export function OverviewNotices({ summary, onRetry }: { summary: Row; onRetry?: () => void }) {
    const { t } = useTranslation();
    const gaps = sectionNames(summary.unavailable, t);
    return (
        <>
            {summary.status === 'error' && (
                <div role="alert" data-testid="solutions-overview-unavailable"
                     className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5 rounded-[var(--radius-md)] text-sm border-l-2 border-[var(--error)] bg-[var(--bg-secondary)] text-[var(--text-primary)]">
                    <AlertTriangle className="w-4 h-4 flex-shrink-0 text-[var(--error)]" aria-hidden="true" />
                    <span className="flex-1 basis-60">
                        {t('solutions.overview_failed',
                            'The overview could not be loaded, so this is not "you have no Solutions". Try again shortly.')}
                    </span>
                    {onRetry && (
                        <button type="button" onClick={onRetry} data-testid="solutions-overview-retry"
                                className="px-3 py-1.5 min-h-[40px] rounded-[var(--radius-sm)] text-xs font-medium border border-[var(--border-default)] text-[var(--text-primary)] hover:bg-[var(--bg-card-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]">
                            {t('solutions.overview_retry', 'Retry')}
                        </button>
                    )}
                </div>
            )}
            {summary.status === 'ok' && gaps.length > 0 && (
                <Strip tone="var(--warning)" icon={AlertTriangle} testId="solutions-overview-partial">
                    {t('solutions.overview_partial',
                        'Not all of this could be read: {sections}. What is missing is left blank on the cards rather than shown as nothing.',
                        { sections: gaps.join(', ') })}
                </Strip>
            )}
            {summary.status === 'ok' && summary.hasMore && (
                <Strip tone="var(--text-tertiary)" icon={Info} testId="solutions-overview-more">
                    {t('solutions.overview_more',
                        'Only the {count} most recently changed Solutions are shown here.',
                        { count: summary.rows.length })}
                </Strip>
            )}
        </>
    );
}

/**
 * Stages the caller operates whose Dev Solution they cannot open: the entry
 * point for someone who was given UAT or Production and nothing else. Built
 * from the `operatedStages` list of /summary, never from a fetch per row.
 */
export function OperatedStages({ stages, onOpenStage }: { stages: Row[]; onOpenStage?: (s: Row) => void }) {
    const { t } = useTranslation();
    if (stages.length === 0) return null;
    const stageName: Record<string, string> = {
        uat: t('solution_stages.stage_uat', 'UAT'),
        prd: t('solution_stages.stage_prd', 'Production'),
    };
    return (
        <section className="space-y-2" data-testid="solutions-operated-stages">
            <h3 className="text-[11px] uppercase tracking-wide text-[var(--text-tertiary)]">
                {t('solution_stages.operated_title', 'Operated stages')}
            </h3>
            <ul className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
                {stages.map((s: Row) => (
                    <li key={s.projectId}>
                        <button
                            type="button"
                            onClick={() => onOpenStage?.(s)}
                            data-testid="solutions-operated-stage"
                            data-stage={s.stage}
                            className="w-full flex flex-col gap-1 p-4 rounded-[var(--radius-lg)] text-left border border-[var(--border-subtle)] bg-[var(--bg-card)] hover:bg-[var(--bg-card-hover)] hover:border-[var(--border-default)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]"
                        >
                            <span className="text-sm font-semibold truncate text-[var(--text-primary)]">
                                {s.solutionName || t('solution_stages.operated_unnamed', 'Untitled Solution')}
                            </span>
                            <span className="text-[11px] text-[var(--text-tertiary)]">
                                {stageName[s.stage]} · {s.role}
                            </span>
                        </button>
                    </li>
                ))}
            </ul>
        </section>
    );
}


/** First-run state of the "From us" tab: create one, or install a Blueprint. */
export function EmptyOurs({ onCreate, onInstall }: { onCreate: () => void; onInstall: () => void }) {
    const { t } = useTranslation();
    return (
        <div data-testid="solutions-empty">
            <EmptyState
                className="!h-auto"
                illustration="empty-inbox"
                title={t('solutions.empty_title', 'No Solutions yet')}
                description={t('solutions.empty',
                    'Nothing here yet. Create a Solution, or install a Blueprint someone handed you.')}
                action={(
                    <div className="flex flex-wrap items-center justify-center gap-2">
                        <button type="button" onClick={onCreate}
                                className="px-3 py-2 min-h-[40px] rounded-[var(--radius-sm)] text-sm font-medium bg-[var(--accent-primary)] text-[var(--accent-primary-fg,#fff)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)] focus-visible:ring-offset-2">
                            {t('solutions.empty_create', 'Create first Solution')}
                        </button>
                        <button type="button" onClick={onInstall} data-testid="solutions-empty-install"
                                className="px-3 py-2 min-h-[40px] rounded-[var(--radius-sm)] text-sm font-medium border border-[var(--border-default)] text-[var(--text-primary)] hover:bg-[var(--bg-card-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]">
                            {t('solutions.empty_install', 'Install a Blueprint')}
                        </button>
                    </div>
                )}
            />
        </div>
    );
}

interface FiltersProps { query: string; onQuery: (q: string) => void; scope: string; onScope: (s: string) => void }

/** Search box and the All / Mine / Needs attention pills. */
export function OverviewFilters({ query, onQuery, scope, onScope }: FiltersProps) {
    const { t } = useTranslation();
    const scopes = [
        { value: 'all', label: t('solutions.filter_all', 'All') },
        { value: 'mine', label: t('solutions.filter_mine', 'Mine') },
        { value: 'attention', label: t('solutions.filter_attention', 'Needs attention') },
    ];
    return (
        <>
            <label className="relative flex-1 basis-48 max-w-sm">
                <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)] pointer-events-none" aria-hidden="true" />
                <input
                    type="search"
                    value={query}
                    onChange={(e) => onQuery(e.target.value)}
                    placeholder={t('solutions.search_placeholder', 'Search Solutions')}
                    aria-label={t('solutions.search_placeholder', 'Search Solutions')}
                    data-testid="solutions-search"
                    className="w-full pl-9 pr-3 py-2 min-h-[40px] rounded-[var(--radius-sm)] text-sm border border-[var(--border-default)] bg-[var(--bg-primary)] text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]"
                />
            </label>
            {React.createElement(FilterPills as unknown as React.ComponentType<Record<string, unknown>>, {
                value: scope,
                onChange: onScope,
                options: scopes,
                ariaLabel: t('solutions.filter_label', 'Filter Solutions'),
                testId: 'solutions-scope',
            })}
        </>
    );
}
