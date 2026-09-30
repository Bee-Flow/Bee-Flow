/** Reads for the n8n settings. The config any member may read; the rest is admin-only. */

import { useQuery } from '@tanstack/react-query';

import { integrationKeys } from '../api/keys';
import { getN8nConfig, getN8nDiagnostics, getN8nPermissions } from '../api/n8n';

export function useN8nConfig(enabled: boolean) {
    return useQuery({ queryKey: integrationKeys.n8n.config, queryFn: ({ signal }) => getN8nConfig(signal), enabled, retry: false });
}

/** Only once n8n is configured, as on the web: before that every check fails for the same reason. */
export function useN8nDiagnostics(enabled: boolean) {
    return useQuery({
        queryKey: integrationKeys.n8n.diagnostics,
        queryFn: ({ signal }) => getN8nDiagnostics(signal),
        enabled,
        retry: false,
    });
}

export function useN8nPermissions(enabled: boolean) {
    return useQuery({
        queryKey: integrationKeys.n8n.permissions,
        queryFn: ({ signal }) => getN8nPermissions(signal),
        enabled,
        retry: false,
    });
}
