/** The org shield's one write. Writes do not retry. */

import { useMutation, useQueryClient } from '@tanstack/react-query';

import { saveShieldDoc } from '../api/endpoints';
import { ORG_SUMMARY_ROOT, orgShieldKeys } from '../api/keys';
import { readShieldDoc } from '../api/readers';
import type { ShieldSaveResult } from '../model/types';

/**
 * PUT the whole document. On success the server's row becomes the cached
 * document (with the clamps it reported), and the personal screen's summary
 * of the same row is refetched.
 */
export function useSaveShield(orgId: string | null) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (body: Record<string, unknown>): Promise<ShieldSaveResult> => {
            if (!orgId) return Promise.reject(new Error('No organisation'));
            return saveShieldDoc(orgId, body);
        },
        onSuccess: (result, body) => {
            if (!orgId) return;
            const stored = readShieldDoc({
                ...(result.config ?? body),
                clamped_fields: result.clampedFields,
                clamped_tier: result.clampedTier,
            });
            queryClient.setQueryData(orgShieldKeys.doc(orgId), stored);
            void queryClient.invalidateQueries({ queryKey: [...ORG_SUMMARY_ROOT, orgId] });
        },
    });
}
