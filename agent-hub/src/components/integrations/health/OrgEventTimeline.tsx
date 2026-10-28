import { RefreshCw } from 'lucide-react';
import React, { useState } from 'react';
import { useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { sevMeta, labelFor, summarize, SEVERITY_IDS, SEVERITY_META } from './healthMeta';
import { useTranslation } from '@/hooks/useTranslation';
import { integrationsAdminKeys, useOrgEventTimelineQuery } from '@/api/queries/integrationsAdmin';
import type { HealthEvent } from './healthMeta';

interface OrgEventTimelineProps {
    orgId: string;
}

/**
 * OrgEventTimeline — keyset-paginated connector-health audit trail for one org.
 * Structure mirrors SupportStudio/AuditTab.jsx (severity filter + Load more).
 *
 * Privacy: rows render labelFor(code) + summarize(event) — only whitelisted
 * meta keys, never the raw meta payload. No export button.
 */
export default function OrgEventTimeline({ orgId }: OrgEventTimelineProps) {
    const { t } = useTranslation();
    const queryClient = useQueryClient();
    const [severity, setSeverity] = useState('');
    const timeline = useOrgEventTimelineQuery<HealthEvent>(orgId, severity);
    const events: HealthEvent[] = timeline.data?.events ?? [];
    // A failed "load more" ends the trail: no button to try again, like the failure it replaces.
    const nextCursor: string | null = timeline.isError ? null : (timeline.data?.nextCursor ?? null);
    const loading = timeline.isFetching;
    const fetchPage = (cursor: string | null) => {
        if (cursor) void timeline.fetchNextPage();
        else {
            // Refresh starts again from the first page; the rows on screen stay until it lands.
            const key = integrationsAdminKeys.orgEvents(orgId, severity);
            queryClient.setQueryData<InfiniteData<unknown>>(key, (d) => d && { pages: d.pages.slice(0, 1), pageParams: d.pageParams.slice(0, 1) });
            void timeline.refetch();
        }
    };

    return (
        <div className="space-y-3">
            <div className="flex items-end gap-2">
                <label className="flex flex-col gap-1">
                    <span className="text-[10px] uppercase tracking-wider text-[var(--text-tertiary)]">
                        {t('admin.ch_severity', 'Severity')}
                    </span>
                    <select
                        value={severity}
                        onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setSeverity(e.target.value)}
                        className="text-sm rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] px-2 py-1.5"
                    >
                        <option value="">{t('admin.ch_sev_all', 'All severities')}</option>
                        {SEVERITY_IDS.map((s: string) => (
                            <option key={s} value={s}>{t(SEVERITY_META[s].labelKey, SEVERITY_META[s].fallback)}</option>
                        ))}
                    </select>
                </label>
                <button
                    onClick={() => fetchPage(null)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-[var(--border-default)] text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)]"
                >
                    <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
                    {t('admin.ch_refresh', 'Refresh')}
                </button>
            </div>

            <div className="rounded-xl border border-[var(--border-subtle)] divide-y divide-[var(--border-subtle)]">
                {events.length === 0 && !loading && (
                    <div className="p-6 text-center text-sm text-[var(--text-tertiary)]">
                        {t('admin.ch_no_events', 'No events recorded yet.')}
                    </div>
                )}
                {events.map((ev: HealthEvent) => {
                    const sm = sevMeta(ev.severity);
                    const Icon = sm.Icon;
                    const summary = summarize(ev);
                    return (
                        <div key={ev.id} className="flex items-start gap-3 px-4 py-2.5">
                            <span className={`mt-0.5 inline-flex items-center justify-center w-6 h-6 rounded-full border shrink-0 ${sm.chip}`}>
                                <Icon size={13} style={{ color: sm.color }} />
                            </span>
                            <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2 flex-wrap">
                                    <span className="text-sm text-[var(--text-primary)]">{labelFor(ev.code)}</span>
                                    <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border ${sm.chip}`}>
                                        {t(sm.labelKey, sm.fallback)}
                                    </span>
                                    {summary && <span className="text-xs text-[var(--text-tertiary)] truncate">· {summary}</span>}
                                </div>
                                <div className="text-[11px] text-[var(--text-tertiary)] mt-0.5">
                                    {ev.createdAt ? new Date(ev.createdAt).toLocaleString() : ''}
                                    {ev.actorKind ? ` · ${ev.actorKind}` : ''}
                                </div>
                            </div>
                        </div>
                    );
                })}
            </div>

            {nextCursor && (
                <div className="flex justify-center">
                    <button
                        onClick={() => fetchPage(nextCursor)}
                        disabled={loading}
                        className="text-xs px-3 py-1.5 rounded-lg border border-[var(--border-default)] text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] disabled:opacity-50"
                    >
                        {loading ? t('admin.ch_loading_short', 'Loading…') : t('admin.ch_load_more', 'Load more')}
                    </button>
                </div>
            )}
        </div>
    );
}
