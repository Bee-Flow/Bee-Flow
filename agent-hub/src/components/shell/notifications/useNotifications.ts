import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { notificationKeys, useNotificationListQuery, useUnreadCountQuery } from '@/api/queries/notificationInbox';
import useAdjustOnChange from '@/hooks/useAdjustOnChange';
import { settingsPathForTab } from '@/authedApp/settingsRoutes';
import { logger } from '@/utils/logger';
import { RefusedError } from '@/api/mutate';
import { apiRequest } from '@/api/typedRequest';

/** One notification as GET /api/notifications returns it. */
export interface AppNotification {
    id: string;
    title?: string;
    message?: string | null;
    category?: string;
    read?: boolean;
    link?: string | null;
    created_at?: string | null;
    task_id?: string | null;
    taskId?: string | null;
    [key: string]: unknown;
}

export interface ChatTarget { agentId: string | null; conversationId: string | null }

const NO_TARGET: ChatTarget = { agentId: null, conversationId: null };
const NO_NOTIFICATIONS: AppNotification[] = [];

/**
 * Where a finished run should continue.
 *
 * A cowork item that ran as an agent belongs in that agent's chat, on the
 * very thread it ran in; one without an agent has no thread, so it opens in
 * direct chat. Every scheduled item is a Cowork schedule now (the old
 * ai_tasks rows moved there with their ids), whatever category an older
 * notification carries.
 */
export async function resolveChatTarget(n: AppNotification | null | undefined): Promise<ChatTarget> {
    const taskId = n?.task_id || n?.taskId || null;
    if (!taskId) return NO_TARGET;
    try {
        let res: Response;
        try {
            res = await apiRequest('GET /api/cowork/{id}', { params: { id: taskId } });
        } catch (err) {
            if (!(err instanceof RefusedError)) throw err;
            return NO_TARGET;
        }
        return chatTargetOf(await res.json());
    } catch (_) {
        return NO_TARGET;
    }
}

/** The agent and thread a Cowork item ran in, in either casing the API has used. */
function chatTargetOf(item: Record<string, string | null | undefined> | null): ChatTarget {
    return {
        agentId: item?.agentId || item?.agent_id || null,
        conversationId: item?.conversationId || item?.conversation_id || null,
    };
}

/**
 * Reconnect an automation's expired credentials. BFSF-255: Google reconnects
 * go through the CONNECT flow (popup + vault), NEVER the SSO LOGIN flow —
 * /auth/login/google replaces the session and can silently create a NEW user
 * for password accounts. On failure the user goes to the Connections
 * settings instead of falling back to that trap.
 */
export async function startReconnect(provider: string): Promise<void> {
    if (provider === 'google') {
        try {
            const res = await apiRequest('GET /api/integrations/google/auth-url');
            const data = await res.json().catch(() => ({}));
            if (data.url) {
                const [w, h] = [600, 700];
                window.open(data.url, 'google-oauth', `width=${w},height=${h},left=${(screen.width - w) / 2},top=${(screen.height - h) / 2}`);
                return;
            }
        } catch (err) { logger.debug('fall through to the settings page below', err); }
        // A path, not ?tab=: the settings router reads the pathname only, so
        // the query form opened Preferences.
        window.open(settingsPathForTab('integrations'), '_blank', 'noopener');
        return;
    }
    // Pop a fresh tab so the user keeps the notifications panel open.
    const url = `/auth/login/${encodeURIComponent(provider)}?returnTo=${encodeURIComponent(window.location.pathname || '/')}`;
    window.open(url, '_blank', 'noopener');
}

/**
 * The notification inbox: the list, the unread count (polled every 30 s,
 * with a refetch of the list when it grows) and the read / delete writes.
 * Split out of NotificationCenter.jsx without a change in behaviour.
 */
export function useNotifications() {
    const qc = useQueryClient();
    const listQuery = useNotificationListQuery<AppNotification>();
    const countQuery = useUnreadCountQuery();
    const notifications = listQuery.data ?? NO_NOTIFICATIONS;
    const setNotifications = useCallback((change: (prev: AppNotification[]) => AppNotification[]) => {
        qc.setQueryData<AppNotification[]>(notificationKeys.list, (prev) => change(prev ?? []));
    }, [qc]);
    const [unreadCount, setUnreadCount] = useState(0);
    // A count above the one on screen means something new: the list is read again.
    const [grewAt, setGrewAt] = useState(0);

    useAdjustOnChange([listQuery.dataUpdatedAt], () => {
        if (listQuery.data) setUnreadCount(listQuery.data.filter(n => !n.read).length);
    });
    useAdjustOnChange([countQuery.dataUpdatedAt], () => {
        if (countQuery.data === undefined) return;
        if (countQuery.data > unreadCount) setGrewAt(countQuery.dataUpdatedAt);
        setUnreadCount(countQuery.data);
    });
    const refetchList = listQuery.refetch;
    useEffect(() => { if (grewAt) void refetchList(); }, [grewAt, refetchList]);

    const fetchNotifications = useCallback(async () => { await refetchList(); }, [refetchList]);
    const loading = listQuery.isFetching;

    const markRead = async (id: string) => {
        await apiRequest('POST /api/notifications/{id}/read', { params: { id } });
        setNotifications(prev => prev.map(n => n.id === id ? { ...n, read: true } : n));
        setUnreadCount(prev => Math.max(0, prev - 1));
    };

    const markAllRead = async () => {
        await apiRequest('POST /api/notifications/read-all');
        setNotifications(prev => prev.map(n => ({ ...n, read: true })));
        setUnreadCount(0);
    };

    /** Delete one; resolves once the list no longer holds it. */
    const deleteNotification = async (id: string) => {
        const wasUnread = notifications.find(n => n.id === id && !n.read);
        await apiRequest('DELETE /api/notifications/{id}', { params: { id } });
        setNotifications(prev => prev.filter(n => n.id !== id));
        if (wasUnread) setUnreadCount(prev => Math.max(0, prev - 1));
    };

    return { notifications, unreadCount, loading, fetchNotifications, markRead, markAllRead, deleteNotification };
}
