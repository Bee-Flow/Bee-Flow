/**
 * The unread count behind the header bell.
 *
 * Polling, not push: this app deliberately ships without Firebase (see
 * README.md), so the badge refreshes every 60s while the app is in the
 * foreground; React Query pauses it in the background because focusManager is
 * bridged to AppState. Every mounted header shares ONE observer, interval and
 * request, because React Query dedupes by key — which is why mounting the bell
 * on ~45 screens costs nothing.
 */

import { useQuery } from '@tanstack/react-query';

import { getUnreadCount } from '../api/endpoints';
import { notificationKeys } from '../api/keys';

export function useUnreadCount(): number {
    const { data } = useQuery({
        queryKey: notificationKeys.unread,
        queryFn: ({ signal }) => getUnreadCount(signal),
        refetchInterval: 60_000,
        // A failing badge must never surface an error to the user — the count
        // is a nicety, and the screen behind it still works.
        retry: false,
        staleTime: 30_000,
    });
    return typeof data === 'number' ? data : 0;
}
