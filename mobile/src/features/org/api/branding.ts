/**
 * The organisation theme, icon packs and the Academy overview.
 *
 * Verified against:
 * - server/routes/branding.js — GET/PUT /api/branding/admin (requireAdmin:
 *   `manage_users` or `all`). The PUT body is `.strict()`, each knob in its own
 *   vocabulary (radiusScale 0.5–1.5, accent `#rrggbb`, font system|inter|plex|geist),
 *   and brandingStore.setOrgDefault MERGES it over the stored default — so a
 *   partial body leaves the glass and wallpaper knobs alone.
 * - server/routes/icons.js — GET /api/icons `{ packs, activeIconPackId, … }`
 *   and POST /api/icons/:id/activate with no body (`default` clears). Packs
 *   are the caller's own; activating one changes their own icons.
 * - server/routes/ai/learning.js — GET /ai/learning/org-overview
 *   (requirePrimaryOrgAdmin; learning/orgOverview.js builds the payload).
 */

import { api } from '@/core/api/client';

import { readIconPacks, readOrgTheme, type IconPacks } from './brandingReaders';
import { readAcademyOverview } from './sectionReaders';
import type { AcademyOverview } from '../model/sectionTypes';
import type { OrgTheme } from '../model/theme';

export async function getOrgTheme(signal?: AbortSignal): Promise<OrgTheme> {
    return readOrgTheme(await api.get<unknown>('/api/branding/admin', { signal }));
}

/** Only the changed knobs; the server merges them over what it holds. */
export async function saveOrgTheme(patch: Partial<OrgTheme>): Promise<OrgTheme> {
    return readOrgTheme(await api.put<unknown>('/api/branding/admin', patch));
}

export async function getIconPacks(signal?: AbortSignal): Promise<IconPacks> {
    return readIconPacks(await api.get<unknown>('/api/icons', { signal }));
}

/** `null` goes back to the built-in icons. */
export async function activateIconPack(packId: string | null): Promise<void> {
    await api.post(`/api/icons/${encodeURIComponent(packId ?? 'default')}/activate`);
}

export async function getAcademyOverview(signal?: AbortSignal): Promise<AcademyOverview | null> {
    return readAcademyOverview(await api.get<unknown>('/ai/learning/org-overview', { signal }));
}
