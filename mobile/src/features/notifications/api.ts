/**
 * Notification endpoints.
 *
 * The router is mounted at `/api/notifications` (server/index.js) and every
 * route reads `req.session.user.id`, so a 401 here means the session lapsed,
 * never "you have no notifications".
 *
 *     GET    /api/notifications              → { notifications: [...] }
 *     GET    /api/notifications/unread-count → { count }
 *     POST   /api/notifications/read-all     → { success, marked }
 *     POST   /api/notifications/:id/read     → { success }
 *     DELETE /api/notifications/:id          → { success }
 *
 * Both single-row routes answer 404 — not 403 — for a notification that exists
 * but belongs to someone else, deliberately, so the endpoint cannot be used as
 * an id-existence oracle. The client must therefore treat 404 as "already
 * gone" and reconcile, not as an error worth showing.
 */

import type { AppNotification, UnreadCountResponse } from './types';
import { api, ApiError } from '../../api/client';
import { asCount, field, shapeListOf } from '../../api/contract';


export const notificationKeys = {
    all: ['notifications'] as const,
    list: (unreadOnly: boolean) => ['notifications', 'list', unreadOnly] as const,
    /**
     * MUST stay `['notifications','unread']` — src/ui/AppHeader.tsx polls the
     * badge under exactly this key, and a mutation here has to be able to
     * invalidate it. Changing this string silently freezes the bell's count.
     */
    unread: ['notifications', 'unread'] as const,
};

/**
 * Allow-list over the raw `SELECT *` row (see types.ts for the columns and
 * serverContract.test.ts for the pin on the server side). These rows feed the
 * BACKGROUND announcer as well as the inbox, and a poll that throws on one
 * malformed row is a poll that silently never announces anything again — so
 * every field degrades to something renderable instead.
 */
const readNotificationRows = shapeListOf({
    id: field.str(''),
    task_id: field.strOrNull,
    category: field.str('info'),
    title: field.str('Notification'),
    message: field.str(''),
    link: field.strOrNull,
    read: field.bool(false),
    created_at: field.strOrNull,
});

export async function listNotifications(
    opts: { unreadOnly?: boolean; limit?: number } = {},
    signal?: AbortSignal,
): Promise<AppNotification[]> {
    const res = await api.get<{ notifications?: unknown }>('/api/notifications', {
        signal,
        query: {
            // The route reads `req.query.unread === 'true'`, so the string
            // form is the contract; anything else means "everything".
            unread: opts.unreadOnly ? 'true' : undefined,
            limit: opts.limit ?? 50,
        },
    });
    // A row without an id cannot be marked read, deleted, or deduplicated by
    // the announcer's ledger — dropping it is the only honest option.
    return readNotificationRows(res?.notifications).filter((n) => n.id !== '');
}

export async function getUnreadCount(signal?: AbortSignal): Promise<number> {
    const res = await api.get<UnreadCountResponse>('/api/notifications/unread-count', {
        signal,
        // The badge is a nicety. A failing count must never retry into the
        // user's data plan or surface an error over the screen behind it.
        retry: false,
    });
    return asCount(res?.unread) ?? asCount(res?.count) ?? 0;
}

/** Resolves quietly on 404: the row is gone, which is the state we wanted. */
export async function markNotificationRead(id: string): Promise<void> {
    try {
        await api.post(`/api/notifications/${encodeURIComponent(id)}/read`);
    } catch (err) {
        if (err instanceof ApiError && err.status === 404) return;
        throw err;
    }
}

/** Returns how many rows changed, so the screen can say nothing happened. */
export async function markAllNotificationsRead(): Promise<number> {
    const res = await api.post<{ success: boolean; marked: number }>(
        '/api/notifications/read-all',
    );
    return res?.marked ?? 0;
}

export async function deleteNotification(id: string): Promise<void> {
    try {
        await api.delete(`/api/notifications/${encodeURIComponent(id)}`);
    } catch (err) {
        if (err instanceof ApiError && err.status === 404) return;
        throw err;
    }
}
