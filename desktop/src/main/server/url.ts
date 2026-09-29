/**
 * Turning what a person types into a URL the app can use.
 *
 * This is the first thing a new install asks for, and people type
 * `bee.example.com`, `https://bee.example.com/`, `http://192.168.1.40:5176`,
 * `192.168.1.40:5176`, `cloud.example.com/beeflow`, `nas`, and, often enough, a
 * URL copied out of a browser with `/app/chat` still on the end. All of those
 * describe a server this client can reach; refusing some of them because they
 * are not a tidy origin would be pedantry dressed up as validation.
 */

import type { ServerProbeFailure } from '../../shared/types.ts';

export type NormalisedUrl =
    | {
          ok: true;
          url: string;
          /** Plain http to anything but this computer: the UI says it is not encrypted. */
          insecure: boolean;
          /** The person typed `http://` or `https://`. Without one, https is tried first. */
          schemeTyped: boolean;
          /** The person typed a port. */
          portTyped: boolean;
      }
    | { ok: false; error: string; code: ServerProbeFailure };

/** Paths the SPA routes on its own; not part of the API base. */
const SPA_PREFIXES = ['/app', '/login', '/chat', '/admin', '/api'];

/**
 * Where a host is, as far as trusting plain http goes.
 *
 * - `loopback`: this computer. Nothing crosses a network; http is fine.
 * - `private`: an IP literal in a private range (RFC 1918, CGNAT as used by
 *   Tailscale, IPv6 unique-local and link-local). Only a machine on a network
 *   the user is actually on can answer it.
 * - `lan-name`: a name that only a local resolver can answer — `nas`,
 *   `nas.local`, `bee.lan`, `x.internal`, `x.home.arpa`. Real, and usually the
 *   user's own server, but whoever runs the network they are on right now
 *   decides what it resolves to: on café Wi-Fi, `nas.local` can be anyone.
 * - `public`: everything else.
 *
 * The difference between `private` and `lan-name` is the whole reason this
 * exists: an address typed without a scheme falls back to http silently only
 * for the first, never for a name somebody else's network can answer.
 */
export type HostKind = 'loopback' | 'private' | 'lan-name' | 'public';

export function hostKind(hostname: string): HostKind {
    const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');

    if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') return 'loopback';
    const v4 = ipv4(host);
    if (v4) {
        const [a, b] = v4;
        if (a === 127) return 'loopback';
        if (a === 10) return 'private';
        if (a === 172 && b >= 16 && b <= 31) return 'private';
        if (a === 192 && b === 168) return 'private';
        if (a === 100 && b >= 64 && b <= 127) return 'private';
        if (a === 169 && b === 254) return 'private';
        return 'public';
    }
    if (host.includes(':')) {
        // IPv6 literal. fc00::/7 is unique-local, fe80::/10 link-local.
        if (/^f[cd][0-9a-f]{0,2}:/.test(host)) return 'private';
        if (/^fe[89ab][0-9a-f]?:/.test(host)) return 'private';
        return 'public';
    }
    if (!host.includes('.')) return 'lan-name';
    if (host.endsWith('.local') || host.endsWith('.lan') || host.endsWith('.internal') || host.endsWith('.home.arpa')) return 'lan-name';
    return 'public';
}

/** The four octets of a dotted IPv4 literal, or null. */
function ipv4(host: string): [number, number, number, number] | null {
    const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
    if (!match) return null;
    const octets = match.slice(1).map(Number) as [number, number, number, number];
    return octets.every((octet) => octet <= 255) ? octets : null;
}

export function normaliseServerUrl(raw: string): NormalisedUrl {
    const input = String(raw ?? '').trim();
    if (!input) return { ok: false, error: 'Enter the address of your Bee Flow server.', code: 'invalid-url' };

    // A scheme we cannot speak is worth naming, because `ftp://` and
    // `file://` both come from pasting the wrong thing rather than typing.
    const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(input)?.[1]?.toLowerCase();
    if (scheme && scheme !== 'http' && scheme !== 'https') {
        return { ok: false, error: `Bee Flow servers are reached over https (or http on your own network), not ${scheme}.`, code: 'invalid-url' };
    }

    let parsed: URL;
    try {
        parsed = new URL(scheme ? input : `https://${input}`);
    } catch {
        return { ok: false, error: 'That does not look like a web address. Try something like https://bee.example.com', code: 'invalid-url' };
    }

    if (!parsed.hostname) {
        return { ok: false, error: 'That address has no host name in it.', code: 'invalid-url' };
    }
    if (parsed.username || parsed.password) {
        return { ok: false, error: 'Leave the user name and password out of the address — you sign in on the next page.', code: 'invalid-url' };
    }

    // Strip what a copied URL carries and the API base has no use for. The
    // match has to be on a whole path segment: a server installed at
    // /app-gateway keeps its path, one reached at /beeflow/app/chat loses the
    // routed part and keeps /beeflow.
    let pathname = parsed.pathname.replace(/\/+$/, '');
    for (const prefix of SPA_PREFIXES) {
        const at = pathname.indexOf(prefix);
        if (at === -1) continue;
        const nextChar = pathname[at + prefix.length];
        if (nextChar === undefined || nextChar === '/') {
            pathname = pathname.slice(0, at);
            break;
        }
    }
    pathname = pathname.replace(/\/+$/, '');

    const insecure = parsed.protocol === 'http:' && hostKind(parsed.hostname) !== 'loopback';
    // `new URL` drops a default port, so ask the text: a port is typed when a
    // colon and digits follow the host.
    const portTyped = /^(?:[a-z]+:\/\/)?(?:\[[^\]]+\]|[^/:?#]+):\d+/i.test(input);
    return { ok: true, url: `${parsed.origin}${pathname}`, insecure, schemeTyped: Boolean(scheme), portTyped };
}

/** The same address over plain http, keeping host, port and path. */
export function withHttp(url: string): string {
    const parsed = new URL(url);
    parsed.protocol = 'http:';
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
}

/** The origin only — what the navigation policy and the header filter compare. */
export function originOf(url: string): string | null {
    try {
        const origin = new URL(url).origin;
        return origin === 'null' ? null : origin;
    } catch {
        return null;
    }
}

/** Are these two URLs the same Bee Flow install? Compares origin and subpath. */
export function isSameServer(a: string, b: string): boolean {
    const left = normaliseServerUrl(a);
    const right = normaliseServerUrl(b);
    return left.ok && right.ok && left.url === right.url;
}

/** Build a URL under the server, e.g. apiUrl('https://x', '/api/health'). */
export function serverUrl(base: string, pathSuffix: string): string {
    const trimmed = base.replace(/\/+$/, '');
    const suffix = pathSuffix.startsWith('/') ? pathSuffix : `/${pathSuffix}`;
    return `${trimmed}${suffix}`;
}
