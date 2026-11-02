// @typecheck strict
/**
 * How many reverse-proxy hops sit in front of the server (`TRUST_PROXY_HOPS`).
 *
 * Express peels that many addresses off X-Forwarded-For to find the client,
 * and the rate limiters and the login throttle key on the result. The number
 * must therefore be exactly right: too high and a visitor chooses their own
 * address with a forged header; too low and every visitor shares the proxy's.
 *
 * `0` is a real setting (no proxy at all: the socket's address is the client),
 * so a falsy parse result is not a reason to fall back to the default. A value
 * that is not a whole number is refused at boot rather than silently replaced:
 * a typo here is a misconfigured perimeter.
 */

const DEFAULT_HOPS = 1;

/**
 * @param {string | undefined} raw the environment value as given
 * @returns {number} the hop count to hand to `app.set('trust proxy', …)`
 */
function parseTrustProxyHops(raw) {
    if (raw === undefined || raw.trim() === '') return DEFAULT_HOPS;
    const value = raw.trim();
    if (!/^\d+$/.test(value)) {
        throw new Error(`TRUST_PROXY_HOPS must be a whole number of proxy hops (0 or more); got ${JSON.stringify(raw)}.`);
    }
    return Number(value);
}

module.exports = { parseTrustProxyHops, DEFAULT_HOPS };
