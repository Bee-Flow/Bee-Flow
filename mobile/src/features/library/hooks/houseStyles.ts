/** House-style reads and the one write a phone offers: making one the default. */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { listHouseStyles, setDefaultHouseStyle } from '../api/endpoints';
import { libraryKeys } from '../api/keys';

/** Read only while the sheet is open, and only for an account in an organisation. */
export function useHouseStyles(orgId: string | null, visible: boolean) {
    return useQuery({
        queryKey: libraryKeys.houseStyles(orgId ?? ''),
        queryFn: ({ signal }) => listHouseStyles(orgId as string, signal),
        enabled: visible && Boolean(orgId),
    });
}

export function useMakeDefaultHouseStyle(
    orgId: string | null,
    handlers: { onSuccess?: () => void; onError?: (error: Error) => void } = {},
) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (id: string) => setDefaultHouseStyle(orgId as string, id),
        onSuccess: () => {
            handlers.onSuccess?.();
            void queryClient.invalidateQueries({ queryKey: libraryKeys.houseStyles(orgId ?? '') });
        },
        onError: handlers.onError,
    });
}
