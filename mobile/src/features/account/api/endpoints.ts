/**
 * The signed-in account's own profile write, under `/auth/…`
 * (auth/loginRoutes.js). It returns no body the app reads: the session is
 * re-read afterwards. Changing the password lives in features/security.
 */

import { api } from '@/core/api/client';

export interface ProfilePatch {
    displayName?: string;
    avatar?: string | null;
    avatarType?: string | null;
}

export async function updateProfile(patch: ProfilePatch): Promise<void> {
    await api.post('/auth/update-profile', patch);
}
