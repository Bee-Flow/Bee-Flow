/**
 * Where a tapped PUSH notification goes — the hard-hat variant of route.ts.
 *
 * The inbox screen can afford three outcomes (a route, "web only" with a
 * reason, or expanding the row in place). A push tap cannot: by the time the
 * listener runs, the only UI is whatever screen it navigates to, so the answer
 * must ALWAYS be a route that exists. Pushing the server's raw web path
 * (`/app/studio/automations/<id>?view=runs`) into expo-router matches nothing
 * in the app/ tree and lands on the auto-injected +not-found screen — which is
 * exactly the bug this file exists to close.
 *
 * The payload is also thinner than an inbox row: background.ts sends only
 * `{ notificationId, link }`, no category and no task_id, so the category
 * fallbacks in `targetForNotification` cannot run here. What is left:
 *   - a link route.ts can translate  → that screen;
 *   - anything else (unknown path, web-only screen, absolute URL, null,
 *     garbage) → the inbox, the one screen guaranteed to contain the
 *     notification that was tapped.
 */

import { translateWebLink } from './route';

/**
 * The safe landing place: the notification inbox. Never +not-found — a row
 * that explains itself beats an error screen that explains nothing.
 */
export const PUSH_FALLBACK_ROUTE = '/notifications';

/**
 * Translate the `link` out of a push payload into an expo-router path.
 *
 * Total by design: whatever comes in — a known web path, an unknown one, a
 * web-only destination, null, or something that is not a string at all
 * (payload data crosses a process boundary and is not ours to trust) — a
 * navigable route comes out.
 */
export function routeForPushLink(link: unknown): string {
    if (typeof link !== 'string' || link.trim() === '') return PUSH_FALLBACK_ROUTE;
    const target = translateWebLink(link);
    return target?.href ?? PUSH_FALLBACK_ROUTE;
}
