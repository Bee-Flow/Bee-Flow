// Microsoft 365 OAuth connect-popup flow: the counterpart of
// lib/googleOAuthPopup.js for Settings → Integrations → Microsoft 365.
//
// Contract with the server callback page (routes/integrations/microsoft365.js):
// it posts
//   { type: 'microsoft-callback', success: boolean }
// to window.opener and closes itself.

const POPUP_NAME = 'microsoft-oauth';
const POPUP_WIDTH = 600;
const POPUP_HEIGHT = 700;
const CLOSE_POLL_MS = 500;
// The callback page posts its message and then closes itself — after we see
// the popup close, give an in-flight message a moment to arrive before
// declaring the flow abandoned.
const CLOSE_GRACE_MS = 1000;

export interface MicrosoftOAuthResult {
    success: boolean;
    closed?: boolean;
}

export type MicrosoftOAuthErrorCode = 'auth_url_failed' | 'popup_blocked';

export interface MicrosoftOAuthError extends Error {
    code: MicrosoftOAuthErrorCode;
}

interface AuthFetchResponse {
    ok: boolean;
    json: () => Promise<unknown>;
}

export interface OpenMicrosoftOAuthPopupOptions {
    authFetch: (url: string, init?: RequestInit) => Promise<AuthFetchResponse>;
    apiBase: string;
    onDone?: (result: MicrosoftOAuthResult) => void;
    onOpened?: () => void;
}

function oauthError(message: string, code: MicrosoftOAuthErrorCode): MicrosoftOAuthError {
    const err = new Error(message) as MicrosoftOAuthError;
    err.code = code;
    return err;
}

/**
 * Open the Microsoft consent popup and wait for it to finish.
 *
 * Resolves with `{ success, closed? }` once the popup posts its
 * 'microsoft-callback' message, or with `{ success: false, closed: true }`
 * when the user closes the popup without completing; `onDone` is called with
 * the same result first. Rejects before the popup opens when the auth-url
 * request fails (`code = 'auth_url_failed'`, message = the server's error when
 * it gave one) or the browser blocks the popup (`code = 'popup_blocked'`).
 */
export async function openMicrosoftOAuthPopup({
    authFetch,
    apiBase,
    onDone,
    onOpened,
}: OpenMicrosoftOAuthPopupOptions): Promise<MicrosoftOAuthResult> {
    let ok = false;
    let data: { url?: string; error?: string } = {};
    try {
        const res = await authFetch(`${apiBase}/api/integrations/microsoft/auth-url`);
        data = ((await res.json().catch(() => ({}))) || {}) as typeof data;
        ok = res.ok;
    } catch { /* rejected below as auth_url_failed */ }
    if (!ok || !data.url) {
        // Empty message when the server gave none: callers fall back to their
        // own translated generic error.
        throw oauthError(data.error || '', 'auth_url_failed');
    }

    const [w, h] = [POPUP_WIDTH, POPUP_HEIGHT];
    const popup = window.open(
        data.url,
        POPUP_NAME,
        `width=${w},height=${h},left=${(screen.width - w) / 2},top=${(screen.height - h) / 2}`,
    );
    if (!popup) {
        throw oauthError('popup_blocked', 'popup_blocked');
    }
    onOpened?.();

    return new Promise((resolve) => {
        let settled = false;
        let closePoll: ReturnType<typeof setInterval> | null = null;
        // Only trust the callback page. Without an origin check any window
        // could post a forged { type: 'microsoft-callback', success: true }.
        // The callback page is served from the API origin, which in dev
        // differs from the SPA's.
        const apiOrigin = (() => {
            try { return new URL(apiBase || '', window.location.origin).origin; } catch { return window.location.origin; }
        })();
        const handler = (e: MessageEvent) => {
            if (e.origin !== apiOrigin && e.origin !== window.location.origin) return;
            if (e.data?.type === 'microsoft-callback') finish({ success: !!e.data.success });
        };
        const finish = (result: MicrosoftOAuthResult) => {
            if (settled) return;
            settled = true;
            window.removeEventListener('message', handler);
            if (closePoll) clearInterval(closePoll);
            onDone?.(result);
            resolve(result);
        };
        window.addEventListener('message', handler);
        closePoll = setInterval(() => {
            if (popup.closed) {
                if (closePoll) clearInterval(closePoll);
                setTimeout(() => finish({ success: false, closed: true }), CLOSE_GRACE_MS);
            }
        }, CLOSE_POLL_MS);
    });
}
