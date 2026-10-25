// Two small flag reads behind the Knowledge Bases screen. Both are best-effort:
// a non-ok answer or a network failure leaves the flag false, like the effects
// they replace.

import { useQuery } from '@tanstack/react-query';
import { API_BASE, authFetch } from '../../utils/helpers';
import { logger } from '../../utils/logger';

const coreKnowledgeBaseKeys = {
    driveConnected: ['knowledgeBases', 'gdriveStatus'] as const,
    azureDocProcessing: ['knowledgeBases', 'azureDocProcessing'] as const,
};

async function readFlag(url: string, field: string): Promise<boolean> {
    try {
        const res = await authFetch(url);
        if (res.ok) { const d = await res.json(); return !!d[field]; }
    } catch (err) { logger.debug('best-effort flag', err); }
    return false;
}

/** Whether Google Drive is connected; only asked when `enabled`. */
export function useDriveConnected(enabled: boolean): boolean {
    const q = useQuery<boolean, Error>({
        queryKey: coreKnowledgeBaseKeys.driveConnected,
        enabled,
        retry: false,
        staleTime: 0,
        queryFn: () => readFlag(`${API_BASE}/api/integrations/gdrive/status`, 'connected'),
    });
    return q.data ?? false;
}

/** Whether the org processes documents with Azure; only asked when `enabled`. */
export function useAzureDocProcessing(enabled: boolean): boolean {
    const q = useQuery<boolean, Error>({
        queryKey: coreKnowledgeBaseKeys.azureDocProcessing,
        enabled,
        retry: false,
        staleTime: 0,
        queryFn: () => readFlag(`${API_BASE}/ai/config`, 'useAzureDocProcessing'),
    });
    return q.data ?? false;
}
