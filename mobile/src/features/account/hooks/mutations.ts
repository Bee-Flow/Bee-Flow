/** Profile writes. */

import { useMutation } from '@tanstack/react-query';

import { useAuth } from '@/core/auth/AuthProvider';

import { updateProfile, type ProfilePatch } from '../api/endpoints';

/**
 * Update the display name or avatar. The session carries both, so the whole
 * app re-reads the user afterwards rather than just this screen — and the
 * caller's own onSuccess runs once that re-read is done.
 */
export function useUpdateProfile() {
    const { refresh } = useAuth();
    return useMutation({
        mutationFn: (patch: ProfilePatch) => updateProfile(patch),
        onSuccess: async () => {
            await refresh();
        },
    });
}
