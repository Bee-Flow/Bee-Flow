/**
 * A failed request, in words a person can do something about.
 *
 * The probe runs on Chromium's network stack (see chromiumFetch.ts), whose
 * failures are an Error with a message of exactly `net::ERR_SOMETHING` and
 * nothing else. The tests, and anything that still passes Node's fetch, see
 * undici's shape instead: a `TypeError('fetch failed')` with the real reason in
 * `cause.code`. Both are read here — Chromium's by exact code, undici's by
 * code with its message as a fallback.
 *
 * Every certificate branch tells people how to TRUST a certificate on their
 * platform, never how to skip the check. The app will not skip it.
 */

import type { Platform, ServerProbeFailure } from '../../shared/types.ts';

export interface ClassifiedError {
    code: ServerProbeFailure;
    message: string;
    /**
     * The failure is what https looks like against a port that speaks plain
     * http: the TLS handshake got an HTTP response back. The probe may retry
     * over http when this is set (and only then — never for a certificate
     * error, which is a real https server with a problem).
     */
    speaksHttp: boolean;
}

export interface ClassifyContext {
    url: string;
    timeoutMs: number;
    platform: Platform;
}

export function classifyNetworkError(error: unknown, context: ClassifyContext): ClassifiedError {
    const host = hostOf(context.url);
    const name = String((error as { name?: unknown })?.name ?? '');
    // The one regex this meets (net::ERR_…, below) is linear: a literal prefix and one character class.
    // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos
    const message = String((error as { message?: unknown })?.message ?? error ?? '');

    if (name === 'AbortError' || name === 'TimeoutError') {
        return fail('timeout', `No answer from ${host} within ${Math.round(context.timeoutMs / 1000)} seconds.`);
    }

    const chromium = /net::(ERR_[A-Z0-9_]+)/.exec(message)?.[1];
    if (chromium) return fromChromium(chromium, host, context);

    const cause = (error as { cause?: { code?: unknown; message?: unknown } })?.cause;
    const causeCode = String(cause?.code ?? (error as { code?: unknown })?.code ?? '').toUpperCase();
    const causeMessage = String(cause?.message ?? '');
    return fromNode(causeCode, `${causeMessage} ${message}`.toUpperCase(), host, context) ?? fail('unknown', causeMessage || message || 'The connection failed for an unknown reason.');
}

function fromChromium(code: string, host: string, context: ClassifyContext): ClassifiedError {
    switch (code) {
        case 'ERR_NAME_NOT_RESOLVED':
        case 'ERR_NAME_RESOLUTION_FAILED':
            return fail('dns', `${host} could not be found. Check the address for a typo, or whether you need a VPN.`);
        case 'ERR_CONNECTION_REFUSED':
            return fail('refused', `${host} refused the connection. The address is right but nothing is listening on that port.`);
        case 'ERR_CONNECTION_RESET':
            return fail('refused', `${host} closed the connection before answering.`);
        case 'ERR_CONNECTION_CLOSED':
        case 'ERR_EMPTY_RESPONSE':
            return { ...fail('refused', `${host} closed the connection before answering.`), speaksHttp: true };
        case 'ERR_CONNECTION_TIMED_OUT':
        case 'ERR_TIMED_OUT':
            return fail('timeout', `No answer from ${host} within ${Math.round(context.timeoutMs / 1000)} seconds.`);
        case 'ERR_ADDRESS_UNREACHABLE':
            return fail('offline', context.platform === 'darwin'
                ? `This Mac cannot reach ${host}. If the server is on your local network, allow Bee Flow under System Settings → Privacy & Security → Local Network, then try again.`
                : `This computer has no route to ${host} right now.`);
        case 'ERR_INTERNET_DISCONNECTED':
        case 'ERR_NETWORK_CHANGED':
        case 'ERR_NETWORK_IO_SUSPENDED':
        case 'ERR_ADDRESS_INVALID':
            return fail('offline', 'This computer is not connected to a network right now.');
        case 'ERR_SSL_PROTOCOL_ERROR':
            return { ...fail('tls', `${host} did not answer as a secure (https) server.`), speaksHttp: true };
        case 'ERR_CERT_AUTHORITY_INVALID':
            return fail('tls', untrustedMessage(host, context.platform));
        case 'ERR_CERT_DATE_INVALID':
            return fail('tls', `The certificate for ${host} has expired, or is not valid yet. If it is not expired, check this computer's clock.`);
        case 'ERR_CERT_COMMON_NAME_INVALID':
            return fail('tls', `The certificate for ${host} is for a different host name.`);
        case 'ERR_CERT_REVOKED':
            return fail('tls', `The certificate for ${host} has been revoked by whoever issued it.`);
        case 'ERR_SSL_VERSION_OR_CIPHER_MISMATCH':
        case 'ERR_SSL_OBSOLETE_VERSION_OR_CIPHER':
            return fail('tls', `${host} only offers an old, insecure TLS version. It needs TLS 1.2 or newer.`);
        case 'ERR_BAD_SSL_CLIENT_AUTH_CERT':
        case 'ERR_SSL_CLIENT_AUTH_CERT_NEEDED':
            return fail('tls', `${host} asks for a client certificate. Bee Flow cannot present one; ask your administrator for an address without mutual TLS.`);
        case 'ERR_TOO_MANY_REDIRECTS':
            return fail('http-error', `${host} keeps redirecting in a loop. Its proxy configuration needs a look.`);
        case 'ERR_UNSAFE_PORT':
            return fail('invalid-url', `Port ${portOf(context.url)} is one browsers refuse to use. Put the server on a different port.`);
        default:
            if (code.startsWith('ERR_PROXY') || code === 'ERR_TUNNEL_CONNECTION_FAILED' || code === 'ERR_MANDATORY_PROXY_CONFIGURATION_FAILED') {
                return fail('proxy', `The proxy this computer is set to use could not reach ${host} (${code}). Check the proxy settings, or ask whoever manages them.`);
            }
            if (code.startsWith('ERR_CERT_')) return fail('tls', `The certificate for ${host} is not valid (${code}).`);
            if (code.startsWith('ERR_SSL_')) return fail('tls', `The secure connection to ${host} could not be established (${code}).`);
            return fail('unknown', `The connection to ${host} failed (${code}).`);
    }
}

/** undici's cause codes. Returns null when nothing matched. */
function fromNode(code: string, haystack: string, host: string, context: ClassifyContext): ClassifiedError | null {
    const has = (needle: string) => code === needle || haystack.includes(needle);

    if (has('ETIMEDOUT') || has('UND_ERR_CONNECT_TIMEOUT') || has('UND_ERR_HEADERS_TIMEOUT')) {
        return fail('timeout', `No answer from ${host} within ${Math.round(context.timeoutMs / 1000)} seconds.`);
    }
    if (has('ENOTFOUND') || has('EAI_AGAIN') || has('GETADDRINFO')) {
        return fail('dns', `${host} could not be found. Check the address for a typo, or whether you need a VPN.`);
    }
    if (has('ECONNREFUSED')) {
        return fail('refused', `${host} refused the connection. The address is right but nothing is listening on that port.`);
    }
    if (has('ERR_SSL_WRONG_VERSION_NUMBER') || has('ERR_SSL_PACKET_LENGTH_TOO_LONG') || has('WRONG VERSION NUMBER') || has('PACKET LENGTH TOO LONG') || has('ERR_SSL_HTTP_REQUEST')) {
        return { ...fail('tls', `${host} did not answer as a secure (https) server.`), speaksHttp: true };
    }
    if (has('ECONNRESET') || has('EPIPE') || has('UND_ERR_SOCKET')) {
        return fail('refused', `${host} closed the connection before answering.`);
    }
    if (has('ENETUNREACH') || has('ENETDOWN') || has('EHOSTUNREACH')) {
        return fail('offline', `This computer has no route to ${host} right now.`);
    }
    if (has('CERT_HAS_EXPIRED') || has('CERT_NOT_YET_VALID')) {
        return fail('tls', `The certificate for ${host} has expired, or is not valid yet. If it is not expired, check this computer's clock.`);
    }
    if (has('ERR_TLS_CERT_ALTNAME_INVALID') || has('ALTNAME')) {
        return fail('tls', `The certificate for ${host} is for a different host name.`);
    }
    if (has('UNABLE_TO_VERIFY_LEAF_SIGNATURE')) {
        return fail('tls', `${host} sends its certificate without the intermediate certificates. The server should serve the full chain (fullchain.pem, not cert.pem).`);
    }
    if (has('DEPTH_ZERO_SELF_SIGNED_CERT') || has('SELF_SIGNED_CERT_IN_CHAIN') || has('UNABLE_TO_GET_ISSUER_CERT')) {
        return fail('tls', untrustedMessage(host, context.platform));
    }
    if (haystack.includes('CERT') || haystack.includes('SSL') || haystack.includes('TLS')) {
        return fail('tls', `The secure connection to ${host} could not be established.`);
    }
    return null;
}

/** How to trust a private certificate authority, per platform. */
function untrustedMessage(host: string, platform: Platform): string {
    const lead = `The certificate for ${host} is not signed by an authority this computer trusts. If your organisation issued it, add that authority's certificate to this computer — the app will not skip the check.`;
    switch (platform) {
        case 'linux':
            return `${lead} On Linux, Bee Flow reads the same store as Chrome: certutil -d sql:$HOME/.pki/nssdb -A -t "C,," -n "My CA" -i ca.crt (package libnss3-tools or nss-tools).`;
        case 'darwin':
            return `${lead} On a Mac: open it in Keychain Access, add it to the System keychain, and set it to Always Trust.`;
        case 'win32':
            return `${lead} On Windows: import it into "Trusted Root Certification Authorities" (certmgr.msc).`;
        default:
            return lead;
    }
}

function fail(code: ServerProbeFailure, message: string): ClassifiedError {
    return { code, message, speaksHttp: false };
}

export function hostOf(url: string): string {
    try {
        return new URL(url).host;
    } catch {
        return url;
    }
}

function portOf(url: string): string {
    try {
        const parsed = new URL(url);
        return parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
    } catch {
        return '?';
    }
}
