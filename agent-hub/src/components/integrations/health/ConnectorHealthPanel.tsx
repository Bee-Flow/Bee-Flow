import { AlertTriangle, ChevronRight, RefreshCw, Search } from 'lucide-react';
import React, { useState, useCallback, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { STATUS_META, STATUS_IDS, statusRank, orgIsBlocked } from './healthMeta';
import type { FleetOrg } from './healthMeta';
import OrgHealthDrawer from './OrgHealthDrawer';
import { useTranslation } from '@/hooks/useTranslation';
import { ALERT_ERROR, DANGER_BTN, EYEBROW, FILTER_CHIP_OFF, FILTER_CHIP_ON } from '@/components/mcpLibrary/ui';
import SectionHeader from '@/components/shared/SectionHeader';
import Spinner from '@/components/shared/Spinner';
import { apiRequest } from '@/api/typedRequest';

/**
 * ConnectorHealthPanel — super-admin fleet overview of every Nextcloud-connected
 * organisation: health status, open problems, message activity and user census.
 * Data source: GET /auth/admin/connector-health/fleet (one aggregated call).
 *
 * Row click opens OrgHealthDrawer (problems + event timeline) and pushes
 * admin/security/connector-health/<orgId> so the drill-in is deep-linkable.
 * No export button (project rule for audit/health dashboards).
 */

/** Small status chip — reused by the fleet table and the drawer header. */
interface HealthChipProps {
    health: string;
}

export function HealthChip({ health }: HealthChipProps) {
    const { t } = useTranslation();
    const meta = STATUS_META[health];
    if (!meta) {
        return (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[11px] font-medium text-[var(--text-tertiary)] border-[var(--border-default)] bg-[var(--bg-secondary)]">
                {String(health || '—')}
            </span>
        );
    }
    const Icon = meta.Icon;
    return (
        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[11px] font-medium whitespace-nowrap ${meta.chip}`}>
            <Icon size={12} aria-hidden="true" />
            {t(meta.labelKey, meta.fallback)}
        </span>
    );
}

interface StatProps {
    label: string;
    value: number;
    tone?: 'rose' | 'amber' | 'green';
}

const TONE_TEXT = { rose: 'text-[var(--error-ink)]', amber: 'text-[var(--warning-ink)]', green: 'text-[var(--success-ink)]' } as const;

function Stat({ label, value, tone }: StatProps) {
    return (
        <div className="min-w-[120px] flex-1 rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] px-4 py-3">
            <div className={`text-2xl font-semibold ${tone ? TONE_TEXT[tone] : 'text-[var(--text-primary)]'}`}>{value}</div>
            <div className={`mt-0.5 ${EYEBROW}`}>{label}</div>
        </div>
    );
}

interface ConnectorHealthPanelProps {
    initialOrgId?: string;
    onNavigate?: (path: string) => void;
}

const NO_ORGS: FleetOrg[] = [];

/** The fleet read; Refresh reads again. */
function useFleet() {
    // A refusal, a failure or an answer without a fleet is a failed load, never "no organisations".
    const fleet = useQuery<FleetOrg[]>({
        queryKey: ['platformAdmin', 'connectorHealthFleet'],
        staleTime: 0,
        retry: false,
        queryFn: async () => {
            const data = await (await apiRequest('GET /auth/admin/connector-health/fleet')).json().catch(() => null);
            if (!data || !Array.isArray(data.orgs)) throw new Error('no fleet in the answer');
            return data.orgs;
        },
    });
    const orgs = fleet.data ?? NO_ORGS;
    const loading = fleet.isFetching;
    const loadFailed = fleet.isError && !fleet.isFetching;
    const { refetch } = fleet;
    const load = useCallback(() => { void refetch(); }, [refetch]);
    return { orgs, loading, loadFailed, load };
}

/** Opens `initialOrgId` once the fleet lists it; applied once, so closing stays closed. */
function useDeepLinkedOrg(initialOrgId: string | null | undefined, orgs: FleetOrg[], select: (id: string) => void) {
    const [applied, setApplied] = useState(false);
    if (!applied && initialOrgId && orgs.length > 0) {
        setApplied(true);
        if (orgs.some((o: FleetOrg) => o.id === initialOrgId)) select(initialOrgId);
    }
}

export default function ConnectorHealthPanel({ initialOrgId = '', onNavigate }: ConnectorHealthPanelProps) {
    const { t } = useTranslation();
    const [statusFilter, setStatusFilter] = useState<string | null>(null); // null = all
    const [query, setQuery] = useState('');
    const [selectedId, setSelectedId] = useState<string | null>(null);

    const { orgs, loading, loadFailed, load } = useFleet();

    // Deep-link drill-in: admin/security/connector-health/<orgId> opens the
    // drawer once the fleet has loaded (applied once, so closing stays closed).
    useDeepLinkedOrg(initialOrgId, orgs, setSelectedId);

    const blockedCount = useMemo(() => orgs.filter(orgIsBlocked).length, [orgs]);
    const silentCount = useMemo(() => orgs.filter((o: FleetOrg) => !o.messagesTotal).length, [orgs]);
    const healthyCount = useMemo(() => orgs.filter((o: FleetOrg) => o.health === 'ok').length, [orgs]);

    const visible = useMemo(() => {
        let list = orgs;
        if (statusFilter) list = list.filter((o: FleetOrg) => o.health === statusFilter);
        const q = query.trim().toLowerCase();
        if (q) {
            list = list.filter((o: FleetOrg) =>
                (o.name || '').toLowerCase().includes(q)
                || (o.ncBaseUrl || '').toLowerCase().includes(q));
        }
        // Worst first: status severity rank, then most recent activity.
        return [...list].sort((a: FleetOrg, b: FleetOrg) =>
            (statusRank(b.health) - statusRank(a.health))
            || ((Date.parse(b.lastMessageAt || '') || 0) - (Date.parse(a.lastMessageAt || '') || 0)));
    }, [orgs, statusFilter, query]);

    const selectedOrg = useMemo(() => orgs.find((o: FleetOrg) => o.id === selectedId) || null, [orgs, selectedId]);

    const openOrg = (org: FleetOrg) => {
        setSelectedId(org.id);
        if (onNavigate) onNavigate(`admin/security/connector-health/${org.id}`);
    };

    const closeDrawer = () => {
        setSelectedId(null);
        if (onNavigate) onNavigate('admin/security/connector-health');
    };

    if (loading && orgs.length === 0 && !loadFailed) {
        return (
            <div className="flex items-center gap-2 p-4 text-sm text-[var(--text-tertiary)]">
                <Spinner size="sm" />
                {t('admin.ch_loading', 'Loading connector health…')}
            </div>
        );
    }

    return (
        <div className="max-w-5xl">
            <SectionHeader
                className="mb-4"
                title={t('admin.ch_title', 'Nextcloud connector health')}
                description={t('admin.ch_desc', 'Per-organisation status of Nextcloud-connected workspaces: why users can or cannot reach AI chat.')}
            />

            {loadFailed && (
                <div className={`mb-4 items-center justify-between ${ALERT_ERROR}`}>
                    <div className="flex items-center gap-2">
                        <AlertTriangle size={16} className="shrink-0" aria-hidden="true" />
                        {t('admin.ch_load_failed', 'Failed to load connector health')}
                    </div>
                    <button type="button" onClick={load} className={DANGER_BTN}>
                        <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
                        {t('admin.ch_retry', 'Retry')}
                    </button>
                </div>
            )}

            {!loadFailed && (
                <>
                    {/* Stat strip */}
                    <div className="flex flex-wrap gap-3 mb-4">
                        <Stat label={t('admin.ch_stat_total', 'Connected orgs')} value={orgs.length} />
                        <Stat label={t('admin.ch_stat_blocked', 'Blocked')} value={blockedCount} tone={blockedCount > 0 ? 'rose' : undefined} />
                        <Stat label={t('admin.ch_stat_silent', 'Never sent a message')} value={silentCount} tone={silentCount > 0 ? 'amber' : undefined} />
                        <Stat label={t('admin.ch_stat_healthy', 'Healthy')} value={healthyCount} tone="green" />
                    </div>

                    {/* Blocked banner */}
                    {blockedCount > 0 && (
                        <div className={`mb-4 ${ALERT_ERROR}`}>
                            <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
                            <div>
                                {t('admin.ch_blocked_banner', '{count} organisation(s) cannot send AI messages right now').replace('{count}', String(blockedCount))}
                            </div>
                        </div>
                    )}

                    {/* Filter pills + search */}
                    <div className="flex flex-wrap items-center gap-2 mb-4">
                        <button
                            data-testid="ch-pill-all"
                            onClick={() => setStatusFilter(null)}
                            type="button"
                            aria-pressed={statusFilter === null}
                            className={statusFilter === null ? FILTER_CHIP_ON : FILTER_CHIP_OFF}
                        >
                            {t('admin.ch_filter_all', 'All')}
                        </button>
                        {STATUS_IDS.map((id: string) => (
                            <button
                                key={id}
                                data-testid={`ch-pill-${id}`}
                                type="button"
                                aria-pressed={statusFilter === id}
                                onClick={() => setStatusFilter((f: string | null) => (f === id ? null : id))}
                                className={statusFilter === id ? `${FILTER_CHIP_ON} ${STATUS_META[id].chip}` : FILTER_CHIP_OFF}
                            >
                                {t(STATUS_META[id].labelKey, STATUS_META[id].fallback)}
                            </button>
                        ))}
                        <div className="relative ml-auto">
                            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]" />
                            <input
                                type="text"
                                value={query}
                                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setQuery(e.target.value)}
                                placeholder={t('admin.ch_search_placeholder', 'Search by name or URL…')}
                                className="pl-8 pr-3 py-1.5 rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent-primary)]"
                            />
                        </div>
                    </div>

                    {/* Fleet table */}
                    {visible.length === 0 ? (
                        <div className="rounded-lg border border-dashed border-[var(--border-default)] p-6 text-center text-sm text-[var(--text-tertiary)]">
                            {orgs.length === 0
                                ? t('admin.ch_empty', 'No Nextcloud-connected organisations yet.')
                                : t('admin.ch_no_match', 'No organisations match the current filters.')}
                        </div>
                    ) : (
                        <div className="overflow-x-auto rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)]">
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="bg-[var(--bg-secondary)] text-left text-xs text-[var(--text-tertiary)]">
                                        <th className="font-medium px-4 py-2">{t('admin.ch_col_org', 'Organisation')}</th>
                                        <th className="font-medium px-4 py-2">{t('admin.ch_col_status', 'Status')}</th>
                                        <th className="font-medium px-4 py-2">{t('admin.ch_col_problem', 'Top problem')}</th>
                                        <th className="font-medium px-4 py-2">{t('admin.ch_col_messages', 'Messages (30d)')}</th>
                                        <th className="font-medium px-4 py-2">{t('admin.ch_col_users', 'Users')}</th>
                                        <th className="font-medium px-4 py-2">{t('admin.ch_col_last_activity', 'Last activity')}</th>
                                        <th className="px-2 py-2" />
                                    </tr>
                                </thead>
                                <tbody>
                                    {visible.map((org: FleetOrg) => {
                                        const topProblem = Array.isArray(org.problems) && org.problems.length > 0 ? org.problems[0] : null;
                                        const lastActivity = org.lastMessageAt || org.ncLastSyncAt;
                                        const pending = org.users?.pending || 0;
                                        return (
                                            <tr
                                                key={org.id}
                                                onClick={() => openOrg(org)}
                                                className="cursor-pointer border-t border-[var(--border-default)] hover:bg-[var(--bg-secondary)]"
                                            >
                                                <td className="px-4 py-2.5">
                                                    <div className="font-medium text-[var(--text-primary)]">{org.name}</div>
                                                    {org.ncBaseUrl && <div className="text-xs text-[var(--text-tertiary)]">{org.ncBaseUrl}</div>}
                                                </td>
                                                <td className="px-4 py-2.5"><HealthChip health={org.health} /></td>
                                                <td className="px-4 py-2.5 max-w-[260px]">
                                                    {topProblem ? (
                                                        <span className="block truncate text-[var(--text-secondary)]" title={topProblem.message as string}>
                                                            {topProblem.message}
                                                        </span>
                                                    ) : (
                                                        <span className="text-[var(--text-tertiary)]">—</span>
                                                    )}
                                                </td>
                                                <td className="px-4 py-2.5 text-[var(--text-secondary)]" title={t('admin.ch_messages_total', 'Total: {count}').replace('{count}', String(org.messagesTotal ?? 0))}>
                                                    {org.messages30d ?? 0}
                                                </td>
                                                <td className="px-4 py-2.5 text-[var(--text-secondary)] whitespace-nowrap">
                                                    {org.users?.active ?? 0}/{org.users?.total ?? 0}
                                                    {pending > 0 && (
                                                        <span className="ml-1.5 text-[11px] font-medium text-[var(--warning-ink)]">
                                                            +{pending} {t('admin.ch_pending_short', 'pending')}
                                                        </span>
                                                    )}
                                                </td>
                                                <td className="px-4 py-2.5 text-[var(--text-tertiary)] whitespace-nowrap">
                                                    {lastActivity ? new Date(lastActivity).toLocaleString() : '—'}
                                                </td>
                                                <td className="px-2 py-2.5 text-[var(--text-tertiary)]"><ChevronRight size={16} /></td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    )}
                </>
            )}

            {selectedOrg && (
                <OrgHealthDrawer org={selectedOrg} onClose={closeDrawer} onNavigate={onNavigate} />
            )}
        </div>
    );
}
