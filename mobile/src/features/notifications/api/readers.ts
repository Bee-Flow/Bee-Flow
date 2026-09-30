/**
 * Contract readers for the notification routes (server/routes/notifications.js).
 */

import { asCount, field, pick, shapeListOf } from '@/core/api/contract';

import type { AppNotification } from '../model/types';

/**
 * Allow-list over the raw `SELECT *` row (see model/types.ts for the columns
 * and serverContract.test.ts for the pin on the server side). These rows feed
 * the BACKGROUND announcer as well as the inbox, and a poll that throws on one
 * malformed row is a poll that silently never announces anything again — so
 * every field degrades to something renderable instead.
 */
const readNotificationRows: (raw: unknown) => AppNotification[] = shapeListOf({
    id: field.str(''),
    task_id: field.strOrNull,
    category: field.str('info'),
    title: field.str('Notification'),
    message: field.str(''),
    link: field.strOrNull,
    read: field.bool(false),
    created_at: field.strOrNull,
});

/**
 * A row without an id cannot be marked read, deleted, or deduplicated by the
 * announcer's ledger — dropping it is the only honest option.
 */
export function readNotifications(raw: unknown): AppNotification[] {
    return readNotificationRows(pick(raw, 'notifications')).filter((n) => n.id !== '');
}

/** `{ count }`; `unread` is accepted too, and a count sent as a numeric string. */
export function readUnreadCount(raw: unknown): number {
    return asCount(pick(raw, 'unread')) ?? asCount(pick(raw, 'count')) ?? 0;
}

/** How many rows read-all changed, so the screen can say nothing happened. */
export function readMarkedCount(raw: unknown): number {
    return asCount(pick(raw, 'marked')) ?? 0;
}
