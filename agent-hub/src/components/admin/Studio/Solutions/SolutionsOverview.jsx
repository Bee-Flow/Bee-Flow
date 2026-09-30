import { AlertTriangle, Info, Loader2, Plus } from 'lucide-react';
import React, { useMemo, useState } from 'react';
import InstallBlueprintButton from './InstallBlueprintButton';
import InstallBlueprintModal from './InstallBlueprintModal';
import SolutionCard from './SolutionCard';
import { Strip, sectionNames } from './solutionNotices';
import { partitionSolutions } from './solutionOverviewModel';
import useRemote from './useRemote';
import { useTranslation } from '../../../../hooks/useTranslation';
import { API_BASE, authFetch } from '../../../../utils/helpers';
import { kindTileStyle } from '../../../shared/kindColors';
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

function NewSolutionForm({ onCreated }) {
    const { t } = useTranslation();
    const [name, setName] = useState('');
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
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') create(); }}
                placeholder={t('solutions.name_placeholder', 'Name the Solution…')}
                className="px-3 py-2 rounded-lg text-sm border min-w-[200px]"
                style={{ borderColor: 'var(--border-default)', background: 'var(--bg-primary)', color: 'var(--text-primary)' }}
            />
            <button
                onClick={create}
                disabled={busy || !name.trim()}
                className="px-3 py-2 rounded-lg text-sm font-medium flex items-center gap-1 text-white disabled:opacity-50"
                style={{ background: 'var(--accent-primary)' }}
                data-testid="solutions-create"
            >
                {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                {t('solutions.new', 'New Solution')}
            </button>
            {error && <span className="text-xs" style={{ color: 'var(--warning)' }}>{error}</span>}
        </div>
    );
}

/**
 * Cards, or the one true reason there are none.
 *
 * The empty sentence arrives already TRANSLATED rather than as a key to look
 * up. A key handed over in a prop is a key i18nGuard cannot see — it scans for
 * literal `t('…')` calls and for a fixed list of carrier properties, and a
 * home-made `emptyKey=` is neither. It would go missing from the dictionaries
 * one day and nothing would go red.
 */
function SolutionGrid({ rows, empty, onOpen }) {
    if (rows.length === 0) {
        return (
            <p className="px-3 py-2.5 rounded-lg text-sm" data-testid="solutions-empty"
               style={{ background: 'var(--bg-secondary)', color: 'var(--text-tertiary)' }}>
                {empty}
            </p>
        );
    }
    return (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {rows.map(row => <SolutionCard key={row.id} row={row} onOpen={onOpen} />)}
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
function CatalogueTab({ onInstall }) {
    const { t } = useTranslation();
    const catalogue = useRemote(`${API_BASE}/api/projects/package/blueprints`, true);
    const blueprints = catalogue.data?.blueprints || [];

    if (catalogue.status === 'loading' || catalogue.status === 'idle') {
        return (
            <div className="flex items-center justify-center py-12" style={{ color: 'var(--text-tertiary)' }}>
                <Loader2 className="w-5 h-5 animate-spin" />
            </div>
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
            <p className="px-3 py-2.5 rounded-lg text-sm" data-testid="solutions-catalogue-empty"
               style={{ background: 'var(--bg-secondary)', color: 'var(--text-tertiary)' }}>
                {t('solutions.catalogue_empty',
                    'No Blueprints are kept on this instance yet. Publish a Solution and it appears here for colleagues to install.')}
            </p>
        );
    }
    return (
        <div className="space-y-3">
            <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                {t('solutions.catalogue_intro',
                    'Installing one of these creates a new Solution. Everything arrives as a draft.')}
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {blueprints.map(b => {
                    const tile = kindTileStyle('solution', 36);
                    return (
                        <div key={b.id} className="flex flex-col gap-2.5 p-3.5 rounded-xl border"
                             data-testid="solutions-catalogue-card"
                             style={{ background: 'var(--bg-card)', borderColor: 'var(--border-default)' }}>
                            <div className="flex items-start gap-2.5">
                                <span style={tile.tile} aria-hidden="true">
                                    <span className="text-lg leading-none">{b.icon || '📦'}</span>
                                </span>
                                <div className="flex-1 min-w-0">
                                    <span className="block text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                                        {b.name}
                                    </span>
                                    <span className="block text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                                        {t('solutions.blueprint_version', 'Blueprint v{version}', { version: b.version })}
                                    </span>
                                </div>
                            </div>
                            {b.description && (
                                <p className="text-xs line-clamp-2" style={{ color: 'var(--text-secondary)' }}>{b.description}</p>
                            )}
                            <button
                                type="button"
                                onClick={() => onInstall(b.id)}
                                className="mt-auto self-start px-3 py-1.5 rounded-lg text-xs font-medium border"
                                style={{ borderColor: 'var(--border-default)', color: 'var(--text-primary)' }}
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
function OverviewNotices({ summary }) {
    const { t } = useTranslation();
    const gaps = sectionNames(summary.unavailable, t);
    return (
        <>
            {summary.status === 'error' && (
                <Strip tone="var(--error)" icon={AlertTriangle} testId="solutions-overview-unavailable">
                    {t('solutions.overview_failed',
                        'The overview could not be loaded, so this is not "you have no Solutions". Try again shortly.')}
                </Strip>
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

export default function SolutionsOverview({ summary, onOpen, onCreated, onInstalled }) {
    const { t } = useTranslation();
    const [tab, setTab] = useState('ours');
    const [source, setSource] = useState(null);

    const { ours, installed } = useMemo(() => partitionSolutions(summary.rows), [summary.rows]);
    const loading = summary.status === 'loading';

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

    return (
        <div className="h-full overflow-y-auto">
            <div className="max-w-5xl mx-auto px-6 py-6 space-y-5">
                <div>
                    <h2 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
                        {t('solutions.title', 'Solutions')}
                    </h2>
                    <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>
                        {t('solutions.intro', 'A Solution bundles routines, apps and webpages that work together — and packages as a Blueprint you can install elsewhere.')}
                    </p>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                    <NewSolutionForm onCreated={onCreated} />
                    {/* The Catalogue tab is the gallery now, so the button keeps
                        only the half a tab cannot do: reading a file. */}
                    <InstallBlueprintButton onInstalled={onInstalled} showGallery={false} />
                </div>

                <SegmentedControl
                    value={tab}
                    onChange={setTab}
                    options={options}
                    size="sm"
                    ariaLabel={t('solutions.title', 'Solutions')}
                />

                {tab === 'catalogue' ? (
                    <CatalogueTab onInstall={(id) => setSource({ blueprintId: id })} />
                ) : (
                    <>
                        <OverviewNotices summary={summary} />
                        {loading ? (
                            <div className="flex items-center justify-center py-12" style={{ color: 'var(--text-tertiary)' }}>
                                <Loader2 className="w-5 h-5 animate-spin" />
                            </div>
                        ) : summary.status === 'error' ? null : tab === 'installed' ? (
                            <SolutionGrid
                                rows={installed}
                                empty={t('solutions.installed_empty',
                                    'Nothing here came from a Blueprint yet. Install one from the Catalogue, or from a file.')}
                                onOpen={onOpen}
                            />
                        ) : (
                            <SolutionGrid
                                rows={ours}
                                empty={t('solutions.empty',
                                    'Nothing here yet. Create a Solution, or install a Blueprint someone handed you.')}
                                onOpen={onOpen}
                            />
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
