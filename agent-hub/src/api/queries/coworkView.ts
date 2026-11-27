// The Cowork view a person chose after the introduction (`coworkView` of
// /ai/user-settings). It lives on the server, so the introduction plays once per
// person, on every device, not once per browser.

import { useQuery } from '@tanstack/react-query';
import { apiFetch, apiRequest } from '../typedRequest';

export type SavedCoworkView = 'orb' | 'chat' | 'advanced';
const VIEWS: readonly SavedCoworkView[] = ['orb', 'chat', 'advanced'];
const viewOf = (value: unknown): SavedCoworkView | null => VIEWS.find((view) => view === value) ?? null;

/** Stores the view; a failed save keeps the local choice and is retried with the next one. */
export function saveCoworkView(view: SavedCoworkView): Promise<unknown> {
    return apiRequest('POST /ai/user-settings', { body: { coworkView: view } }).catch(() => null);
}

/**
 * The stored view, or `intro` when this person has none yet. Reading `intro`
 * also claims it: the default view is stored at once, so a reload halfway
 * through, or a second device, does not start the introduction again. When the
 * server cannot be asked the introduction plays without being claimed.
 */
export function useSavedCoworkView(enabled: boolean) {
    return useQuery<SavedCoworkView | 'intro'>({
        queryKey: ['user-settings', 'cowork-view'],
        enabled,
        staleTime: Infinity,
        retry: false,
        queryFn: async () => {
            const res = await apiFetch('GET /ai/user-settings');
            if (!res.ok) return 'intro';
            const stored = viewOf(((await res.json()) as { coworkView?: unknown }).coworkView);
            if (stored) return stored;
            await saveCoworkView('orb');
            return 'intro';
        },
    });
}
