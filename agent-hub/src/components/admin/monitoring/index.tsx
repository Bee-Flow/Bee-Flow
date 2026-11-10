import { useMemo, useState } from 'react';
import SectionHeader from '@/components/shared/SectionHeader';
import SectionNav from '@/components/shared/SectionNav';
import StudioShell from '@/components/shared/StudioShell';
import { useTranslation } from '@/hooks/useTranslation';
import { rowCost, type UsageSummary } from './shared';
import { OverviewPage, type UsageDeltas } from './OverviewPage';
import { UsageExplorerPage } from './UsageExplorerPage';
import { FeedbackPage } from './FeedbackPage';
import { ActivityPage } from './ActivityPage';
import { TerminationsPage } from './TerminationsPage';
import { DetailDrawer } from './DetailDrawer';
import { RangeControls } from './RangeControls';
import { useMonitoringData, type MonitoringData } from './useMonitoringData';
import type { DrawerDetail } from './drawer/drawerTypes';
import type { MonitoringPanelProps } from './index.types';
import { PAGES, monitoringPageOf } from './monitoring.constants';
import type { CoveredScope } from './shared.types';
import { toLocalInput } from './monitoring.helpers';
import { isAdminSectionVisibleTo } from '@/components/admin/dashboard/adminTabs';
import { useAdminOrgIdParam } from '@/components/admin/dashboard/useAdminOrg';
import { isHomeOrgAdmin, isPlatformAdmin } from '@/utils/adminAccess';

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

const DELTA_LABELS: Record<string, string> = { today: 'vs yesterday', '7d': 'vs prev 7d', '30d': 'vs prev 30d', custom: 'vs prev period' };

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
}

/** The page the URL names, fed from the shared read. */
function MonitoringPage({ page, data, range, customStart, customEnd, refreshKey, orgId, onDetail, onNavigate }: PageProps) {
    const { costPerModel, totalCost } = useModelCosts(data);
    const deltas = useMemo(() => usageDeltas(data.summary, data.prevSummary), [data.summary, data.prevSummary]);
    const onSelectModel = (m: DrawerDetail['data']) => onDetail({ type: 'model', data: m });
    const onSelectAgent = (a: DrawerDetail['data']) => onDetail({ type: 'agent', data: a });
    switch (page) {
        case 'usage':
            return (
                <UsageExplorerPage
                    byModel={data.byModel} byAgent={data.byAgent} byUser={data.byUser}
                    byConversation={data.byConversation} costPerModel={costPerModel}
                    onSelectModel={onSelectModel}
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
                    summary={data.summary} deltas={deltas} deltaLabel={DELTA_LABELS[range] || ''}
                    byModel={data.byModel} byAgent={data.byAgent} timeline={data.timeline}
                    costTimeline={data.costTimeline} tools={data.tools} totalCost={totalCost}
                    costPerModel={costPerModel}
                    onSelectModel={onSelectModel} onSelectAgent={onSelectAgent} onNavigate={onNavigate}
                />
            );
    }
}

/**
 * AI Monitor: usage, cost, feedback, the call log and terminations, one page
 * per URL (admin/monitoring/<page>; bare admin/monitoring is Overview), with
 * the period chosen once for all of them in the page header.
 */
export default function MonitoringPanel({ activeSection = '', onNavigate, user }: MonitoringPanelProps) {
    const { t } = useTranslation();
    // Feedback is for a platform admin and an organisation admin of their home organisation
    // (the `/org` route refuses anyone else); a hidden page falls back to Overview.
    const viewer = { isPlatformAdmin: isPlatformAdmin(user), isHomeOrgAdmin: isHomeOrgAdmin(user) };
    const pages = PAGES.filter(p => isAdminSectionVisibleTo('monitoring', viewer, p.id));
    const requested = monitoringPageOf(activeSection);
    const page = pages.some(p => p.id === requested) ? requested : 'overview';
    const meta = pages.find(p => p.id === page) ?? pages[0];
    const [range, setRange] = useState('7d');
    const [customStart, setCustomStart] = useState(defaultStart);
    const [customEnd, setCustomEnd] = useState(() => toLocalInput(new Date()));
    const [detail, setDetail] = useState<DrawerDetail | null>(null);
    // The dashboard's chosen organisation (a platform admin's), sent as `orgId`; none: the server's default scope.
    const orgId = useAdminOrgIdParam();
    const { data, loading, reload, refreshKey } = useMonitoringData(range, customStart, customEnd, orgId);
    const title = t('admin_monitoring.title', 'AI Monitor');
    const { costPerModel } = useModelCosts(data);
    const scopeLine = useScopeLine(data.summary?.scope);
    const pageDescription = t(meta.descriptionKey, meta.description);

    const sidebar = (
        <SectionNav
            label={title}
            items={pages.map(p => ({ id: p.id, icon: p.icon, label: t(p.labelKey) }))}
            activeId={page}
            onSelect={(id) => onNavigate?.(`admin/monitoring/${id}`)}
        />
    );

    return (
        <StudioShell responsive sidebarTitle={title} sidebar={sidebar}>
            <div className="relative h-full">
                <div className="absolute inset-0 overflow-y-auto">
                    <div className="mx-auto flex max-w-[1400px] flex-col gap-5 p-4 md:p-6">
                        <SectionHeader
                            title={t(meta.labelKey)}
                            description={scopeLine ? <>{pageDescription}<span className="block">{scopeLine}</span></> : pageDescription}
                            status={(
                                <RangeControls
                                    range={range} setRange={setRange} customStart={customStart} setCustomStart={setCustomStart}
                                    customEnd={customEnd} setCustomEnd={setCustomEnd} loading={loading} onRefresh={reload}
                                />
                            )}
                        />
                        <MonitoringPage
                            page={page} data={data} range={range} customStart={customStart} customEnd={customEnd}
                            refreshKey={refreshKey} orgId={orgId} onDetail={setDetail} onNavigate={onNavigate}
                        />
                    </div>
                </div>
                {detail && (
                    <DetailDrawer detail={detail} modelCosts={data.modelCosts} costPerModel={costPerModel}
                        recent={data.recent} onClose={() => setDetail(null)} />
                )}
            </div>
        </StudioShell>
    );
}
