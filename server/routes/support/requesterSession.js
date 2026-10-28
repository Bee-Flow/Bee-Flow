// @typecheck
/**
 * What a requester's mailed link becomes once it has been used.
 *
 * The `?token=` in a support e-mail is a long-lived capability, and a URL is
 * the worst place for one: it lands in browser history, proxy and access logs
 * and (without a policy) the Referer header of every link on the page. So the
 * first request that presents it trades it for an httpOnly, SameSite=Strict
 * cookie that lives an hour and is scoped to that one thread's API path; the
 * rest of the session never needs the query again. Links already mailed keep
 * working: the query is still accepted, the cookie only means it is no longer
 * needed afterwards.
 */
'use strict';

const COOKIE_PREFIX = 'bf_support_';
const COOKIE_TTL_SECONDS = 60 * 60;
const THREAD_ID = /^[A-Za-z0-9_-]{1,64}$/;

function cookieName(threadId) {
    return THREAD_ID.test(String(threadId)) ? `${COOKIE_PREFIX}${threadId}` : null;
}

/** The thread's access token from the Cookie header, or null. */
function readCookieToken(req, threadId) {
    const name = cookieName(threadId);
    const header = req.headers && req.headers.cookie;
    if (!name || typeof header !== 'string') return null;
    for (const part of header.split(';')) {
        const eq = part.indexOf('=');
        if (eq > 0 && part.slice(0, eq).trim() === name) {
            const value = part.slice(eq + 1).trim();
            return /^[A-Za-z0-9]{1,128}$/.test(value) ? value : null;
        }
    }
    return null;
}

/**
 * Keep the token out of Referer, caches and shared proxies.
 * @param {{ setHeader: (arg0: string, arg1: string) => void; }} res
 */
function setNoLeakHeaders(res) {
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
}

function setRequesterCookie(req, res, threadId, token) {
    const name = cookieName(threadId);
    if (!name) return;
    const secure = req.secure || process.env.NODE_ENV === 'production';
    res.append('Set-Cookie', [
        `${name}=${token}`,
        `Path=/api/support/threads/${threadId}`,
        `Max-Age=${COOKIE_TTL_SECONDS}`,
        'HttpOnly',
        'SameSite=Strict',
        ...(secure ? ['Secure'] : []),
    ].join('; '));
}

module.exports = { cookieName, readCookieToken, setRequesterCookie, setNoLeakHeaders, COOKIE_TTL_SECONDS };
