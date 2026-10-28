import { useCallback, useEffect, useRef, useState } from 'react';
import { settingsPathForTab } from '@/authedApp/settingsRoutes';
import { API_BASE } from '@/utils/helpers';
import { logger } from '@/utils/logger';
import { mutate, request, RefusedError } from '@/api/mutate';

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
            res = await request(`${API_BASE}/api/cowork/${taskId}`);
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
            const res = await request(`${API_BASE}/api/integrations/google/auth-url`);
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
    const [notifications, setNotifications] = useState<AppNotification[]>([]);
    const [unreadCount, setUnreadCount] = useState(0);
    const [loading, setLoading] = useState(false);

    const fetchNotifications = useCallback(async () => {
        setLoading(true);
        try {
            const res = await request(`${API_BASE}/api/notifications?limit=30`).catch((err: unknown) => {
                if (err instanceof RefusedError) return null;
                throw err;
            });
            if (res) {
                const data = await res.json();
                const list: AppNotification[] = data.notifications || [];
                setNotifications(list);
                setUnreadCount(list.filter(n => !n.read).length);
            }
        } catch (err) { logger.debug('silent', err); }
        setLoading(false);
    }, []);

    const fetchNotificationsRef = useRef(fetchNotifications);
    useEffect(() => { fetchNotificationsRef.current = fetchNotifications; }, [fetchNotifications]);

    const fetchCount = useCallback(async () => {
        try {
            const res = await request(`${API_BASE}/api/notifications/unread-count`).catch((err: unknown) => {
                if (err instanceof RefusedError) return null;
                throw err;
            });
            if (res) {
                const data = await res.json();
                const newCount: number = data.count || 0;
                setUnreadCount(prev => {
                    if (newCount > prev) {
                        fetchNotificationsRef.current?.();
                    }
                    return newCount;
                });
            }
        } catch (err) { logger.debug('silent', err); }
    }, []);

    useEffect(() => {
        fetchCount();
        fetchNotifications();
        const interval = setInterval(fetchCount, 30000);
        return () => clearInterval(interval);
    }, [fetchCount, fetchNotifications]);

    const markRead = async (id: string) => {
        await mutate(`${API_BASE}/api/notifications/${id}/read`, { method: 'POST' });
        setNotifications(prev => prev.map(n => n.id === id ? { ...n, read: true } : n));
        setUnreadCount(prev => Math.max(0, prev - 1));
    };

    const markAllRead = async () => {
        await mutate(`${API_BASE}/api/notifications/read-all`, { method: 'POST' });
        setNotifications(prev => prev.map(n => ({ ...n, read: true })));
        setUnreadCount(0);
    };

    /** Delete one; resolves once the list no longer holds it. */
    const deleteNotification = async (id: string) => {
        const wasUnread = notifications.find(n => n.id === id && !n.read);
        await mutate(`${API_BASE}/api/notifications/${id}`, { method: 'DELETE' });
        setNotifications(prev => prev.filter(n => n.id !== id));
        if (wasUnread) setUnreadCount(prev => Math.max(0, prev - 1));
    };

    return { notifications, unreadCount, loading, fetchNotifications, markRead, markAllRead, deleteNotification };
}
