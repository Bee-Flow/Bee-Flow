import { AlertCircle, LayoutGrid, Search } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import { studioAppsApi } from '../../../components/admin/Studio/AppStudio/studioAppsApi';
import { nOf } from '../../../components/admin/Studio/KnowledgeStudio/plural';
import { useEntitlements } from '../../../components/licensing/EntitlementsContext';
import { useLicenseContext } from '../../../components/licensing/LicenseContext';
import EmptyState from '../../../components/shared/EmptyState';
import useTranslation from '../../../hooks/useTranslation';
import scopedStorage from '../../../utils/scopedStorage';
import type { TranslateParams } from '../../../hooks/useTranslation';
import type React from 'react';
import type { DirectoryApp, CategoryFilterProps, ErrorBannerProps, ToolbarProps } from '../AppsHomePage.types';
import { logger } from '../../../utils/logger';
import { APP_TILE, RECENTS_KEY, REMEMBERED, RECENTS_SHOWN, CATEGORY_LABELS, PILL_CLASSES, CARD_CLASSES, CARD_STYLE, GRID_CLASSES, GENERIC_LOAD_ERROR } from './AppsHomePage.constants';
import { categoriesInView, visibleUnder, matchesQuery, byName, isPublished } from './AppsHomePage.helpers';
import { Directory } from './Directory';
export { RECENTS_SHOWN } from './AppsHomePage.constants';

/** `{ [appId]: epochMs }`, never throwing on absent or corrupt storage. */
export function readAppRecents(): Record<string, number> {
    try {
        const parsed: Record<string, number> | null = JSON.parse(scopedStorage.getItem(RECENTS_KEY) || 'null');
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        // Drop anything that is not a usable timestamp rather than letting it
        // sort unpredictably later.
        return Object.fromEntries(
            Object.entries(parsed).filter(([, at]) => Number.isFinite(at) && at > 0),
        );
    } catch {
        return {};
    }
}

/** Stamp an app as opened by this user, now. */
export function rememberAppOpened(id: string | null, now: number = Date.now()) {
    if (!id) return;
    const next = { ...readAppRecents(), [id]: now };
    const trimmed = Object.fromEntries(
        Object.entries(next).sort((a, b) => b[1] - a[1]).slice(0, REMEMBERED),
    );
    try {
        scopedStorage.setItem(RECENTS_KEY, JSON.stringify(trimmed));
    } catch (err) { logger.debug('A full quota is not worth failing a navigation over.', err); }
}

/**
 * The apps to show under "Recently used": only the ones this reader has
 * actually opened, most recent first, capped at `limit`. An app that is no
 * longer in `apps` (unpublished, unshared, deleted) drops out on its own,
 * because the list is filtered rather than looked up.
 */
export function recentApps(apps: DirectoryApp[], limit: number = RECENTS_SHOWN, recents: Record<string, number> = readAppRecents()) {
    const list = Array.isArray(apps) ? apps : [];
    return list
        .filter((a) => a?.id && recents[a.id])
        .sort((a, b) => recents[b.id] - recents[a.id])
        .slice(0, Math.max(0, limit));
}

function CategoryFilter({ categories, value, onChange, t }: CategoryFilterProps) {
    // No categorised app in the directory means nothing to filter by — a row
    // with a lone "All" pill is chrome that does nothing.
    if (categories.length === 0) return null;
    return (
        <div
            className="flex flex-wrap gap-1.5"
            role="group"
            aria-label={t('apps.filter_by_category', 'Filter apps by category')}
        >
            {['all', ...categories].map((key) => {
                const active = key === value;
                const label = key === 'all'
                    ? t('apps.category.all', 'All')
                    : CATEGORY_LABELS[key](t);
                return (
                    <button
                        key={key}
                        type="button"
                        onClick={() => onChange(key)}
                        aria-pressed={active}
                        className={PILL_CLASSES}
                        style={active
                            ? { borderColor: 'var(--accent-primary)', background: 'var(--accent-primary)', color: '#fff' }
                            : { borderColor: 'var(--border-subtle)', background: 'var(--bg-card)', color: 'var(--text-secondary)' }}
                    >
                        {label}
                    </button>
                );
            })}
        </div>
    );
}

function ErrorBanner({ message, onRetry }: ErrorBannerProps) {
    const { t } = useTranslation();
    // A message the failure carried is shown as-is; it is the server's own
    // words and there is no key to look it up under. Only GENERIC_LOAD_ERROR,
    // the marker for "it broke and said nothing", is ours to translate.
    const text = typeof message === 'string' && message
        ? message
        : t('apps.load_failed', 'Could not load your apps.');
    return (
        <div
            className="shrink-0 px-4 py-2 text-xs flex items-center gap-2"
            // Tokens, not the two hard-coded reds this strip used to carry: a
            // 14% tint of the status colour with the darker -ink for the
            // words, the pairing index.css defines for every status chip.
            style={{
                background: 'color-mix(in srgb, var(--error) 14%, transparent)',
                color: 'var(--error-ink)',
            }}
            role="alert"
        >
            <AlertCircle className="w-3.5 h-3.5 shrink-0" /> {text}
            <button type="button" onClick={onRetry} className="ml-auto underline font-medium">
                {t('apps.retry', 'Retry')}
            </button>
        </div>
    );
}

function SkeletonGrid() {
    const { t } = useTranslation();
    return (
        <div className={GRID_CLASSES} role="status" aria-label={t('apps.loading', 'Loading apps')}>
            {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className={`${CARD_CLASSES} animate-pulse`} style={CARD_STYLE}>
                    <div className="flex items-start gap-2.5">
                        <div className="h-8 w-8 rounded-lg bg-[var(--bg-secondary)]" />
                        <div className="flex-1 pt-0.5">
                            <div className="h-3.5 w-2/3 rounded mb-2 bg-[var(--bg-secondary)]" />
                            <div className="h-2.5 w-full rounded bg-[var(--bg-secondary)]" />
                        </div>
                    </div>
                </div>
            ))}
            <span className="sr-only">{t('apps.loading_short', 'Loading…')}</span>
        </div>
    );
}

function Toolbar({ count, query, onQuery, canBuild }: ToolbarProps) {
    const { t } = useTranslation();
    // Pinned at 48px — the height every screen's header keeps.
    return (
        <div
            data-testid="apps-toolbar"
            className="shrink-0 h-12 px-4 border-b flex items-center gap-3 border-[var(--border-subtle)]"
        >
            <div className="flex items-center gap-2 min-w-0">
                {/* The tile is the APP kind's colour, from the one module
                    that owns it — the same mark the Studio rail, the New
                    menu and every reference pill use for an app. */}
                <span style={APP_TILE.tile}>
                    <LayoutGrid style={APP_TILE.glyph} aria-hidden="true" />
                </span>
                <h1 className="text-sm font-semibold truncate text-[var(--text-primary)]">
                    {t('apps.title', 'Apps')}
                </h1>
                {count !== null && (
                    <span
                        className="hidden sm:inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] border-[var(--border-subtle)] text-[var(--text-secondary)]"
                    >
                        {nOf(t, 'apps.published_count', count, '{count} published', '{count} published')}
                    </span>
                )}
            </div>

            <div className="ml-auto flex items-center gap-2 min-w-0">
                {count !== null && (
                    <div className="relative min-w-0 flex-1 sm:flex-none sm:w-[230px]">
                        <Search
                            className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none text-[var(--text-tertiary)]"
                            aria-hidden="true"
                        />
                        <input
                            type="search"
                            value={query}
                            onChange={(e) => onQuery(e.target.value)}
                            placeholder={t('apps.search_placeholder', 'Search apps…')}
                            aria-label={t('apps.search_placeholder', 'Search apps…')}
                            className="w-full rounded-lg border pl-7 pr-2 py-1 text-xs outline-none"
                            style={{
                                borderColor: 'var(--border-subtle)',
                                background: 'var(--bg-card)',
                                color: 'var(--text-primary)',
                            }}
                        />
                    </div>
                )}
                {canBuild && (
                    <a
                        href="/app/studio/apps"
                        className="shrink-0 rounded-lg border px-2.5 py-1 text-xs font-medium no-underline whitespace-nowrap border-[var(--border-subtle)] bg-[var(--bg-card)] text-[var(--text-secondary)]"
                    >
                        {t('apps.build_in_studio', 'Build in Studio')}
                    </a>
                )}
            </div>
        </div>
    );
}

export default function AppsHomePage() {
    const { t } = useTranslation();
    const [apps, setApps] = useState<DirectoryApp[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | typeof GENERIC_LOAD_ERROR | null>(null);
    const [category, setCategory] = useState('all');
    const [query, setQuery] = useState('');

    // The way to the build side, for readers who have it. Same gate as the
    // sidebar's Studio > Apps row (studioApps.jsx: licence × capability) so
    // the button and the nav entry cannot disagree about who may build; both
    // context hooks answer `false` with no provider above them, which is the
    // safe way to be wrong.
    const { hasFeature } = useLicenseContext();
    const { can } = useEntitlements();
    const canBuild = !!(hasFeature?.('app_studio') && can?.('app_studio'));

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const [accessible, mine] = await Promise.all([
                studioAppsApi.listAccessible(),
                studioAppsApi.listMine(),
            ]);
            // listAccessible is already published-only server-side; filter
            // defensively. listMine holds drafts too, so keep only published.
            const shared = (accessible?.apps || []).filter(isPublished);
            const ownedPublished = (mine?.apps || []).filter(isPublished);
            // Dedupe by id (an owned app can also appear in accessible).
            const byId = new Map<string, DirectoryApp>();
            for (const a of [...shared, ...ownedPublished]) {
                if (a?.id && !byId.has(a.id)) byId.set(a.id, a);
            }
            setApps([...byId.values()].sort(byName));
        } catch (err) {
            setError((err as Error)?.message || GENERIC_LOAD_ERROR);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { load(); }, [load]);

    // Read ONCE per mount. Opening an app leaves this page, so there is nothing
    // to keep in sync while it is on screen — and a stable snapshot means the
    // section cannot reshuffle under the reader's cursor mid-click.
    const [recents] = useState(readAppRecents);
    // One clock reading per load, for the same reason: every "new" badge on
    // the screen should have been decided at the same instant.
    const [now] = useState(() => Date.now());

    // The chips come from the WHOLE directory, not from the search result:
    // a row that reshuffles itself while you type is a row you cannot aim at.
    const presentCategories = useMemo(() => categoriesInView(apps), [apps]);
    // A selection whose category vanished (a reload, an app unpublished) falls
    // back to "All" instead of leaving the reader staring at an empty grid.
    const activeCategory = presentCategories.includes(category) ? category : 'all';
    const visibleApps = useMemo(
        () => visibleUnder(apps, activeCategory).filter((a) => matchesQuery(a, query)),
        [apps, activeCategory, query],
    );
    // Recents are drawn from what the chip and the search box let through:
    // under "Service", a recently used Sales app would contradict the chip the
    // reader just pressed.
    const recentlyUsed = useMemo(
        () => recentApps(visibleApps, RECENTS_SHOWN, recents),
        [visibleApps, recents],
    );
    const isEmpty = !loading && !error && apps.length === 0;
    // A failure is not an answer. With the fetch broken and nothing in hand,
    // the page may not put the directory chrome on anyway: the counted pill,
    // the search box, "Only what you are allowed to use appears here" and the
    // footnote about who sees what are all statements about this reader's
    // ACCESS, and they would be made at the one moment the server said
    // nothing at all. The banner is then the whole page — "we could not ask"
    // has to stay distinguishable from "we asked, and it is empty".
    //
    // A retry that fails while apps are already on screen keeps them: that
    // list was really answered once, and showing it under the banner is
    // stale, not invented.
    const hasDirectory = !loading && apps.length > 0;
    // Nothing left after a search is not the same as an empty directory: the
    // reader typed something, and the answer is about what they typed.
    const noMatches = hasDirectory && visibleApps.length === 0;

    return (
        <div className="flex flex-col h-full bg-[var(--bg-primary)]">
            <Toolbar
                count={hasDirectory ? apps.length : null}
                query={query}
                onQuery={setQuery}
                canBuild={canBuild}
            />

            {error && <ErrorBanner message={error} onRetry={load} />}

            {hasDirectory && (
                <div className="shrink-0 px-4 pt-3 flex items-center flex-wrap gap-x-3 gap-y-2">
                    <CategoryFilter
                        categories={presentCategories}
                        value={activeCategory}
                        onChange={setCategory}
                        t={t}
                    />
                    {/* Why the directory is short: it is not the org's app
                        list, it is yours. Said here rather than only in the
                        footnote, because "where are the other twelve?" is
                        asked while looking at the grid. */}
                    <span className="ml-auto text-[11px] text-[var(--text-tertiary)]">
                        {t('apps.access_hint', 'Only what you are allowed to use appears here')}
                    </span>
                </div>
            )}

            <div className="flex-1 overflow-y-auto custom-scrollbar p-4">
                {loading ? (
                    <SkeletonGrid />
                ) : isEmpty ? (
                    <EmptyState
                        icon={<LayoutGrid className="w-12 h-12" />}
                        title={t('apps.empty_title', 'No apps yet')}
                        description={t(
                            'apps.empty_description',
                            'No apps have been shared with you yet. When someone in your organization publishes an internal tool to you, it will appear here.',
                        )}
                    />
                ) : hasDirectory ? (
                    <Directory recentlyUsed={recentlyUsed} apps={visibleApps} now={now} noMatches={noMatches} />
                ) : null}
            </div>
        </div>
    );
}
