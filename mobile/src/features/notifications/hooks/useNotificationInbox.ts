/**
 * The inbox's state: the All/Unread filter, which row is expanded, the rows in
 * their sections, and the three writes — with the one line a failed write
 * leaves on screen until it is dismissed.
 */

import { useRouter } from 'expo-router';
import { useState } from 'react';

import { describeError } from '@/core/api/errors';
import { openRoute } from '@/shared/navigation';
import { useToast } from '@/shared/ui';

import { useDeleteNotification, useMarkAllNotificationsRead, useMarkNotificationRead } from './mutations';
import { useNotifications } from './queries';
import { unreadCount } from '../model/format';
import { targetForNotification } from '../model/route';
import { sectionsByAge } from '../model/sections';
import { RESULT_CATEGORIES, type AppNotification } from '../model/types';

export function useNotificationInbox() {
    const router = useRouter();
    const { toast } = useToast();
    const [unreadOnly, setUnreadOnly] = useState(false);
    /** The row whose full body is open. One at a time — this is a list, not a feed. */
    const [expandedId, setExpandedId] = useState<string | null>(null);

    const query = useNotifications(unreadOnly);
    const notifications = query.data ?? [];
    const markRead = useMarkNotificationRead(unreadOnly);
    const markAll = useMarkAllNotificationsRead((marked) =>
        toast(marked === 0 ? 'Everything was already read' : `${marked} marked as read`, 'success'),
    );
    const remove = useDeleteNotification(() => toast('Notification deleted', 'success'));

    const open = (notification: AppNotification) => {
        if (!notification.read) markRead.mutate(notification.id);
        const target = targetForNotification(notification);
        // A result notification carries its whole output in `message`, so
        // "open" means "show me the rest of it", not "navigate" — even when it
        // has somewhere to go: neither the automation list nor a Cowork item
        // shows this result in full. The expanded row offers that place as
        // its own button (follow).
        if (target.href && !RESULT_CATEGORIES.has(notification.category)) {
            openRoute(router, target.href);
            return;
        }
        setExpandedId((current) => (current === notification.id ? null : notification.id));
    };

    /** Go where the notification points — the expanded result row's button. */
    const follow = (notification: AppNotification) => {
        const { href } = targetForNotification(notification);
        if (href) openRoute(router, href);
    };

    const failed = markAll.error ?? remove.error ?? markRead.error ?? null;
    return {
        query,
        unreadOnly,
        setUnreadOnly,
        expandedId,
        notifications,
        sections: sectionsByAge(notifications),
        unread: unreadCount(notifications),
        open,
        follow,
        markRead,
        markAll,
        remove,
        failure: failed ? describeError(failed) : null,
        dismissFailure: () => {
            markAll.reset();
            remove.reset();
            markRead.reset();
        },
    };
}
