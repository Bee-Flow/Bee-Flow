/**
 * The SSO bridge token's life on the device.
 *
 * Password and OPAQUE sign-ins authenticate with a cookie, and expo/fetch keeps
 * that cookie in Android's own store, so they need nothing from this file.
 * Single sign-on cannot: the OAuth round trip has to happen in a real browser
 * (RFC 8252, and Google refuses a WebView outright), Android's Custom Tab keeps
 * its own cookie jar, and the session cookie the callback sets therefore lands
 * in the browser rather than in this app.
 *
 * The server's answer to exactly that problem is the bridge — `?popup=1&pickup=`
 * makes the OAuth callback deposit a token, /auth/login-pickup hands it over,
 * and the middleware at server/index.js:316 rebuilds `req.session` from an
 * `X-Session-Token` header. Two properties of that bridge shape everything here:
 *
 *   1. It is header-only. `suppressSessionPersistence` (auth/establishSession.js)
 *      deliberately stops the bridged request writing a session row, so there is
 *      no cookie to inherit and the token has to ride on EVERY request, for as
 *      long as the user stays signed in. Hence a persisted token, not a variable
 *      that dies with the process.
 *   2. It expires, and the server says when. The bridge's default is an hour —
 *      right for the popup-to-iframe handoff it was built for, and hopeless for
 *      an app that gets closed: an SSO user who shut the app after lunch came
 *      back signed out, while the same account in a browser kept a 30-day
 *      cookie. GET /api/session-token now grants a native client that same
 *      thirty days and answers with `expiresIn`, so the TTL is read rather than
 *      assumed. It also accepts a bridged session itself — the middleware runs
 *      before the route's own auth check — so the session rolls forward without
 *      another trip to Google.
 *
 * What this still cannot do is renew a token that has already expired. That
 * boundary is real, it is just thirty days out instead of one hour, which is
 * the difference between a limit and a daily annoyance.
 */

import * as SecureStore from 'expo-secure-store';

import { ApiError, api, setSessionToken } from '../api/client';
import { getServerUrl } from '../api/server';

/** Namespaced like the vault's keys, so a future second account cannot collide. */
const STORE_KEY = 'beeflow.auth.sessionToken';

/**
 * What a token is worth when the server did not say.
 *
 * The bridge's own default is an hour (utils/sessionToken.js), and that is
 * what the OAuth callback deposits for the pickup. A server old enough not to
 * answer with `expiresIn` is a server still on that hour, so assuming it is
 * both correct and the safe direction — the app gives up a token it might
 * still have had rather than presenting one the server forgot.
 */
export const BRIDGE_TTL_MS = 60 * 60_000;

/**
 * The longest lifetime this client will believe.
 *
 * Mirrors NATIVE_SESSION_TOKEN_TTL_SECONDS on the server. The server is the
 * authority on how long a token lives, but "authority" is not "unbounded" —
 * a finite but absurd `expiresIn` would give the app a token it never renews
 * and never expires, which is the one state with no way out.
 */
export const MAX_TTL_MS = 30 * 24 * 60 * 60_000;

/**
 * How often to CHECK whether the token wants renewing — not how old it may get.
 *
 * Staleness is a quarter of the token's own life (`staleAfter`), because the
 * life is no longer one number: a native client asks for the cookie's thirty
 * days and an embedded iframe still gets an hour. Checking on this interval and
 * renewing only when actually stale keeps the old hourly behaviour exactly as
 * it was while costing a 30-day token nothing but a comparison.
 */
export const REFRESH_AFTER_MS = 15 * 60_000;

interface StoredToken {
    token: string;
    /** Which server minted it. A token is meaningless anywhere else. */
    server: string;
    /** Epoch ms. Compared against the TTL below, never guessed at. */
    mintedAt: number;
    /** What the server said this token is good for, in ms. */
    ttlMs: number;
}

/**
 * Renew once a quarter of the token's life has gone, which leaves three
 * chances before it dies — so a single failed refresh (a tunnel, a flaky
 * minute of signal, a server mid-deploy) costs nothing.
 */
export function staleAfter(minted: StoredToken): number {
    return minted.ttlMs / 4;
}

/** In-memory mirror of the stored entry, so staleness is a synchronous check. */
let entry: StoredToken | null = null;

/**
 * Read back what was stored. Exported for the test, and defensive because
 * SecureStore returns whatever was last written — including something written
 * by an older version of this app that used a different shape.
 */
export function parseStored(raw: string | null): StoredToken | null {
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as Partial<StoredToken>;
        if (typeof parsed?.token !== 'string' || !parsed.token) return null;
        if (typeof parsed.server !== 'string' || !parsed.server) return null;
        const mintedAt = Number(parsed.mintedAt);
        const ttlMs = Number(parsed.ttlMs);
        return {
            token: parsed.token,
            server: parsed.server,
            // A missing or nonsense timestamp is treated as "minted at the dawn
            // of time", which makes it stale and forces a refresh — the safe
            // direction, since the alternative is trusting an unknown age.
            mintedAt: Number.isFinite(mintedAt) ? mintedAt : 0,
            // Written by an older build, or by a server that does not answer
            // with `expiresIn`: assume the hour the bridge has always had.
            ttlMs: Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : BRIDGE_TTL_MS,
        };
    } catch {
        return null;
    }
}

export function isStale(minted: StoredToken, now = Date.now()): boolean {
    return now - minted.mintedAt >= staleAfter(minted);
}

/** True once the server would have dropped it, so a refresh cannot succeed. */
export function isExpired(minted: StoredToken, now = Date.now()): boolean {
    return now - minted.mintedAt >= minted.ttlMs;
}

async function store(next: StoredToken | null): Promise<void> {
    entry = next;
    setSessionToken(next?.token ?? null);
    try {
        if (next) await SecureStore.setItemAsync(STORE_KEY, JSON.stringify(next));
        else await SecureStore.deleteItemAsync(STORE_KEY);
    } catch {
        // Keystore unavailable (a device mid-migration, a user who just changed
        // their screen lock). The in-memory half above still works for this
        // launch, which is far better than failing the sign-in outright.
    }
}

/**
 * Take ownership of a token the SSO flow just claimed. This is the call whose
 * absence made single sign-on look like it worked and then do nothing: the
 * pickup returned a token, and without this it was dropped on the floor.
 */
export async function adoptSessionToken(token: string): Promise<void> {
    const server = getServerUrl();
    if (!server) return;
    await store({ token, server, mintedAt: Date.now(), ttlMs: BRIDGE_TTL_MS });
    // Trade the pickup token in immediately. What the OAuth callback deposits
    // is the bridge's generic hour — the TTL for a popup handing a session to
    // an iframe that is open on screen right now. This app is not that: it
    // gets closed, and it has no cookie to fall back on. One extra request at
    // sign-in swaps the hour for whatever the server grants a native client,
    // so the very first cold start tomorrow already has a token worth having.
    // A failure here is harmless — the hour-long token stays, and the ordinary
    // staleness path will try again.
    await refreshSessionToken();
}

export async function clearSessionToken(): Promise<void> {
    await store(null);
}

/** What is installed right now, for tests and for the settings screen. */
export function currentSessionToken(): StoredToken | null {
    return entry;
}

/**
 * Mint a replacement and install it.
 *
 * Returns false when the server would not mint one — which means the bridged
 * session is gone, so the stored token is cleared rather than left to fail
 * every subsequent request with a 401 the user cannot interpret.
 */
export async function refreshSessionToken(): Promise<boolean> {
    if (!entry) return false;
    const server = entry.server;
    try {
        const res = await api.get<{ token?: string; expiresIn?: number }>('/api/session-token', {
            // No retry, deliberately. This runs once at SSO sign-in and then on
            // a timer, and it is fail-open — so a retry buys nothing a later
            // attempt does not, while costing the user a spinner of up to half
            // a minute at the one moment they are watching one.
            retry: false,
            timeoutMs: 10_000,
        });
        if (!res?.token) {
            // A 200 with no token is the server declining to mint one, which
            // it only does for a session it no longer recognises.
            await clearSessionToken();
            return false;
        }
        // The token may have been cleared while this request was in flight —
        // a sign-out, or a 401 on another request. Installing the replacement
        // now would sign the user back in behind their own back.
        if (!entry) return false;
        const ttlSeconds = Number(res.expiresIn);
        const granted =
            Number.isFinite(ttlSeconds) && ttlSeconds > 0 ? ttlSeconds * 1000 : BRIDGE_TTL_MS;
        await store({
            token: res.token,
            server,
            mintedAt: Date.now(),
            // Clamped, because a lifetime is only worth what the server will
            // actually honour. A finite but absurd `expiresIn` would otherwise
            // produce a token this app never renews and never expires.
            ttlMs: Math.min(granted, MAX_TTL_MS),
        });
        return true;
    } catch (err) {
        // ONLY an authentication answer ends a token early.
        //
        // This used to clear on any throw, which read as caution and behaved as
        // the opposite: a ten-second timeout on a train destroyed a token with
        // fifty minutes left on it, and the docstring's promise of "three
        // chances to renew" was never kept — the first failure was fatal. A
        // timeout, a 5xx, a captive portal and a server mid-deploy all say
        // nothing whatsoever about whether the session is still good.
        //
        // So the token now outlives a bad network and is ended by exactly two
        // things: the server saying no, and `isExpired` saying the clock ran
        // out. Both are answers; neither is a guess.
        //
        // 401 only, not 403. A 403 on this route is an entitlement answer — a
        // licence gate, a proxy, a WAF — not "this session is over", and
        // treating one as a sign-out would destroy a token that had just been
        // claimed and was working.
        const status = err instanceof ApiError ? err.status : undefined;
        if (status === 401) await clearSessionToken();
        return false;
    }
}

/**
 * Renew, but only if it is time. Called on a timer while the app is open.
 *
 * The check is local and free, so the timer can keep its old cadence without
 * a request behind it: an hour-long token still renews every fifteen minutes,
 * a thirty-day one sleeps until day seven and a half.
 */
export async function renewIfStale(): Promise<void> {
    if (!entry || !isStale(entry)) return;
    await refreshSessionToken();
}

/**
 * Restore the token for this launch and roll it forward if it is getting on.
 *
 * Called at the top of the auth resolve, BEFORE /auth/user, so the very first
 * request of a cold start already carries the header. `server` is passed in
 * rather than read here because the caller has just awaited it.
 */
export async function primeSessionToken(server: string | null): Promise<void> {
    if (entry === null) {
        let raw: string | null = null;
        try {
            raw = await SecureStore.getItemAsync(STORE_KEY);
        } catch {
            raw = null;
        }
        const restored = parseStored(raw);
        if (restored) {
            entry = restored;
            setSessionToken(restored.token);
        }
    }
    if (!entry) return;

    // A token minted by a different Bee Flow is not just useless, it is a
    // credential being offered to a server that never issued it. Drop it the
    // moment the user points the app somewhere else.
    if (!server || entry.server !== server) {
        await clearSessionToken();
        return;
    }
    if (isExpired(entry)) {
        await clearSessionToken();
        return;
    }
    if (isStale(entry)) await refreshSessionToken();
}
