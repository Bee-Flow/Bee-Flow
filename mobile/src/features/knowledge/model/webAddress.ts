/**
 * A web address as a person types it. Nobody types `https://` on a phone, so
 * an address without a scheme gets one — the server's fetcher only takes
 * http(s) — and the forms say so under the field rather than keeping their
 * button off until the scheme is there.
 */

/** A scheme, as in `https://` or `ftp://`; `host:8080` is not one. */
const SCHEME_RX = /^[a-z][a-z0-9+.-]*:\/\//i;

/** http(s), a host with a dot in it, and no spaces anywhere. */
const WEB_ADDRESS_RX = /^https?:\/\/[^\s/.]+\.[^\s]+$/i;

/** The trimmed address with `https://` in front when it has no scheme; '' stays ''. */
export function withScheme(raw: string): string {
    const value = raw.trim();
    if (!value) return '';
    return SCHEME_RX.test(value) ? value : `https://${value}`;
}

/** Whether the address, once `withScheme` has had it, is worth sending. */
export function isWebAddress(raw: string): boolean {
    return WEB_ADDRESS_RX.test(withScheme(raw));
}
