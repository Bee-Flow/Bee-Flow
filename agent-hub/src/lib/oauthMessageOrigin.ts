import { logger } from '../utils/logger';
// Sender validation for OAuth popup callback messages.
//
// The callback pages post their result to window.opener. Without an origin
// check any window holding a handle on the SPA (an embedded frame, another
// tab) could post a forged message and make the UI report a connection that
// never happened. The callback page is served from the API origin; in dev
// that differs from the SPA's own origin, so both are trusted.

export function trustedOAuthOrigins(apiBase?: string): string[] {
    let apiOrigin = window.location.origin;
    try {
        apiOrigin = new URL(apiBase || '', window.location.origin).origin;
    } catch (err) { logger.debug('keep the SPA origin', err); }
    return Array.from(new Set([apiOrigin, window.location.origin]));
}

export function isTrustedOAuthOrigin(origin: string, apiBase?: string): boolean {
    return trustedOAuthOrigins(apiBase).includes(origin);
}
