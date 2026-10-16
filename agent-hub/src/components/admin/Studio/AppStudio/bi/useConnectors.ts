import { useQuery } from '@tanstack/react-query';
import useTranslation from '../../../../../hooks/useTranslation';
import type { TranslateFn } from '../../../../../hooks/useTranslation';
import { API_BASE, authFetch } from '../../../../../utils/helpers';
import type { Connector, ConnectorParam } from './connectors/connectorModel';

/**
 * App Studio BI — the connector catalogue hook (safe projection).
 *
 * Reads GET /api/studio-apps/:appId/data/connectors — the owner-authored
 * external connectors, in their SECRET-FREE projection (id, kind, name, and the
 * declared viewer `params` only; never fixedArgs / url / credentials). Like
 * useAppTables, a 404 degrades to an empty list. Used by the inspector's
 * connector binding mode to offer a picker + a params form.
 *
 *   const { connectors, isLoading } = useConnectors(appId);
 */

/** A param the connector declares for its viewer; a declared param always has a key. */
export type ConnectorParamDecl = ConnectorParam & { key: string };

/** One connector in its SECRET-FREE projection: id, kind, name and the declared viewer params. */
export interface ConnectorSummary extends Pick<Connector, 'id' | 'kind' | 'name'> {
    params?: ConnectorParamDecl[];
}

interface ConnectorsBody {
    error?: string;
    connectors?: unknown;
}

async function fetchConnectors(appId: string | null | undefined, t: TranslateFn): Promise<ConnectorSummary[]> {
    const res = await authFetch(`${API_BASE}/api/studio-apps/${(encodeURIComponent as (value: string | null | undefined) => string)(appId)}/data/connectors`);
    if (res.status === 404) return [];
    let body: ConnectorsBody | null = null;
    try { body = await res.json(); } catch { body = null; }
    if (!res.ok) throw new Error(body?.error || t('studio_apps_bi.hooks.connectors_load_failed', 'Could not load connectors ({status})', { status: res.status }));
    return Array.isArray(body?.connectors) ? body.connectors : [];
}

export default function useConnectors(appId: string | null | undefined) {
    const { t } = useTranslation();
    const query = useQuery({
        queryKey: ['studio-app-connectors', appId],
        queryFn: () => fetchConnectors(appId, t),
        enabled: !!appId,
        staleTime: 30_000,
        retry: false,
    });

    return {
        connectors: Array.isArray(query.data) ? query.data : [],
        isLoading: !!appId && query.isLoading,
        isError: query.isError,
        error: query.error || null,
        refetch: query.refetch,
    };
}
