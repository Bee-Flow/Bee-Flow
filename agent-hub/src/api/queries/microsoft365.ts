// Microsoft 365 connector (server: routes/integrations/microsoft365.js, mounted
// at /api/integrations/microsoft). The Settings tile reads its status here and
// disconnects through here; connecting is the popup in lib/microsoftOAuthPopup.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../client';
import { integrationStatusKeys } from './integrationStatus';

export interface Microsoft365Status {
    /** The admin set a Microsoft client id and secret. */
    configured: boolean;
    connected: boolean;
    needsReauth?: boolean;
    sharedMailboxGranted?: boolean;
    email?: string | null;
    /** Connected through the Microsoft login only (no vault connection). */
    viaSso?: boolean;
}

const BASE = '/api/integrations/microsoft';

export const microsoft365Keys = {
    status: ['microsoft365', 'status'] as const,
};

export function useMicrosoft365Status() {
    return useQuery<Microsoft365Status, Error>({
        queryKey: microsoft365Keys.status,
        queryFn: async ({ signal }) => {
            const body = await apiClient.get<Microsoft365Status>(`${BASE}/status`, { signal, retry: false });
            return body || { configured: false, connected: false };
        },
        retry: false,
    });
}

/**
 * Refresh everything that changes when the connection does: this tile's
 * status, and the /ai/user-settings payload whose `hasMicrosoftConnection`
 * decides whether the agent designer offers Outlook.
 */
export function useInvalidateMicrosoft365() {
    const qc = useQueryClient();
    return () => Promise.all([
        qc.invalidateQueries({ queryKey: microsoft365Keys.status }),
        qc.invalidateQueries({ queryKey: integrationStatusKeys.all }),
    ]);
}

export function useDisconnectMicrosoft365() {
    const invalidate = useInvalidateMicrosoft365();
    return useMutation<unknown, Error, void>({
        mutationFn: () => apiClient.post(`${BASE}/disconnect`, {}, { retry: false }),
        onSettled: () => invalidate(),
    });
}
