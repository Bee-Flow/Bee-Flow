import React, { useEffect, useState } from 'react';
import { authFetch, API_BASE } from '../../../utils/helpers';
import { useTranslation } from '../../../hooks/useTranslation';
import { errorMessage } from '../../../utils/caughtError';

interface Insights {
    csat: { avg7d: number | null; avg30d: number | null; responseRate?: number; responses: number };
    handling: {
        aiResolved: number;
        staffResolved: number;
        slaBreaches: number;
        total: number;
        avgFirstResponseSecs: number | null;
        avgResolutionSecs: number | null;
    };
}

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
        <div className="rounded-lg border p-4 border-[var(--border-default)] bg-[var(--bg-card)]">
            <div className="text-2xl font-semibold text-[var(--text-primary)]">{value}</div>
            <div className="text-xs mt-1 text-[var(--text-muted)]">{label}</div>
            {sub && <div className="text-xs mt-0.5 text-[var(--text-muted)]">{sub}</div>}
        </div>
    );
}

export default function SupportInsightsTab() {
    const { t } = useTranslation();
    const [data, setData] = useState<Insights | null>(null);
    const [error, setError] = useState<string | null | undefined>(null);

    useEffect(() => {
        (async () => {
            try {
                const res = await authFetch(`${API_BASE}/api/support/insights`);
                if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || 'Failed'); }
                setData(await res.json());
            } catch (e) { setError(errorMessage(e)); }
        })();
    }, []);

    if (error) return <div className="p-6 text-sm [color:#dc2626]!">{error}</div>;
    if (!data) return <div className="p-6 text-sm text-[var(--text-muted)]">{t('support.support_insights_loading_insights', 'Loading insights…')}</div>;

    const { csat, handling } = data;
    return (
        <div className="max-w-3xl mx-auto p-4">
            <h3 className="text-sm font-semibold mb-3 text-[var(--text-primary)]">{t('support.support_insights_insights', 'Insights')}</h3>
            <div className="grid grid-cols-3 gap-3 mb-3">
                <Stat label="CSAT (7d avg)" value={csat.avg7d != null ? `${csat.avg7d}/5` : '—'} />
                <Stat label="CSAT (30d avg)" value={csat.avg30d != null ? `${csat.avg30d}/5` : '—'} />
                <Stat label="CSAT response rate" value={`${Math.round((csat.responseRate || 0) * 100)}%`} sub={`${csat.responses} ratings`} />
            </div>
            <div className="grid grid-cols-3 gap-3 mb-3">
                <Stat label="AI-resolved" value={handling.aiResolved} />
                <Stat label="Staff-resolved" value={handling.staffResolved} />
                <Stat label="SLA breaches" value={handling.slaBreaches} sub={`of ${handling.total} threads`} />
            </div>
            <div className="grid grid-cols-2 gap-3">
                <Stat label="Median first response" value={fmtDuration(handling.avgFirstResponseSecs)} />
                <Stat label="Median resolution time" value={fmtDuration(handling.avgResolutionSecs)} />
            </div>
        </div>
    );
}
