/**
 * Did the server answer, or did we never reach it?
 *
 * This is the distinction the cold-start path was missing. `resolve()` wrapped
 * the whole of /auth/user in one `catch` and turned everything it caught into
 * `signed-out` — so a lift, a train tunnel, a captive portal, a hotel Wi-Fi
 * splash page and a server mid-deploy all produced the login screen, for a user
 * whose session was perfectly valid and whose cookie was still on the device.
 *
 * Worse, it was unrecoverable in the way that matters: the app cannot log you
 * back in while it has no network either, so you sit at a form you cannot
 * complete, and the honest reading of the screen — "I have been logged out" —
 * is wrong.
 *
 * A server that answers 4xx has made a statement about this session. Anything
 * else is a statement about the network.
 */

import { ApiError, OfflineError } from '@/core/api/client';

/**
 * True when the failure is the server's considered answer about who you are,
 * rather than a failure to ask it.
 *
 * 5xx is deliberately NOT an answer about the session: a 502 from a proxy
 * while the API restarts says nothing about the cookie in your keystore, and
 * treating it as a sign-out is how a thirty-second deploy logs out every phone
 * that happened to be opened during it.
 */
export function serverAnsweredAboutSession(err: unknown): boolean {
    if (err instanceof OfflineError) return false;
    if (!(err instanceof ApiError)) return false;
    const status = err.status;
    return typeof status === 'number' && status >= 400 && status < 500;
}
