/**
 * Which published forms this person reaches for — a port of the web's
 * utils/formRecents.js. The drawer lists five forms, an organisation can
 * publish many more, and the honest order is "the ones YOU opened", most
 * recent first, then newest-published for the rest.
 *
 * The signal lives on the device, per user, as on the web (scoped storage):
 * the server's `submissions` / `lastSeenAt` count what anonymous VISITORS did,
 * which is a different thing. A few more are remembered than are shown, so
 * dropping off the menu is not the same as being forgotten.
 *
 * Best-effort: storage failing is not a reason to fail a menu or a tap.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

import type { FormSummary } from './types';

/** `{ [formId]: epochMs }`. */
export type FormRecents = Readonly<Record<string, number>>;

/** The web's REMEMBERED. */
export const REMEMBERED = 12;

const keyFor = (userId: string) => `beeflow.forms.recent.v1.${userId}`;

/** Only usable timestamps survive a read: anything else would sort unpredictably. */
export function cleanRecents(value: unknown): FormRecents {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).filter(
            (entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1]) && entry[1] > 0,
        ),
    );
}

/** `id` stamped at `now`, the oldest dropped past REMEMBERED. */
export function stampRecent(recents: FormRecents, id: string, now: number): FormRecents {
    return Object.fromEntries(
        Object.entries({ ...recents, [id]: now })
            .sort((a, b) => b[1] - a[1])
            .slice(0, REMEMBERED),
    );
}

/** The `limit` forms to offer: opened (most recent first), then newest-published. */
export function recentForms(forms: readonly FormSummary[], limit = 5, recents: FormRecents = {}): FormSummary[] {
    const openedAt = (form: FormSummary) => recents[form.id] ?? 0;
    const publishedAt = (form: FormSummary) => (form.createdAt ? Date.parse(form.createdAt) || 0 : 0);
    return [...forms]
        .sort((a, b) => openedAt(b) - openedAt(a) || publishedAt(b) - publishedAt(a))
        .slice(0, Math.max(0, limit));
}

export async function loadFormRecents(userId: string): Promise<FormRecents> {
    try {
        const raw = await AsyncStorage.getItem(keyFor(userId));
        return raw ? cleanRecents(JSON.parse(raw)) : {};
    } catch {
        return {};
    }
}

/** Stamp a form as opened by this user, now; answers the new map. */
export async function rememberFormOpened(userId: string, id: string, now = Date.now()): Promise<FormRecents> {
    const next = stampRecent(await loadFormRecents(userId), id, now);
    try {
        await AsyncStorage.setItem(keyFor(userId), JSON.stringify(next));
    } catch {
        /* a full disk is not worth failing a navigation over */
    }
    return next;
}
