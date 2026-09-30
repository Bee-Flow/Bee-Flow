/** Branding: what the account looks like, and the user's own override. */

import { api } from '@/core/api/client';

import { readEffectiveBranding, readPublicBranding, readUserBrandingResponse } from './readers';
import type {
    EffectiveBranding,
    PublicBranding,
    UserBrandingPatch,
    UserBrandingResponse,
} from '../model/types';

export async function getBranding(signal?: AbortSignal): Promise<EffectiveBranding | null> {
    return readEffectiveBranding(await api.get<unknown>('/api/branding/effective', { signal }));
}

/**
 * The signed-out theme, for the login and onboarding screens.
 *
 * Without this the phone paints those screens from the DEVICE colour scheme
 * while the web paints them from the org's branding — so a customer whose
 * organisation is themed light met a black login screen on Android and a white
 * one in the browser. Unauthenticated by design (see server/routes/branding.js),
 * so it is the one branding call that works before there is a session.
 */
export async function getPublicBranding(signal?: AbortSignal): Promise<PublicBranding | null> {
    return readPublicBranding(
        await api.get<unknown>('/api/branding/public', { signal, retry: false }),
    );
}

/** Persist the theme choice to the account, so the web app agrees with the
 *  phone. 403 means the admin turned user overrides off — a real answer. */
export async function saveUserBranding(patch: UserBrandingPatch): Promise<UserBrandingResponse | null> {
    return readUserBrandingResponse(await api.put<unknown>('/api/branding/user', patch));
}
