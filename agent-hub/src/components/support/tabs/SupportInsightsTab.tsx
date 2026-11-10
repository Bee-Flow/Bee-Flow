import React from 'react';
import { useSupportInsightsQuery } from '@/api/queries/supportPanels';
import { useTranslation } from '@/hooks/useTranslation';
import { errorMessage } from '@/utils/caughtError';
import SectionHeader from '@/components/shared/SectionHeader';
import { ALERT_ERROR, CARD, EYEBROW } from '@/components/mcpLibrary/ui';

interface StatProps {
    label: string;
    value: React.ReactNode;
    sub?: string;
}

function fmtDuration(secs: number | null): string {
    if (secs == null) return '—';
    if (secs < 3600) return `${Math.round(secs / 60)}m`;
    if (secs < 86400) return `${(secs / 3600).toFixed(1)}h`;
    return `${(secs / 86400).toFixed(1)}d`;
}

function Stat({ label, value, sub }: StatProps) {
    return (
        <div className={CARD}>
            <div className={EYEBROW}>{label}</div>
            <div className="text-2xl font-semibold tabular-nums text-[var(--text-primary)]">{value}</div>
            {sub && <div className="-mt-2 text-xs text-[var(--text-tertiary)]">{sub}</div>}
        </div>
    );
}

export default function SupportInsightsTab() {
    const { t } = useTranslation();
    const insights = useSupportInsightsQuery();
    const data = insights.data ?? null;
    const error = insights.isError ? errorMessage(insights.error) : null;

    if (error) return <div className="p-6"><div className={ALERT_ERROR}>{error}</div></div>;
    if (!data) return <div className="p-6 text-sm text-[var(--text-tertiary)]">{t('support.support_insights_loading_insights', 'Loading insights…')}</div>;

    const { csat, handling } = data;
    return (
        <div className="flex max-w-4xl flex-col gap-6 p-6">
            <SectionHeader title={t('support.support_insights_insights', 'Insights')} />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <Stat label={t('support.insights_csat_7d', 'CSAT (7d avg)')} value={csat.avg7d != null ? `${csat.avg7d}/5` : '—'} />
                <Stat label={t('support.insights_csat_30d', 'CSAT (30d avg)')} value={csat.avg30d != null ? `${csat.avg30d}/5` : '—'} />
                <Stat label={t('support.insights_csat_rate', 'CSAT response rate')} value={`${Math.round((csat.responseRate || 0) * 100)}%`} sub={t('support.insights_ratings', '{count} ratings', { count: csat.responses })} />
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <Stat label={t('support.insights_ai_resolved', 'AI-resolved')} value={handling.aiResolved} />
                <Stat label={t('support.insights_staff_resolved', 'Staff-resolved')} value={handling.staffResolved} />
                <Stat label={t('support.insights_sla_breaches', 'SLA breaches')} value={handling.slaBreaches} sub={t('support.insights_of_threads', 'of {count} threads', { count: handling.total })} />
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Stat label={t('support.insights_median_first_response', 'Median first response')} value={fmtDuration(handling.avgFirstResponseSecs)} />
                <Stat label={t('support.insights_median_resolution', 'Median resolution time')} value={fmtDuration(handling.avgResolutionSecs)} />
            </div>
        </div>
    );
}
