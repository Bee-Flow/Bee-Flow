/**
 * Plain http on a private address, treated as a secure context — for that one
 * origin, and only that one.
 *
 * Chromium makes http://localhost a secure context but not http://192.168.1.40.
 * On the second, `crypto.subtle` does not exist, and the web app's OPAQUE
 * sign-in and PIN unlock (which derive keys with it) throw. A self-hoster
 * trying Bee Flow on their LAN before they have a certificate is the most
 * common first run this product has, and "sign-in is broken" is a bad first
 * impression of a working server.
 *
 * Chromium's `--unsafely-treat-insecure-origin-as-secure` fixes exactly that,
 * for the origins it names. It is a startup switch, so it is decided here from
 * the settings file before the app is ready, and a new server that needs it
 * takes a restart.
 *
 * Only a private IP literal qualifies. Loopback is already secure. A name —
 * `nas.local`, `bee.lan` — is whatever the current network says it is, and on
 * someone else's Wi-Fi a page from a stranger would get a secure context
 * (service workers, powerful APIs) under the user's server's name. A public
 * host is not "the user's network" at all.
 */

import { hostKind } from './url.ts';

export const SECURE_ORIGIN_SWITCH = 'unsafely-treat-insecure-origin-as-secure';

/** The origin to treat as secure for this server, or null when none should be. */
export function secureContextOrigin(serverUrl: string): string | null {
    let parsed: URL;
    try {
        parsed = new URL(serverUrl);
    } catch {
        return null;
    }
    if (parsed.protocol !== 'http:') return null;
    return hostKind(parsed.hostname) === 'private' ? parsed.origin : null;
}

/**
 * The saved server URL, read synchronously from the settings file — before
 * the app is ready, which is the only time a Chromium switch can be set.
 * Anything unreadable is "no server": the switch is an exception, and failing
 * closed means not making one.
 */
export function savedServerUrl(readFile: () => string): string {
    try {
        const parsed = JSON.parse(readFile()) as { server?: { url?: unknown } };
        return typeof parsed?.server?.url === 'string' ? parsed.server.url : '';
    } catch {
        return '';
    }
}
