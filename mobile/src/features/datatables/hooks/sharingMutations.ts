/**
 * Sharing writes. Publishing, granting and opening write access are the paid
 * boundary (402 `capability_required`); removing a grant never is.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';

import { refreshTable } from './tableMutations';
import { addGrant, removeGrant, setSharing } from '../api/endpoints';
import { datatableKeys } from '../api/keys';
import type { Grant, SharingDescriptor } from '../model/types';

export function useSetSharing(id: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (descriptor: SharingDescriptor) => setSharing(id, descriptor),
        onSuccess: (table) => {
            if (table) queryClient.setQueryData(datatableKeys.detail(id), table);
            refreshTable(queryClient, id);
        },
    });
}

export function useAddGrant(id: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (grant: Pick<Grant, 'granteeType' | 'granteeId' | 'grade'>) => addGrant(id, grant),
        onSuccess: (grants) => queryClient.setQueryData(datatableKeys.grants(id), grants),
    });
}

export function useRemoveGrant(id: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (grantId: string) => removeGrant(id, grantId),
        onSuccess: (grants) => queryClient.setQueryData(datatableKeys.grants(id), grants),
    });
}
