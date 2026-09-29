/**
 * The push tap that STARTS the app.
 *
 * `addNotificationResponseReceivedListener` only hears taps that arrive while
 * the JS is already running. A tap that cold-starts the app delivers its
 * response BEFORE any effect has registered a listener, so the notification
 * opened the app… onto the default screen, with the destination silently
 * dropped. The platform's answer is `getLastNotificationResponseAsync()`,
 * asked once the app is ready to navigate — _layout.tsx does the asking; this
 * module owns everything about the answer that can be tested without a device:
 *
 *   - digging the `link` out of the payload background.ts wrote
 *     (`{ notificationId, link }` — see scheduleNotificationAsync there);
 *   - translating it with the SAME total mapper the warm path uses
 *     (routeForPushLink — every input yields a route that exists);
 *   - and claiming each response exactly once. The claim matters twice over:
 *     the cold-start effect re-runs when the auth stage flips, and on some
 *     Android paths the same response ALSO reaches the warm listener — either
 *     way the user must not be re-routed to a screen they already left.
 */

import { routeForPushLink } from './pushRoute';

/** Responses already routed, for the life of this JS process. A cold start is
 *  a fresh process, so the ledger needs no persistence. */
const claimed = new Set<string>();

/**
 * A stable identity for one tap. The request identifier is unique per
 * scheduled notification; for a malformed response the date+link pair is the
 * best remaining witness — good enough to stop the same object twice, which
 * is the only job.
 */
export function pushResponseKey(response: unknown): string {
    const r = response as {
        notification?: {
            date?: unknown;
            request?: { identifier?: unknown; content?: { data?: { link?: unknown } } };
        };
    } | null;
    const id = r?.notification?.request?.identifier;
    if (typeof id === 'string' && id !== '') return id;
    return `${String(r?.notification?.date)}|${String(r?.notification?.request?.content?.data?.link)}`;
}

/**
 * Route for a tap response, exactly once.
 *
 * Returns the screen to push for the FIRST claim of a response, and null for
 * no response or one already handled. Total on the payload side: a response
 * with no link, a garbled `data`, the summary notification's `{ link: null }`
 * — all land on the inbox via routeForPushLink's fallback, never +not-found.
 */
export function claimPushResponse(response: unknown): string | null {
    if (response === null || response === undefined || typeof response !== 'object') return null;
    const key = pushResponseKey(response);
    if (claimed.has(key)) return null;
    claimed.add(key);

    const request = (response as { notification?: { request?: { content?: { data?: unknown } } } })
        .notification?.request?.content;
    const data = request && typeof request === 'object' ? request.data : null;
    const link = data !== null && typeof data === 'object' ? (data as { link?: unknown }).link : null;
    return routeForPushLink(link);
}

/** Test hook. Production code never forgets a claim. */
export function resetClaimedPushResponses(): void {
    claimed.clear();
}
