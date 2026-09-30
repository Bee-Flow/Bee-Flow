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

import { api, ApiError } from '@/core/api/client';

import { readMarkedCount, readNotifications, readUnreadCount } from './readers';
import type { AppNotification } from '../model/types';

export async function listNotifications(
    opts: { unreadOnly?: boolean; limit?: number } = {},
    signal?: AbortSignal,
): Promise<AppNotification[]> {
    const res = await api.get<unknown>('/api/notifications', {
        signal,
        query: {
            // The route reads `req.query.unread === 'true'`, so the string
            // form is the contract; anything else means "everything".
            unread: opts.unreadOnly ? 'true' : undefined,
            limit: opts.limit ?? 50,
        },
    });
    return readNotifications(res);
}

export async function getUnreadCount(signal?: AbortSignal): Promise<number> {
    const res = await api.get<unknown>('/api/notifications/unread-count', {
        signal,
        // The badge is a nicety. A failing count must never retry into the
        // user's data plan or surface an error over the screen behind it.
        retry: false,
    });
    return readUnreadCount(res);
}

/** Resolves quietly on 404: the row is gone, which is the state we wanted. */
async function ignoringGone(request: Promise<unknown>): Promise<void> {
    try {
        await request;
    } catch (err) {
        if (err instanceof ApiError && err.status === 404) return;
        throw err;
    }
}

export function markNotificationRead(id: string): Promise<void> {
    return ignoringGone(api.post(`/api/notifications/${encodeURIComponent(id)}/read`));
}

/** Returns how many rows changed, so the screen can say nothing happened. */
export async function markAllNotificationsRead(): Promise<number> {
    return readMarkedCount(await api.post<unknown>('/api/notifications/read-all'));
}

export function deleteNotification(id: string): Promise<void> {
    return ignoringGone(api.delete(`/api/notifications/${encodeURIComponent(id)}`));
}
