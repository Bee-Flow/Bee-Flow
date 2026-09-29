// @typecheck
/**
 * Which relying party a WebAuthn ceremony is for: the origin the browser is on
 * and the RP ID the key is bound to.
 *
 * A security key signs over both. The browser writes the page's origin into
 * clientDataJSON and the authenticator hashes the RP ID into authenticatorData,
 * so a phishing page on another host cannot get a signature this server
 * accepts, provided the server checks both against values the CALLER cannot
 * choose. The origin arrives in a request header, which a relay can set to
 * anything, so it only counts when it is in the deployment's own allow-list.
 * That list is CORS_ORIGIN, the same one the global origin gate in index.js
 * (ALLOWED_ORIGINS) refuses browser traffic against; every deployment already
 * sets it, or its front end would not load.
 *
 * The RP ID is the origin's host, with one widening: when the host sits under
 * the configured public host (WEBAUTHN_RP_ID, else CLIENT_PUBLIC_HOST), that
 * parent is used instead. So a key registered on www.example.com also answers
 * on example.com, which is how both hosts of one deployment keep working.
 */

// Mirrors the fallback of ALLOWED_ORIGINS in index.js. Only reached when
// CORS_ORIGIN is unset, which no compose file allows.
const DEFAULT_ALLOWED_ORIGINS = 'http://localhost:5173';

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

function normaliseOrigin(origin) {
    return String(origin || '').trim().replace(/\/+$/, '');
}

function allowedOrigins(env) {
    return String(env.CORS_ORIGIN || DEFAULT_ALLOWED_ORIGINS)
        .split(',')
        .map(normaliseOrigin)
        .filter(Boolean);
}

/** A host[:port] setting (CLIENT_PUBLIC_HOST carries a port in dev) → hostname. */
function hostnameOf(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    try {
        return new URL(raw.includes('://') ? raw : `http://${raw}`).hostname.toLowerCase();
    } catch (_) {
        return '';
    }
}

/**
 * WebAuthn only runs in a secure context, and an RP ID must be a domain name.
 * https anywhere; plain http only on localhost, which browsers treat as secure.
 * An IP address is refused on both counts: browsers reject it as an RP ID.
 */
function isWebAuthnCapable(url) {
    const host = url.hostname.toLowerCase();
    if (!host || IPV4.test(host) || host.startsWith('[')) return false;
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && (host === 'localhost' || host.endsWith('.localhost'));
}

/**
 * @param {string|undefined} originHeader  the request's Origin header
 * @param {Record<string, string|undefined>} [env]
 * @returns {{ rpID: string, origin: string } | null}  null when this request
 *   cannot run a ceremony: no origin, an origin outside the allow-list, or one
 *   WebAuthn refuses (plain http, an IP address).
 */
function resolveRelyingParty(originHeader, env = process.env) {
    const origin = normaliseOrigin(originHeader);
    if (!origin) return null;
    if (!allowedOrigins(env).includes(origin)) return null;

    let url;
    try { url = new URL(origin); } catch (_) { return null; }
    if (!isWebAuthnCapable(url)) return null;

    const host = url.hostname.toLowerCase();
    const parent = hostnameOf(env.WEBAUTHN_RP_ID) || hostnameOf(env.CLIENT_PUBLIC_HOST);
    const rpID = parent && (host === parent || host.endsWith(`.${parent}`)) ? parent : host;
    return { rpID, origin };
}

module.exports = { resolveRelyingParty };
