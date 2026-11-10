/**
 * Website Analytics dashboard shell.
 *
 * Owns the cross-cutting state every section shares — selected site, date
 * range, drill-down filters — and routes between sections. Sections do their
 * own fetching through useAnalyticsQuery so a slow report never blocks the
 * rest of the page.
 *
 * Section + range + filters are mirrored into the query string so a view is
 * shareable. Query params (not path segments) because AdminDashboard routes on
 * the pathname and would not recognise /website-analytics/<section>.
 */
import {
    BarChart3, Activity, FileText, Share2, Users, Zap, Gauge,
    Filter, X, RefreshCw, Settings, Flame, GitBranch, Video,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { decodeFilters, encodeFilters, filterLabel, withFilter, withoutFilter, type AnalyticsFilters } from './filters';
import { analyticsApi, analyticsFetch, type AnalyticsResponse, type AnalyticsSite } from '../analyticsApi';
import AudienceSection from './sections/AudienceSection';
import BehaviorSection from './sections/BehaviorSection';
import EventsSection from './sections/EventsSection';
import HeatmapSection from './sections/HeatmapSection';
import OverviewSection from './sections/OverviewSection';
import PagesSection from './sections/PagesSection';
import PerformanceSection from './sections/PerformanceSection';
import RealtimeSection from './sections/RealtimeSection';
import ReplaysSection from './sections/ReplaysSection';
import SettingsSection from './sections/SettingsSection';
import SourcesSection from './sections/SourcesSection';
import { ErrorNote } from './AsyncCard';
import { useTranslation } from '@/hooks/useTranslation';
import { useUrlQueryParam } from '@/hooks/useUrlTab';
import SectionHeader from '@/components/shared/SectionHeader';
import SectionNav from '@/components/shared/SectionNav';
import StudioShell from '@/components/shared/StudioShell';
import IconButton from '@/components/shared/IconButton';
import Spinner from '@/components/shared/Spinner';
import { FILTER_CHIP_ON } from '@/components/mcpLibrary/ui';
import RangeControl, { defaultRange, UsageRange } from '@/pages/settings/usage/RangeControl';

const TZ = (() => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
})();

/**
 * Section registry.
 *
 * `rangeless` / `filterless` are capability flags rather than id checks in the
 * shell: Realtime's endpoint is declared `window: false` server-side and takes
 * no filters, so rendering a date picker above it would promise something the
 * data cannot honour. `wide` gives the heatmap room for a page at its real
 * capture width.
 */
const SECTIONS = [
    { id: 'overview',    labelKey: 'cms_site.analytics.nav.overview', label: 'Overview',    icon: BarChart3,  Component: OverviewSection },
    { id: 'realtime',    labelKey: 'cms_site.analytics.nav.realtime', label: 'Realtime',    icon: Activity,   Component: RealtimeSection, rangeless: true, filterless: true },
    { id: 'pages',       labelKey: 'cms_site.analytics.nav.pages', label: 'Pages',       icon: FileText,   Component: PagesSection },
    { id: 'sources',     labelKey: 'cms_site.analytics.nav.sources', label: 'Sources',     icon: Share2,     Component: SourcesSection },
    { id: 'audience',    labelKey: 'cms_site.analytics.nav.audience', label: 'Audience',    icon: Users,      Component: AudienceSection },
    { id: 'events',      labelKey: 'cms_site.analytics.nav.events', label: 'Events',      icon: Zap,        Component: EventsSection },
    { id: 'performance', labelKey: 'cms_site.analytics.nav.performance', label: 'Performance', icon: Gauge,      Component: PerformanceSection },
    { id: 'behavior',    labelKey: 'cms_site.analytics.nav.behavior', label: 'Behavior',    icon: GitBranch,  Component: BehaviorSection },
    { id: 'heatmap',     labelKey: 'cms_site.analytics.nav.heatmap', label: 'Heatmap',     icon: Flame,      Component: HeatmapSection, wide: true },
    { id: 'replays',     labelKey: 'cms_site.analytics.nav.replays', label: 'Sessions',    icon: Video,      Component: ReplaysSection },
];
const SECTION_IDS = SECTIONS.map(s => s.id);

/** Wide sections get room for a full-width page render beside its ranking (literal classes for Tailwind). */
const sectionWidthClass = (wide?: boolean) => (wide ? 'max-w-[1600px]' : 'max-w-[1280px]');

const MS_DAY = 24 * 60 * 60 * 1000;

/**
 * RangeControl's shape → the API's. `today` and `all` have no server-side
 * token, so they become absolute windows; the rest pass through as presets.
 */
export function toScopeRange(range: UsageRange) {
    const now = Date.now();
    switch (range?.preset) {
        case 'today': {
            const midnight = new Date();
            midnight.setHours(0, 0, 0, 0);
            return { range: 'custom', start: midnight.getTime(), end: now };
        }
        case 'all':
            return { range: 'custom', start: now - 3650 * MS_DAY, end: now };
        case 'custom': {
            const start = Date.parse(range.customStart);
            const end = Date.parse(range.customEnd);
            if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
                return { range: '30d' };   // invalid pickers — fall back rather than 400
            }
            return { range: 'custom', start, end };
        }
        default:
            return { range: range?.preset || '7d' };
    }
}

export default function AnalyticsPanel() {
    const { t } = useTranslation();
    const [settings, setSettings] = useState<AnalyticsResponse>(null);
    const [sites, setSites] = useState<AnalyticsSite[]>([]);
    const [siteId, setSiteId] = useState('');
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [view, setView] = useState('dashboard');           // 'dashboard' | 'settings'
    const [reloadToken, setReloadToken] = useState(0);

    const [sectionParam, setSectionParam] = useUrlQueryParam('section');
    const [filterParam, setFilterParam] = useUrlQueryParam('f');
    const section = sectionParam && SECTION_IDS.includes(sectionParam) ? sectionParam : 'overview';

    const [range, setRange] = useState(() => defaultRange('7d'));
    const [filters, setFiltersState] = useState(() => decodeFilters(filterParam));

    // Functional updates, and the URL write moved into an effect: reading
    // `filters` from the closure meant two drills dispatched in one tick both
    // built on the same stale object, so the first one was silently lost.
    const drill = useCallback((key: string, value: string | null | undefined) => setFiltersState(f => withFilter(f, key, value)), []);
    const clearFilter = useCallback((key: string) => setFiltersState(f => withoutFilter(f, key) as AnalyticsFilters), []);

    useEffect(() => {
        setFilterParam(encodeFilters(filters) || null, { replace: true });
    }, [filters, setFilterParam]);

    const loadShell = useCallback(async () => {
        setLoading(true);
        try {
            const [s, sitesRes] = await Promise.all([
                analyticsFetch(analyticsApi.settings()),
                analyticsFetch(analyticsApi.sites()).catch(() => ({ sites: [] })),
            ]);
            setSettings(s);
            const list = (sitesRes as { sites?: AnalyticsSite[] } | null)?.sites || [];
            setSites(list);
            setSiteId(prev => {
                if (prev && list.some(x => x.id === prev && x.tracked)) return prev;
                const live = list.find(x => x.live && x.tracked) || list.find(x => x.tracked);
                return live?.id || '';
            });
            if (!s?.enabled || !s?.configured) setView('settings');
            setError(null);
        } catch (e) {
            setError((e as Error).message);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { loadShell(); }, [loadShell]);

    const scope = useMemo(() => ({
        siteId: siteId || undefined,
        timezone: TZ,
        filters,
        ...toScopeRange(range),
        // Bumping this remounts section queries on an explicit refresh.
        _token: reloadToken,
    }), [siteId, range, filters, reloadToken]);

    const trackedSites = sites.filter(s => s.tracked);
    const activeSite = sites.find(s => s.id === siteId) || null;
    const ready = !!settings?.enabled && !!settings?.configured;

    if (loading) {
        return (
            <div className="flex h-full items-center justify-center text-[var(--text-tertiary)]">
                <Spinner />
            </div>
        );
    }

    if (view === 'settings') {
        return (
            <SettingsSection
                settings={settings}
                sites={sites}
                // Stay put on save. Jumping to the dashboard the instant two
                // fields become non-empty ejects the operator mid-configuration,
                // before they have set the recorder or consent options.
                onSaved={setSettings}
                onSitesChanged={loadShell}
                onClose={ready ? () => setView('dashboard') : null}
            />
        );
    }

    const activeSection = SECTIONS.find(s => s.id === section) || SECTIONS[0];
    const Active = activeSection.Component;
    const provisioned = trackedSites.length > 0;
    const showControls = !activeSection.rangeless || !activeSection.filterless;
    const title = t('cms_site.analytics.panel.title', 'Website Analytics');

    const actions = (
        <div className="flex items-center gap-1.5">
            {trackedSites.length > 1 && (
                <select
                    value={siteId}
                    onChange={(e) => setSiteId(e.target.value)}
                    aria-label={t('cms_site.analytics.panel.site', 'Site')}
                    className="h-8 rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] px-2.5 text-xs font-medium text-[var(--text-primary)] outline-none focus:border-[var(--accent-primary)]"
                >
                    {trackedSites.map(s => (
                        <option key={s.id} value={s.id}>{s.name}{s.live ? ` (${t('cms_site.analytics.panel.live_suffix', 'live')})` : ''}</option>
                    ))}
                </select>
            )}
            <IconButton onClick={() => setReloadToken(n => n + 1)} ariaLabel={t('cms_site.analytics.panel.refresh', 'Refresh')}>
                <RefreshCw aria-hidden="true" />
            </IconButton>
            <IconButton onClick={() => setView('settings')} ariaLabel={t('cms_site.analytics.panel.settings', 'Analytics settings')}>
                <Settings aria-hidden="true" />
            </IconButton>
        </div>
    );

    const sidebar = provisioned ? (
        <SectionNav
            label={title}
            items={SECTIONS.map(s => ({ id: s.id, icon: s.icon, label: t(s.labelKey, s.label) }))}
            activeId={activeSection.id}
            onSelect={(id) => setSectionParam(id)}
        />
    ) : null;

    return (
        <StudioShell responsive sidebarTitle={title} sidebar={sidebar}>
            <div className="relative h-full">
                <div className="absolute inset-0 overflow-y-auto">
                    <div className={`mx-auto flex flex-col gap-4 p-4 md:p-6 ${sectionWidthClass(activeSection.wide)}`}>
                        <SectionHeader
                            title={provisioned ? t(activeSection.labelKey, activeSection.label) : title}
                            description={t('cms_site.analytics.panel.subtitle', 'Self-hosted, privacy-first usage tracking for your published site')}
                            status={actions}
                        />

                        {error && <ErrorNote message={error} onRetry={loadShell} />}

                        {!provisioned ? (
                            <p className="m-0 mt-10 text-center text-[13px] text-[var(--text-tertiary)]">
                                {t('cms_site.analytics.panel.no_site', 'No tracked site yet. Publish a CMS site (with analytics enabled) to start collecting visitor data.')}
                            </p>
                        ) : (
                            <>
                                {/* Range + filters. Hidden entirely for a section that
                                    honours neither — a control that changes nothing is
                                    worse than no control. */}
                                {showControls && (
                                    <div className="flex flex-wrap items-center gap-2.5">
                                        {!activeSection.rangeless && <RangeControl range={range} onChange={setRange} />}
                                        {!activeSection.filterless && Object.entries(filters).map(([k, v]) => (
                                            <span key={k} className={FILTER_CHIP_ON}>
                                                <Filter className="h-3 w-3" aria-hidden="true" />
                                                {filterLabel(k, t)}: {v}
                                                <button
                                                    type="button"
                                                    onClick={() => clearFilter(k)}
                                                    aria-label={t('cms_site.analytics.panel.clear_filter', 'Clear {filter} filter', { filter: filterLabel(k, t) })}
                                                    className="inline-flex rounded text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                                                >
                                                    <X className="h-3 w-3" aria-hidden="true" />
                                                </button>
                                            </span>
                                        ))}
                                    </div>
                                )}

                                <Active
                                    scope={scope}
                                    site={activeSite}
                                    settings={settings}
                                    onDrill={drill}
                                    onOpenSettings={() => setView('settings')}
                                />
                            </>
                        )}
                    </div>
                </div>
            </div>
        </StudioShell>
    );
}
