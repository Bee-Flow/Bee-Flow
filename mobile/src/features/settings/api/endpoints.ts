/**
 * The workspace's languages, the account's string catalogue, the same two
 * before sign-in, and the changelog.
 */

import { api, ApiError } from '@/core/api/client';
import { optional } from '@/core/api/optional';
import type { Catalogue } from '@/core/i18n';

import { readCatalogue, readLocales, readReleaseNotes } from './readers';
import type { Locale, ReleaseNote } from '../model/types';

/** Only the locales an administrator has added, each marked `isOrgDefault`. */
export async function listLocales(signal?: AbortSignal): Promise<Locale[]> {
    return readLocales(await api.get<unknown>('/api/languages/user/locales', { signal }));
}

/** The server's GUI strings for one locale; requires a session. */
export async function getLocaleStrings(locale: string, signal?: AbortSignal): Promise<Catalogue | null> {
    return readCatalogue(
        await api.get<unknown>(`/api/languages/user/strings/${encodeURIComponent(locale)}`, {
            signal,
        }),
    );
}

/**
 * Every locale the server offers, without a session: `{ code, name }` only, so
 * no organisation default (routes/admin/languageRoutes.js, /public/locales).
 */
export async function listPublicLocales(signal?: AbortSignal): Promise<Locale[]> {
    return readLocales(await api.get<unknown>('/api/languages/public/locales', { signal }));
}

/**
 * One locale's GUI strings, without a session — what the sign-in screens
 * render. Null when the server has no such locale (it answers 404), which
 * means English. A body that is not a catalogue throws instead, so a proxy's
 * page is never installed as an empty catalogue over the cached one.
 */
export async function getPublicLocaleStrings(locale: string, signal?: AbortSignal): Promise<Catalogue | null> {
    let raw: unknown;
    try {
        raw = await api.get<unknown>(`/api/languages/public/strings/${encodeURIComponent(locale)}`, { signal });
    } catch (err) {
        if (err instanceof ApiError && err.status === 404) return null;
        throw err;
    }
    const catalogue = readCatalogue(raw);
    if (!catalogue) throw new Error(`No readable catalogue for ${locale}`);
    return catalogue;
}

/** Public, cached 5 minutes server-side, and 503s rather than erroring when
 *  the changelog store is unavailable — which `optional` folds into null. */
export async function listReleaseNotes(signal?: AbortSignal): Promise<ReleaseNote[] | null> {
    return optional(async () =>
        readReleaseNotes(
            await api.get<unknown>('/api/release-notes/public', { signal, retry: false }),
        ),
    );
}
