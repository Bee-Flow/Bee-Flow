import { useMemo, useState } from 'react';
import SectionHeader from '@/components/shared/SectionHeader';
import SectionNav from '@/components/shared/SectionNav';
import StudioShell from '@/components/shared/StudioShell';
import { useTranslation } from '@/hooks/useTranslation';
import { rowCost, type UsageSummary } from './shared';
import { OverviewPage, type UsageDeltas } from './OverviewPage';
import { FeedbackPage } from './FeedbackPage';
import { ActivityPage } from './ActivityPage';
import { TerminationsPage } from './TerminationsPage';
import { DetailDrawer } from './DetailDrawer';
import { RangeControls } from './RangeControls';
import { useMonitoringData, type MonitoringData } from './useMonitoringData';
import type { DrawerDetail } from './drawer/drawerTypes';
import type { MonitoringPanelProps } from './index.types';
import { ADVANCED_PAGES_FEATURE, PAGES, isPageAllowedFor, monitoringPageOf } from './monitoring.constants';
import type { CoveredScope } from './shared.types';
import { toLocalInput } from './monitoring.helpers';
import { ADMIN_TABS, isAdminSectionVisibleTo } from '@/components/admin/dashboard/adminTabs';
import { useAdminTabAccess } from '@/components/admin/dashboard/useAdminTabAccess';
import { useAdminOrgIdParam } from '@/components/admin/dashboard/useAdminOrg';
import { isHomeOrgAdmin, isPlatformAdmin } from '@/utils/adminAccess';
import { useLicenseContext } from '@/components/licensing/LicenseContext';
import { UsageReportPage } from './UsageReportPage';
import { ConversationsTable } from './usage/ConversationsTable';
import type { SpendExtraView } from '@/pages/settings/usage/spend/SpendTab';
import { useShellProps } from '@/authedApp/useShellProps';

/** Change against the previous period, in percent (null where the previous period had none). */
function usageDeltas(summary: UsageSummary | null, prevSummary: UsageSummary | null): UsageDeltas {
    if (!prevSummary || !summary) return {};
    const calc = (curr: number, prev: number) => prev > 0 ? ((curr - prev) / prev) * 100 : null;
    return {
        calls: calc(summary.total_calls || 0, prevSummary.total_calls || 0),
        tokens: calc(summary.total_tokens || 0, prevSummary.total_tokens || 0),
        cost: calc(summary.total_estimated_cost || 0, prevSummary.total_estimated_cost || 0),
        latency: calc(summary.avg_duration_ms || 0, prevSummary.avg_duration_ms || 0),
    };
}

/** The line under the heading that says what the figures cover; null when the answer does not say (or covers the caller's own rows). */
function useScopeLine(scope: CoveredScope | undefined): string | null {
    const { t } = useTranslation();
    if (scope?.allOrganizations) return t('admin_monitoring.scope_all', 'Usage of all organisations');
    if (scope?.organizationId) return t('admin_monitoring.scope_org', 'Usage of {name}', { name: scope.organizationName || scope.organizationId });
    return null;
}

/** What a KPI's change is measured against, per period ('all' has no previous period). */
function useDeltaLabel(range: string): string {
    const { t } = useTranslation();
    if (range === 'today') return t('admin_monitoring.delta_vs_yesterday', 'vs yesterday');
    if (range === '7d') return t('admin_monitoring.delta_vs_prev_7d', 'vs previous 7 days');
    if (range === '30d') return t('admin_monitoring.delta_vs_prev_30d', 'vs previous 30 days');
    if (range === 'custom') return t('admin_monitoring.delta_vs_prev_period', 'vs previous period');
    return '';
}

/** Cost per model from its rates (cache-aware — see rowCost), and their sum. */
function useModelCosts({ byModel, modelCosts }: MonitoringData) {
    return useMemo(() => {
        const costPerModel: Record<string, number> = {};
        let totalCost = 0;
        byModel.forEach(m => {
            const c = modelCosts[m.model];
            if (!c) return;
            costPerModel[m.model] = rowCost(m, c);
            totalCost += costPerModel[m.model];
        });
        return { costPerModel, totalCost };
    }, [byModel, modelCosts]);
}

function defaultStart() {
    const d = new Date(); d.setDate(d.getDate() - 7); d.setHours(0, 0, 0, 0); return toLocalInput(d);
}

interface PageProps {
    page: string;
    data: MonitoringData;
    range: string;
    customStart: string;
    customEnd: string;
    refreshKey: number;
    /** The admin dashboard's chosen organisation, or null. */
    orgId: string | null;
    onDetail: (detail: DrawerDetail) => void;
    onNavigate?: (path: string) => void;
    /** The viewer may open AI configuration, where the model prices are set. */
    canSetPrices: boolean;
}

/** Spend's views after its own: the period's conversations, which the old Usage explorer showed. */
function useSpendExtraViews(byConversation: MonitoringData['byConversation']): readonly SpendExtraView[] {
    const { t } = useTranslation();
    return useMemo(() => [{
        id: 'conversations',
        label: t('admin_monitoring.usage_conversations', 'Conversations'),
        description: t('admin_monitoring.spend_desc_conversations', 'Conversations: the most expensive conversations of the period, with their agent and models.'),
        render: (filters) => <ConversationsTable rows={byConversation} filters={filters} />,
    }], [byConversation, t]);
}

/** The page the URL names, fed from the shared read. */
function MonitoringPage({ page, data, range, customStart, customEnd, refreshKey, orgId, onDetail, onNavigate, canSetPrices }: PageProps) {
    const { costPerModel, totalCost } = useModelCosts(data);
    const deltas = useMemo(() => usageDeltas(data.summary, data.prevSummary), [data.summary, data.prevSummary]);
    const deltaLabel = useDeltaLabel(range);
    const spendExtraViews = useSpendExtraViews(data.byConversation);
    const onSelectModel = (m: DrawerDetail['data']) => onDetail({ type: 'model', data: m });
    const onSelectAgent = (a: DrawerDetail['data']) => onDetail({ type: 'agent', data: a });
    switch (page) {
        case 'adoption':
        case 'spend':
            return (
                <UsageReportPage
                    report={page} range={range} customStart={customStart} customEnd={customEnd} refreshKey={refreshKey} onNavigate={onNavigate}
                    spendExtraViews={page === 'spend' ? spendExtraViews : undefined}
                />
            );
        case 'feedback':
            return <FeedbackPage feedback={data.feedback} summary={data.feedbackSummary} />;
        case 'activity':
            return <ActivityPage recent={data.recent} />;
        case 'terminations':
            // The generic route: it needs admin_monitoring (the tab's own permission) and scopes a
            // caller who is not a platform admin to their own organisation on the server. A platform
            // admin who chose one organisation reads the `/org` routes for it.
            return <TerminationsPage range={range} customStart={customStart} customEnd={customEnd} refreshKey={refreshKey} orgId={orgId} />;
        default:
            return (
                <OverviewPage
                    summary={data.summary} deltas={deltas} deltaLabel={deltaLabel}
                    byModel={data.byModel} byAgent={data.byAgent} timeline={data.timeline}
                    costTimeline={data.costTimeline} tools={data.tools} totalCost={totalCost}
                    costPerModel={costPerModel}
                    onSelectModel={onSelectModel} onSelectAgent={onSelectAgent}
                    onOpenModelPrices={canSetPrices && onNavigate ? () => onNavigate('admin/ai-config') : undefined}
                />
            );
    }
}

/** The viewer may open AI configuration (where the model prices are set): the dashboard's own tab gate. */
function useCanSetPrices(user: MonitoringPanelProps['user']): boolean {
    const { checkTabAccess } = useAdminTabAccess(user);
    return checkTabAccess(ADMIN_TABS.find(tab => tab.id === 'ai-config'));
}

/** The pages open to this viewer, the one the address names (Overview when it may not open it), and its entry. */
function useMonitoringPages(user: MonitoringPanelProps['user'], activeSection: string) {
    // Feedback is for a platform admin and an organisation admin of their home organisation
    // (the `/org` route refuses anyone else); a hidden page falls back to Overview.
    const viewer = { isPlatformAdmin: isPlatformAdmin(user), isHomeOrgAdmin: isHomeOrgAdmin(user) };
    // Overview is open to every admin of the tab; the other pages need the advanced-monitoring capability.
    const hasAdvanced = useLicenseContext().hasFeature(ADVANCED_PAGES_FEATURE);
    const pages = PAGES.filter(p => isPageAllowedFor(p.id, hasAdvanced) && isAdminSectionVisibleTo('monitoring', viewer, p.id));
    const requested = monitoringPageOf(activeSection);
    const page = pages.some(p => p.id === requested) ? requested : 'overview';
    return { pages, page, meta: pages.find(p => p.id === page) ?? pages[0] };
}

/** The period, chosen once for every page. */
function usePeriod() {
    const [range, setRange] = useState('7d');
    const [customStart, setCustomStart] = useState(defaultStart);
    const [customEnd, setCustomEnd] = useState(() => toLocalInput(new Date()));
    return { range, setRange, customStart, setCustomStart, customEnd, setCustomEnd };
}

/**
 * Usage & monitoring: usage, cost, feedback, the call log and terminations,
 * one page per URL (admin/monitoring/<page>; bare admin/monitoring is
 * Overview), with the period chosen once for all of them.
 *
 * In the admin dashboard (`nav` false) the rail's child rows are the pages and
 * the dashboard's page frame draws the page's name and width, so the panel
 * opens on the period bar. On its own it keeps its page column (hidden when
 * only one page is open to the viewer), its header and its own scroll.
 */
export default function MonitoringPanel({ activeSection = '', onNavigate: onNavigateProp, user: userProp, nav = true }: MonitoringPanelProps) {
    const { t } = useTranslation();
    // Inside the app shell the signed-in person and the navigation come from
    // context; a host outside it (a test, a kit) still hands them as props.
    const { user, onNavigate } = useShellProps({ user: userProp, onNavigate: onNavigateProp });
    const canSetPrices = useCanSetPrices(user);
    const { pages, page, meta } = useMonitoringPages(user, activeSection);
    const period = usePeriod();
    const { range, customStart, customEnd } = period;
    const [detail, setDetail] = useState<DrawerDetail | null>(null);
    // The dashboard's chosen organisation (a platform admin's), sent as `orgId`; none: the server's default scope.
    const orgId = useAdminOrgIdParam();
    const { data, loading, reload, refreshKey } = useMonitoringData(range, customStart, customEnd, orgId);
    // The rail's label, so the page column and the rail name the tab the same.
    const title = t('admin_nav.monitoring', 'Usage & monitoring');
    const { costPerModel } = useModelCosts(data);
    const scopeLine = useScopeLine(data.summary?.scope);
    const pageDescription = t(meta.descriptionKey, meta.description);
    const description = scopeLine ? <>{pageDescription}<span className="block">{scopeLine}</span></> : pageDescription;
    // In the dashboard: one small line, the frame's description style ("… · Usage of <org>").
    const frameLine = scopeLine ? `${pageDescription} · ${scopeLine}` : pageDescription;
    const rangeControls = <RangeControls {...period} loading={loading} onRefresh={reload} />;
    const content = (
        <MonitoringPage
            page={page} data={data} range={range} customStart={customStart} customEnd={customEnd}
            refreshKey={refreshKey} orgId={orgId} onDetail={setDetail} onNavigate={onNavigate} canSetPrices={canSetPrices}
        />
    );
    const drawer = (mode: 'overlay' | 'modal') => detail && (
        <DetailDrawer detail={detail} modelCosts={data.modelCosts} costPerModel={costPerModel}
            recent={data.recent} mode={mode} onClose={() => setDetail(null)} />
    );

    if (!nav) {
        // The page frame draws the page's name: the panel opens on what the figures cover and the period.
        // h-full + overflow: in a frame of fixed height (a 'fill' page) the panel scrolls itself; in one that
        // grows with its content ('wide') the height is auto and the frame scrolls.
        return (
            <div className="flex h-full min-h-0 flex-col gap-5 overflow-y-auto" data-testid="monitoring-page" data-page={page}>
                {/* The onboarding tours' anchor for the usage report (onboarding/tourAnchors 'usage-summary'). */}
                <div data-tour="usage-summary" className="flex flex-wrap items-end justify-between gap-3">
                    <p className="m-0 min-w-0 text-xs text-[var(--text-secondary)]" data-testid="monitoring-description">{frameLine}</p>
                    {rangeControls}
                </div>
                {content}
                {drawer('modal')}
            </div>
        );
    }

    const body = (
        <div className="relative h-full">
            <div className="absolute inset-0 overflow-y-auto">
                <div className="flex flex-col gap-5 p-6 md:p-8">
                    {/* The onboarding tours' anchor for the usage report (onboarding/tourAnchors 'usage-summary'). */}
                    <div data-tour="usage-summary">
                        <SectionHeader title={t(meta.labelKey, meta.label)} description={description} status={rangeControls} />
                    </div>
                    {content}
                </div>
            </div>
            {drawer('overlay')}
        </div>
    );
    // One page open to the viewer: no page column to choose from.
    if (pages.length < 2) return body;
    const sidebar = (
        <SectionNav
            label={title}
            items={pages.map(p => ({ id: p.id, icon: p.icon, label: t(p.labelKey, p.label) }))}
            activeId={page}
            onSelect={(id) => onNavigate?.(`admin/monitoring/${id}`)}
        />
    );
    return (
        <StudioShell responsive sidebarTitle={title} sidebar={sidebar}>
            {body}
        </StudioShell>
    );
}
