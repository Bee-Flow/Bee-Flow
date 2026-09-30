/**
 * Single sign-on, in a native app that has no browser to be redirected in.
 *
 * The routes, from server/auth/oauthRoutes.js and the modules it mounts:
 *
 *   GET /auth/login/:provider     auth/oauth/providerLoginRoutes.js — mints the
 *                                 CSRF state and the PKCE pair, redirects to
 *                                 Google / Microsoft / Nextcloud.
 *   GET /auth/callback/:provider  auth/oauth/providerCallbackRoutes.js — the
 *                                 provider comes back here, NOT to the app.
 *   GET /auth/login-pickup?id=    auth/oauth/loginPickupRoutes.js — a one-shot
 *                                 claim for the session token deposited by the
 *                                 callback.
 *
 * Why the pickup route rather than a plain redirect: the OAuth round trip has
 * to happen in a real browser (a WebView is not an acceptable place to type a
 * Google password, and Google refuses it outright), and Android's Custom Tab
 * has its own cookie jar. The session cookie the callback sets therefore lands
 * in the browser, not in this app. The server already solves exactly this for
 * its embedded-iframe mode: with `?popup=1&pickup=<id>` the callback deposits
 * a session token under that id instead of redirecting to the web app — a
 * token this app claims over its own connection.
 *
 * ⚠️ Claiming the token is not signing in. It authenticates a request only when
 * sent as `X-Session-Token` (server/index.js line 316), and it has to be sent
 * on EVERY request — the bridge middleware deliberately does not persist the
 * session (auth/establishSession.js suppressSessionPersistence), so there is no
 * cookie to inherit. The caller MUST hand the result to `adoptSessionToken`
 * (src/core/auth/sessionToken.ts) before doing anything else.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE ANDROID CONSTRAINT, which is what this file's shape is really about.
 *
 * `WebBrowser.openAuthSessionAsync` has NO native implementation on Android —
 * `_authSessionIsNativelySupported()` in expo-web-browser is literally
 * `Platform.OS !== 'android'`. Android runs a JS polyfill that races two
 * things: a `Linking` listener for the redirect URI, and a promise that
 * resolves `{type:'dismiss'}` the moment AppState returns to `active`.
 *
 * And React Native STOPS DISPATCHING JS TIMERS while the host activity is
 * paused. The Custom Tab is on top for the whole OAuth round trip, so a poll
 * built on `setTimeout` is frozen for its entire duration: it fires once at
 * t≈0 — seconds before the server has deposited anything — and then not again
 * until the app is back in the foreground.
 *
 * That is why this does not poll on a timer and does not race the browser:
 *
 *   1. The browser result NEVER settles the flow. It used to: any non-success
 *      result threw, and `Promise.race` settles on a rejection, so the instant
 *      the user obeyed the server's own "you can close this window" page the
 *      flow was cancelled and a perfectly good token was abandoned. (`success`
 *      was no better — it resolved `null`, which the next line also turned
 *      into a cancellation.) Now it only wakes the loop.
 *   2. The loop is driven by our own AppState listener. Coming back to the
 *      foreground IS the signal that the round trip finished, so every
 *      transition to `active` polls immediately. This works WITH the timer
 *      freeze instead of against it — the loop is naturally parked while the
 *      tab is up and wakes exactly when control returns.
 *
 * Note the polyfill's own AppState hook cannot be relied on for this: it arms
 * a single module-global resolver for the FIRST `active` event, so a mid-flow
 * foreground (Google bouncing out to the Google app and back, a notification,
 * the recents switcher) consumes it and the real return is never seen.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * CLOSING THE TAB. Nothing in JavaScript can close a Custom Tab.
 * `WebBrowser.dismissBrowser()` compiles and does nothing — the Android module
 * (WebBrowserModule.kt) defines only warmUp/coolDown/mayInitWithUrl/
 * getCustomTabsSupportingBrowsers/openBrowserAsync, so the optional call
 * resolves to undefined; `dismissAuthSession()` throws outright. The ONLY
 * mechanism is native: expo-web-browser's WebBrowserPackage installs a
 * lifecycle listener whose `onNewIntent` calls `finishAndRemoveTask()` on its
 * proxy activity when MainActivity receives an ACTION_VIEW intent.
 *
 * So the tab can only be closed by the SERVER redirecting to `beeflow://oauth`.
 * `&app=beeflow` below asks it to. An older server does not know the parameter,
 * ignores it, and renders its close page as before — which is why this client
 * still works against a server that has not been deployed yet, and starts
 * closing the tab by itself the day one has, with no new APK.
 */

import * as AuthSession from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';
import { AppState } from 'react-native';

import { api, ApiError } from '@/core/api/client';
import { getServerUrl } from '@/core/api/server';
import { readCurrentUser } from '@/core/auth/readers';
import type { CurrentUserResponse } from '@/core/auth/types';
import { toHex } from '@/core/crypto/keys';
import { randomBytes } from '@/core/crypto/random';
import { translate } from '@/core/i18n';

import { readPickup } from './readers';

/** The three providers /auth/login/:provider actually implements. */
export const SSO_PROVIDERS = ['google', 'microsoft', 'nextcloud'] as const;
export type SsoProvider = (typeof SSO_PROVIDERS)[number];

/** What the button says. The provider ids themselves are the server's. */
export const SSO_LABELS: Record<SsoProvider, string> = {
    google: 'Google',
    microsoft: 'Microsoft',
    nextcloud: 'Nextcloud',
};

/**
 * The key this client sends as `?app=`. The server maps it to a hardcoded
 * `beeflow://oauth` — a KEY, never a URL, so there is no redirect target for
 * anyone to influence and no URI parser to fool.
 */
const NATIVE_APP_KEY = 'beeflow';

/**
 * How long to keep claiming after the app comes back to the foreground.
 *
 * The server deposits the token BEFORE it renders its close page, so in the
 * normal case the very first claim after the return succeeds and none of this
 * budget is spent. It exists for the case where the callback is still finishing
 * (SSO provisioning, group sync and encryption setup all run before the
 * deposit) as the user closes the tab. Comfortably inside the pickup's
 * server-side TTL.
 */
const GRACE_AFTER_RETURN_MS = 12_000;

/** Claim briskly for the first moments back, then settle down. */
const FAST_WINDOW_MS = 3_000;
const FAST_CADENCE_MS = 400;
const SLOW_CADENCE_MS = 1_500;

/**
 * Backstop for the case where the browser never settles AND the app never
 * reports a foreground — neither of which should happen. Not a real deadline:
 * the loop is parked, not spinning, so this costs nothing until it fires.
 */
const HARD_DEADLINE_MS = 5 * 60_000;

/**
 * Above this, assume the person actually went through the provider.
 *
 * There is no way to distinguish "backed out at Google's consent screen" from
 * "signed in and the handoff failed" — both arrive as a dismissed tab. Time
 * spent in the browser is the only signal available, and typing an email, a
 * password and a second factor does not happen in fifteen seconds. Under it,
 * say nothing; over it, say something, because silence after a completed
 * sign-in is the failure the user cannot act on. Becomes dead weight once a
 * deployed server sends the deep link, which settles it exactly.
 */
const LIKELY_COMPLETED_MS = 15_000;

export function isSsoProvider(value: string): value is SsoProvider {
    return (SSO_PROVIDERS as readonly string[]).includes(value);
}

/** The pickup id is short-lived and single-use; 16 bytes is plenty. */
function newPickupId(): string {
    return toHex(randomBytes(16));
}

/** Why the flow ended without a session. */
export type SsoFailureReason =
    /** Backed out before completing. Nothing to report — they know. */
    | 'user-cancelled'
    /** They finished, and no token ever appeared. This must be surfaced. */
    | 'no-token';

export class SsoCancelledError extends Error {
    readonly reason: SsoFailureReason;
    constructor(reason: SsoFailureReason = 'user-cancelled') {
        super(
            reason === 'no-token'
                ? 'Sign-in did not complete.'
                : 'Sign-in was cancelled.',
        );
        this.name = 'SsoCancelledError';
        this.reason = reason;
    }
}

export interface SsoResult {
    /** The bridge token from /auth/login-pickup. */
    sessionToken: string;
    /** Who the server says just signed in, read back through the bridge. */
    user: CurrentUserResponse['user'] | null;
}

/**
 * A sleep that the app returning to the foreground cuts short.
 *
 * The listener writes `lastReturnAt` SYNCHRONOUSLY, before waking the sleeper,
 * because the loop reads it to decide whether to give up. AppState's native
 * resume event reaches JS ahead of any overdue timer (which waits for the next
 * choreographer frame), so the ordering holds even when the app has been
 * backgrounded long enough for the timer to be due the moment it thaws.
 */
class ForegroundLoop {
    /** When the app was last brought back — the clock the loop gives up on. */
    lastReturnAt = 0;
    /** False until the app has come back at least once. */
    returned = false;

    private wakeSleeper: (() => void) | null = null;
    private readonly subscription = AppState.addEventListener('change', (state) => {
        if (state === 'active') this.markReturn();
    });

    /** Also called when the browser settles, which is a return by any measure. */
    markReturn(): void {
        this.lastReturnAt = Date.now();
        this.returned = true;
        this.wake();
    }

    private wake(): void {
        const resolve = this.wakeSleeper;
        this.wakeSleeper = null;
        resolve?.();
    }

    async sleep(ms: number): Promise<void> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
            new Promise<void>((resolve) => {
                timer = setTimeout(resolve, ms);
            }),
            new Promise<void>((resolve) => {
                this.wakeSleeper = resolve;
            }),
        ]);
        if (timer) clearTimeout(timer);
    }

    dispose(): void {
        this.subscription.remove();
        this.wake();
    }
}

/**
 * Run the whole flow: open the provider in a Custom Tab, claim the token when
 * the app comes back, and read back who signed in.
 *
 * `signal` lets the screen abandon the wait when the user navigates away.
 */
export async function startSsoLogin(
    provider: SsoProvider,
    signal?: AbortSignal,
): Promise<SsoResult> {
    const base = getServerUrl();
    if (!base) throw new Error(translate('mobile.onboarding.sso_no_server', 'No Bee Flow server is configured.'));

    const pickupId = newPickupId();
    const authUrl =
        `${base}/auth/login/${encodeURIComponent(provider)}` +
        `?popup=1&pickup=${encodeURIComponent(pickupId)}` +
        `&app=${NATIVE_APP_KEY}`;

    // What the server redirects to once it knows about `app=beeflow`, and what
    // the polyfill's Linking listener matches on. Harmless against a server
    // that never sends it.
    const redirectUri = AuthSession.makeRedirectUri({ scheme: 'beeflow', path: 'oauth' });

    const openedAt = Date.now();
    const loop = new ForegroundLoop();
    const stop = new AbortController();
    const forward = () => stop.abort();
    signal?.addEventListener('abort', forward);

    /**
     * `success` means the deep link fired, so the callback definitely ran and a
     * missing token is definitely a failure — not somebody changing their mind.
     */
    let browserSaidSuccess = false;

    // Never awaited into the result. The browser's only job here is to say
    // "control is back"; what happened is decided by whether a token appears.
    void WebBrowser.openAuthSessionAsync(authUrl, redirectUri)
        .then((result) => {
            if (result.type === 'success') browserSaidSuccess = true;
        })
        // A device with no browser at all rejects here, and rejects
        // immediately — without this the loop would wait for a foreground that
        // is never coming.
        .catch(() => undefined)
        .then(() => loop.markReturn());

    try {
        const token = await claimPickup(pickupId, loop, stop.signal);
        if (!token) {
            const completed = browserSaidSuccess || Date.now() - openedAt >= LIKELY_COMPLETED_MS;
            throw new SsoCancelledError(completed ? 'no-token' : 'user-cancelled');
        }
        return { sessionToken: token, user: await fetchUserThroughBridge(token) };
    } finally {
        stop.abort();
        loop.dispose();
        signal?.removeEventListener('abort', forward);
    }
}

/**
 * Claim the deposited token, waking on every return to the foreground.
 *
 * `/auth/login-pickup` answers 404 with `{pending:true}` until the callback has
 * run, so a 404 is "not yet", not a failure.
 *
 * Deliberately does NOT abort a claim already in flight when `signal` fires:
 * the server DELETES the pickup as it handles the request (claimPickup in
 * utils/sessionToken.js), so abandoning the response would burn a token that
 * can never be minted again. The signal only stops NEW attempts.
 */
async function claimPickup(
    pickupId: string,
    loop: ForegroundLoop,
    signal: AbortSignal,
): Promise<string | null> {
    const startedAt = Date.now();
    let consecutiveErrors = 0;

    for (;;) {
        if (signal.aborted) return null;

        try {
            const res = readPickup(
                await api.get<unknown>('/auth/login-pickup', {
                    query: { id: pickupId },
                    retry: false,
                    timeoutMs: 8000,
                }),
            );
            if (res?.sessionToken) return res.sessionToken;
            consecutiveErrors = 0;
        } catch (err) {
            if (err instanceof ApiError && err.status === 404) {
                consecutiveErrors = 0;
            } else if ((consecutiveErrors += 1) >= 2) {
                // One blip is not a failed sign-in — and the request timer is
                // itself a setTimeout, so a request left in flight across the
                // tab session can surface as a spurious abort on resume. Two in
                // a row is a real problem worth showing.
                throw err;
            }
        }

        // Checked AFTER the attempt, so every return to the foreground gets at
        // least one claim before the flow can give up.
        const sinceReturn = Date.now() - loop.lastReturnAt;
        if (loop.returned && sinceReturn >= GRACE_AFTER_RETURN_MS) return null;
        if (Date.now() - startedAt >= HARD_DEADLINE_MS) return null;

        await loop.sleep(
            loop.returned && sinceReturn < FAST_WINDOW_MS ? FAST_CADENCE_MS : SLOW_CADENCE_MS,
        );
    }
}

/**
 * Read /auth/user with the bridge token, so the caller can name the account
 * that just signed in even though the app's own cookie jar is still empty.
 *
 * Never fatal. The token is already claimed and the pickup already spent — one
 * flaky request here must not throw away an hour-long session for the sake of
 * a display name.
 */
async function fetchUserThroughBridge(token: string): Promise<CurrentUserResponse['user'] | null> {
    try {
        const res = readCurrentUser(
            await api.get<unknown>('/auth/user', { headers: { 'X-Session-Token': token }, retry: false }),
        );
        return res.authenticated ? (res.user ?? null) : null;
    } catch {
        return null;
    }
}

/**
 * Which providers to offer.
 *
 * `oauthProviders` on the signed-out stage comes from `config.oauth.providers`
 * (auth/login/currentUserRoutes.js), which is the legacy Nextcloud config and
 * is empty on most instances. GET /auth/setup-status is the authoritative
 * answer for Google and Microsoft, so the two are merged rather than trusting
 * either alone — an instance with Google configured but no `oauthProviders`
 * entry must still show the Google button.
 */
export function resolveProviders(
    stageProviders: readonly string[],
    status: { isGoogleConfigured?: boolean; isMicrosoftConfigured?: boolean; isOAuthConfigured?: boolean } | null,
): SsoProvider[] {
    const found = new Set<SsoProvider>();
    for (const name of stageProviders) {
        if (isSsoProvider(name)) found.add(name);
    }
    if (status?.isGoogleConfigured) found.add('google');
    if (status?.isMicrosoftConfigured) found.add('microsoft');
    if (status?.isOAuthConfigured) found.add('nextcloud');
    return SSO_PROVIDERS.filter((p) => found.has(p));
}
