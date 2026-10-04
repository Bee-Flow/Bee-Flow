/**
 * Presentation helpers for the notification inbox.
 *
 * A local `relativeTime`, like every other feature folder in this app has —
 * see the note at the top of src/features/search/model/format.ts for why these are
 * not hoisted into a shared utils module.
 */

import type { TranslateFn } from '@/core/i18n';
import { nOf } from '@/shared/lib/plural';

import type { AppNotification } from './types';

export type TimeBucket = 'today' | 'this_week' | 'older';

export const BUCKET_LABELS: Record<TimeBucket, string> = {
    today: 'Today',
    this_week: 'Earlier this week',
    older: 'Older',
};

/** Same three buckets the web inbox uses, so both clients group identically. */
export function bucketFor(iso: string | null | undefined): TimeBucket {
    if (!iso) return 'older';
    const then = new Date(iso);
    if (Number.isNaN(then.getTime())) return 'older';
    const now = new Date();
    if (then.toDateString() === now.toDateString()) return 'today';
    const weekAgo = new Date(now);
    weekAgo.setDate(weekAgo.getDate() - 7);
    return then > weekAgo ? 'this_week' : 'older';
}

/**
 * One line of body text for a list row.
 *
 * For an `ai_task` / `cowork` result the `message` column is the run's whole
 * markdown output, so a naive subtitle would be a wall of `##` and `|---|`.
 * The markers are stripped and the text collapsed; the full body is still
 * available when the row is expanded.
 */
export function previewOf(message: string | null | undefined, max = 140): string {
    if (!message) return '';
    const flat = message
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/^\s{0,3}#{1,6}\s+/gm, '')
        .replace(/[*_`>|]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    return flat.length > max ? `${flat.slice(0, max).trimEnd()}…` : flat;
}

/**
 * Automation credential failures put a deep-link token at the head of the body:
 * `automation_reauth:<provider>\n\n<the real message>`. The token is machinery,
 * not prose, so it is split off before anything is rendered.
 */
export function parseReauthToken(message: string | null | undefined): {
    provider: string | null;
    body: string;
} {
    if (!message) return { provider: null, body: '' };
    const match = /^automation_reauth:([a-z0-9_-]+)\n\n?([\s\S]*)$/i.exec(message);
    if (!match) return { provider: null, body: message };
    return { provider: (match[1] ?? '').toLowerCase(), body: match[2] ?? '' };
}

/**
 * The body of a phone notification: the machinery token split off FIRST, then
 * the preview. The other way round, `previewOf` strips the underscore and the
 * lock screen read "routinereauth:google Your Google access has expired…".
 */
export function announcementBody(message: string | null | undefined, max = 160): string {
    return previewOf(parseReauthToken(message).body, max);
}

/** The summary notification after the first few: "3 more updates waiting." */
export function moreWaiting(count: number, t: TranslateFn): string {
    return nOf(t, 'mobile.notifications.more_waiting', count, ['{count} more update waiting.', '{count} more updates waiting.']);
}

export function unreadCount(notifications: AppNotification[]): number {
    return notifications.reduce((count, n) => (n.read ? count : count + 1), 0);
}
