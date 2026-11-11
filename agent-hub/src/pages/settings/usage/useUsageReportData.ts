import { useMemo, useState } from 'react';
import { useUsageReport } from '@/api/queries/settingsUsage';
import { useDeploymentMode } from '@/hooks/useDeploymentMode';
import { USAGE_ALL_DAYS, type RangeParams } from '@/utils/usageHelpers';
import type { UsageFilters } from './useUsageFilters';

export interface UsageData {
    summary: { total_calls?: number; billed_cost?: number } | null;
    timeline: unknown[];
    users: { user_id: string; display_name?: string }[];
    sources: { source: string }[];
    agents: { agent_id?: string; agent_name: string }[];
    models: { model: string }[];
    modelsByAgent: unknown[];
    modelsByUser: unknown[];
}

export interface AzureServicesData {
    summary: Record<string, unknown> | null;
    byType: unknown[];
    byUser: unknown[];
}

const EMPTY_USAGE: UsageData = { summary: null, timeline: [], users: [], sources: [], agents: [], models: [], modelsByAgent: [], modelsByUser: [] };
const EMPTY_AZURE: AzureServicesData = { summary: null, byType: [], byUser: [] };

/** The query string of a range, the filters and (for a platform admin) the chosen organisation. */
function usageQuery(rangeParams: RangeParams, filters: UsageFilters, customerView: boolean, orgId: string | null | undefined): string {
    const params = new URLSearchParams();
    // Always send a day count (works with today's days-only usage routes);
    // also send startDate/endDate so the routes use the exact window once the
    // backend tweak ships. 'all' → large day fallback.
    params.set('days', String(rangeParams.days ?? USAGE_ALL_DAYS));
    if (rangeParams.startDate) params.set('startDate', rangeParams.startDate);
    if (rangeParams.endDate) params.set('endDate', rangeParams.endDate);
    if (filters.user) params.set('user', filters.user);
    if (filters.agent) params.set('agent', filters.agent);
    // A customer view has no model filter pill, so a stale model filter must never scope it.
    if (filters.model && !customerView) params.set('model', filters.model);
    if (filters.source) params.set('source', filters.source);
    if (orgId) params.set('orgId', orgId);
    return params.toString();
}

/**
 * The usage report for a range, the filters and an organisation, with the
 * view it implies. The backend redacts token/call counts for cloud non-admin
 * customers and swaps estimated_cost for the marked-up billed_cost; that
 * shape is the customer view.
 */
export function useUsageReportData(rangeParams: RangeParams, filters: UsageFilters, orgId: string | null | undefined) {
    const { isSelfHosted } = useDeploymentMode();
    const [customerView, setCustomerView] = useState(false);
    const qs = useMemo(
        () => usageQuery(rangeParams, filters, customerView, orgId),
        [rangeParams, filters, customerView, orgId],
    );
    // The previous report stays on screen while the next loads.
    const report = useUsageReport<UsageData, AzureServicesData>(qs);
    const data: UsageData = report.data?.data ?? EMPTY_USAGE;
    const azureServices: AzureServicesData = report.data?.azure ?? EMPTY_AZURE;
    const isCustomerView = Boolean(data.summary && data.summary.total_calls === undefined && data.summary.billed_cost !== undefined);
    // Single source of truth for token visibility: self-hosted always; cloud only
    // for admins (who keep total_calls). Defaults to hidden in cloud until the
    // summary loads, so tokens never flash for a customer.
    const showTokens = isSelfHosted || (data.summary != null && !isCustomerView);
    if (isCustomerView !== customerView) setCustomerView(isCustomerView);
    return { data, azureServices, loading: report.isFetching, isCustomerView, showTokens };
}
