import { Loader2, Plus } from 'lucide-react';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import InstallBlueprintButton from './InstallBlueprintButton';
import InstallBlueprintModal from './InstallBlueprintModal';
import { operatedStagesOf } from './pipeline/stagesApi';
import { filterSolutions, partitionSolutions } from './solutionOverviewModel';
import { CatalogueTab, EmptyOurs, GridSkeleton, OperatedStages, OverviewFilters, OverviewNotices, SolutionGrid } from './SolutionsOverviewParts';
import { useTranslation } from '../../../../hooks/useTranslation';
import { API_BASE, authFetch } from '../../../../utils/helpers';
import SegmentedControl from '../../../shared/SegmentedControl';

/**
 * The Solutions overview: three tabs and a card per Solution.
 *
 * ── The tabs ───────────────────────────────────────────────────────────────
 *
 *   From us     the Solutions built here
 *   Installed n the ones that came out of a Blueprint
 *   Catalogue   the Blueprints kept on this instance, ready to install
 *
 * The first two are a PARTITION of everything GET /api/projects/summary
 * returned — see solutionOverviewModel.tabOf for why the split is "did this
 * come from a Blueprint" rather than "do I own it", and what went wrong with
 * the second reading. A cross-instance "Bee Flow catalogue" is deliberately not
 * here: the catalogue is this organisation's own Blueprints, org-scoped by
 * blueprintStore, and nothing on this screen reaches past that.
 *
 * ── What this screen must never do ─────────────────────────────────────────
 *
 * Say "there are none" when it means "I could not find out". Three separate
 * lists can fail here and each says so in its own words: the overview itself,
 * the Blueprint catalogue, and — per card, and per number on that card — the
 * tallies inside a row. The summary route was built to make those distinctions
 * expressible; this screen is where they either survive or quietly become
 * zeroes. Every empty state below is therefore reachable only from a SUCCESSFUL
 * read.
 */

function NewSolutionForm({ onCreated, focus = false }) {
    const { t } = useTranslation();
    const [name, setName] = useState('');
    const inputRef = useRef(null);
    // `studio/solutions/new` (the Studio's "+ New → Solution") lands here with
    // the name field ready, instead of being read as the id of a Solution.
    useEffect(() => { if (focus) inputRef.current?.focus(); }, [focus]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');

    const create = async () => {
        if (!name.trim() || busy) return;
        setBusy(true);
        setError('');
        try {
            const res = await authFetch(`${API_BASE}/api/projects`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                // `kind` keeps it in Studio: without it the server files a new
                // row as a collaborative project workspace.
                body: JSON.stringify({ name: name.trim(), icon: '📦', kind: 'solution' }),
            });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) { setError(body.error || t('solutions.create_failed', 'Could not create it.')); return; }
            setName('');
            onCreated(body);
        } catch {
            setError(t('solutions.create_failed', 'Could not create it.'));
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="flex flex-wrap items-center gap-2">
            <input
                ref={inputRef}
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') create(); }}
                placeholder={t('solutions.name_placeholder', 'Name the Solution…')}
                aria-label={t('solutions.name_placeholder', 'Name the Solution…')}
                className="px-3 py-2 min-h-[40px] rounded-[var(--radius-sm)] text-sm border border-[var(--border-default)] bg-[var(--bg-primary)] text-[var(--text-primary)] min-w-0 flex-1 sm:flex-none sm:w-56 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]"
            />
            <button
                onClick={create}
                disabled={busy || !name.trim()}
                className="px-3 py-2 min-h-[40px] rounded-[var(--radius-sm)] text-sm font-medium flex items-center gap-1.5 bg-[var(--accent-primary)] text-[var(--accent-primary-fg,#fff)] disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)] focus-visible:ring-offset-2"
                data-testid="solutions-create"
            >
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                {t('solutions.new', 'New Solution')}
            </button>
            {error && <span role="alert" className="text-xs text-[var(--warning-ink,var(--warning))]">{error}</span>}
        </div>
    );
}

function OverviewHeader({ createRef, onCreated, onInstalled, focusCreate }) {
    const { t } = useTranslation();
    return (
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
            <div className="min-w-0 flex-1 basis-64">
                <h2 className="text-xl font-semibold text-[var(--text-primary)]">
                    {t('solutions.title', 'Solutions')}
                </h2>
                <p className="text-[13px] mt-1 text-[var(--text-secondary)]">
                    {t('solutions.intro', 'A Solution bundles automations, apps and webpages that work together — and packages as a Blueprint you can install elsewhere.')}
                </p>
            </div>
            <div ref={createRef} className="flex flex-wrap items-center gap-2 w-full md:w-auto">
                <NewSolutionForm onCreated={onCreated} focus={focusCreate} />
                {/* The Catalogue tab is the gallery now, so the button keeps
                    only the half a tab cannot do: reading a file. */}
                <InstallBlueprintButton onInstalled={onInstalled} showGallery={false} />
            </div>
        </div>
    );
}

export default function SolutionsOverview({ summary, onOpen, onCreated, onInstalled, onOpenStage, onRetry, focusCreate = false }) {
    const { t } = useTranslation();
    const [tab, setTab] = useState('ours');
    const [source, setSource] = useState(null);
    const [query, setQuery] = useState('');
    const [scope, setScope] = useState('all');
    const createRef = useRef(null);

    const { ours, installed } = useMemo(() => partitionSolutions(summary.rows), [summary.rows]);
    const loading = summary.status === 'loading';
    const operated = useMemo(() => operatedStagesOf(summary.operatedStages), [summary.operatedStages]);
    const filtering = query.trim() !== '' || scope !== 'all';
    const shownOurs = useMemo(() => filterSolutions(ours, { query, scope }), [ours, query, scope]);
    const shownInstalled = useMemo(() => filterSolutions(installed, { query, scope }), [installed, query, scope]);

    const options = [
        { value: 'ours', label: t('solutions.tab_ours', 'From us') },
        {
            value: 'installed',
            label: t('solutions.tab_installed', 'Installed'),
            // No badge until the read succeeded. A "0" over a failed request is
            // the exact claim this screen is not allowed to make.
            badge: summary.status === 'ok' ? installed.length : null,
        },
        { value: 'catalogue', label: t('solutions.tab_catalogue', 'Catalogue') },
    ];
    const noMatch = t('solutions.filter_no_match', 'No Solution matches this search or filter.');

    const emptyOurs = filtering
        ? noMatch
        : <EmptyOurs onCreate={() => createRef.current?.querySelector('input')?.focus()} onInstall={() => setTab('catalogue')} />;

    return (
        <div className="h-full overflow-y-auto">
            <div className="max-w-6xl mx-auto px-4 md:px-6 py-6 space-y-6">
                <OverviewHeader createRef={createRef} onCreated={onCreated} onInstalled={onInstalled} focusCreate={focusCreate} />

                <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
                    <SegmentedControl
                        value={tab}
                        onChange={setTab}
                        options={options}
                        size="sm"
                        ariaLabel={t('solutions.title', 'Solutions')}
                    />
                    {tab !== 'catalogue' && (
                        <OverviewFilters query={query} onQuery={setQuery} scope={scope} onScope={setScope} />
                    )}
                </div>

                {tab === 'catalogue' ? (
                    <CatalogueTab onInstall={(id) => setSource({ blueprintId: id })} />
                ) : (
                    <>
                        <OverviewNotices summary={summary} onRetry={onRetry} />
                        {loading ? (
                            <GridSkeleton />
                        ) : summary.status === 'error' ? null : tab === 'installed' ? (
                            <SolutionGrid
                                rows={shownInstalled}
                                filtered={filtering}
                                empty={filtering ? noMatch : t('solutions.installed_empty',
                                    'Nothing here came from a Blueprint yet. Install one from the Catalogue, or from a file.')}
                                onOpen={onOpen}
                            />
                        ) : (
                            <>
                                <SolutionGrid rows={shownOurs} filtered={filtering} empty={emptyOurs} onOpen={onOpen} />
                                {summary.status === 'ok' && <OperatedStages stages={operated} onOpenStage={onOpenStage} />}
                            </>
                        )}
                    </>
                )}
            </div>

            <InstallBlueprintModal
                open={!!source}
                source={source}
                onClose={() => setSource(null)}
                onInstalled={onInstalled}
            />
        </div>
    );
}
