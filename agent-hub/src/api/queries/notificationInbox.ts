// The notification inbox's reads: the latest 30 notifications, and the unread
// count the shell polls every 30 s. A refused or failed read is silent: the
// inbox keeps what it showed.

import { useQuery } from '@tanstack/react-query';
import { apiJson } from '../typedRequest';
import { READ_ONCE } from './readOnce';

export const notificationKeys = {
    list: ['notifications', 'list'] as const,
    unreadCount: ['notifications', 'unread-count'] as const,
};

const UNREAD_POLL_MS = 30_000;

/** The latest notifications. */
export function useNotificationListQuery<N>() {
    return useQuery<N[], Error>({
        queryKey: notificationKeys.list,
        ...READ_ONCE,
        queryFn: async () => {
            const data = await apiJson<'GET /api/notifications', { notifications?: N[] }>('GET /api/notifications', { query: { limit: 30 } });
            return data.notifications || [];
        },
    });
}

/** The unread count, asked on mount and every UNREAD_POLL_MS (in a background tab too). */
export function useUnreadCountQuery() {
    return useQuery<number, Error>({
        queryKey: notificationKeys.unreadCount,
        ...READ_ONCE,
        refetchInterval: UNREAD_POLL_MS,
        refetchIntervalInBackground: true,
        queryFn: async () => {
            const data = await apiJson<'GET /api/notifications/unread-count', { count?: number }>('GET /api/notifications/unread-count');
            return data.count || 0;
        },
    });
}
