/** Notification queries. Screens call these rather than useQuery. */

import { useQuery } from '@tanstack/react-query';

import { listNotifications } from '../api/endpoints';
import { notificationKeys } from '../api/keys';

export function useNotifications(unreadOnly: boolean) {
    return useQuery({
        queryKey: notificationKeys.list(unreadOnly),
        queryFn: ({ signal }) => listNotifications({ unreadOnly, limit: 50 }, signal),
    });
}
