/**
 * Notification writes. Every one invalidates the badge as well as the list:
 * the header bell polls `notificationKeys.unread` every 60s, and without this
 * it would keep showing a count for things the user has just read.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';

import { deleteNotification, markAllNotificationsRead, markNotificationRead } from '../api/endpoints';
import { notificationKeys } from '../api/keys';
import type { AppNotification } from '../model/types';

function useInvalidateAll() {
    const queryClient = useQueryClient();
    return () => void queryClient.invalidateQueries({ queryKey: notificationKeys.all });
}

/**
 * Optimistic: marking read is the single most common gesture in the inbox,
 * and a 300ms round-trip before the dot disappears makes the list feel
 * unresponsive. The invalidation is the reconciliation.
 */
export function useMarkNotificationRead(unreadOnly: boolean) {
    const queryClient = useQueryClient();
    const invalidate = useInvalidateAll();
    return useMutation({
        mutationFn: (id: string) => markNotificationRead(id),
        onMutate: async (id: string) => {
            const key = notificationKeys.list(unreadOnly);
            await queryClient.cancelQueries({ queryKey: key });
            const previous = queryClient.getQueryData<AppNotification[]>(key);
            queryClient.setQueryData<AppNotification[]>(key, (rows) =>
                (rows ?? []).map((row) => (row.id === id ? { ...row, read: true } : row)),
            );
            return { previous };
        },
        onError: (_error, _id, context) => {
            if (context?.previous) queryClient.setQueryData(notificationKeys.list(unreadOnly), context.previous);
        },
        onSettled: invalidate,
    });
}

/** `onDone` gets how many rows changed, so the screen can say nothing happened. */
export function useMarkAllNotificationsRead(onDone: (marked: number) => void) {
    const invalidate = useInvalidateAll();
    return useMutation({
        mutationFn: () => markAllNotificationsRead(),
        onSuccess: (marked) => {
            onDone(marked);
            invalidate();
        },
    });
}

export function useDeleteNotification(onDone: () => void) {
    const invalidate = useInvalidateAll();
    return useMutation({
        mutationFn: (id: string) => deleteNotification(id),
        onSuccess: () => {
            onDone();
            invalidate();
        },
    });
}
