import { useRef, useCallback, useEffect } from 'react';
import { API_BASE, setSessionToken } from '../../utils/helpers';
import { getAuthUser } from '../../api/loginRequests';
import type { OnLogin } from './loginShared';
import { logger } from '../../utils/logger';

// Detect if we're running inside an iframe (embedded in Nextcloud, etc.)
const isEmbedded = (() => {
    try { return window.self !== window.top; } catch { return true; }
})();

/**
 * The id the OAuth callback deposits the session token under (see
 * openOAuthPopup below), so it comes from the platform CSPRNG. randomUUID
 * exists only in a secure context; getRandomValues is there in every context.
 */
export function newPickupId(cryptoApi: Crypto = window.crypto): string {
    if (typeof cryptoApi.randomUUID === 'function') return cryptoApi.randomUUID();
    const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The login URL for one Microsoft button. `connectionId` names one of the
 * additional Microsoft tenants; absent (or 'default') is the primary app.
 */
export function microsoftLoginUrl(base: string, connectionId: string | undefined, embedded: boolean): string {
    const params = new URLSearchParams();
    if (embedded) params.set('popup', '1');
    if (connectionId && connectionId !== 'default') params.set('connection', connectionId);
    const query = params.size > 0 ? `?${params.toString()}` : '';
    return `${base}/auth/login/microsoft${query}`;
}

/**
 * The three SSO buttons. Outside an iframe they redirect; inside one they open
 * a popup and poll for the finished login. Hook order: useRef, useCallback,
 * useEffect (the unmount cleanup).
 */
export function useOAuthPopup(onLogin: OnLogin, serverUrl: string) {
    // OAuth redirects must go directly to the backend server URL (not through
    // the frontend nginx proxy) so the session cookie is properly set.
    const oauthBase = serverUrl || API_BASE;

    // Open OAuth in a popup when embedded in an iframe (Google/Microsoft block
    // their consent screens from loading inside iframes).
    // We use `noopener` to fully sever the iframe→popup relationship so that
    // Google/Microsoft can't detect the cross-origin iframe context.
    // Since `noopener` breaks window.opener (no postMessage), we poll
    // /auth/user to detect when login completes.
    const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

    // Open the OAuth flow in a popup. In embedded mode (BeeFlow iframed under
    // Nextcloud / etc.), Chrome's storage partitioning blocks the iframe from
    // ever seeing the popup's session cookie, so polling /auth/user always
    // returns unauthenticated. We bridge that with a pickup token: the iframe
    // mints a random id, hands it to the popup via the URL, the OAuth callback
    // deposits a session token under that id, and we poll /auth/login-pickup
    // (no cookie required) to retrieve it. The token is then stashed in
    // sessionStorage and travels on every authFetch as X-Session-Token.
    const openOAuthPopup = useCallback((urlBase: string) => {
        const w = 520, h = 650;
        const left = window.screenX + (window.outerWidth - w) / 2;
        const top = window.screenY + (window.outerHeight - h) / 2;

        // Generate pickup id; append to URL so the OAuth callback can deposit
        // a token under it.
        const pickupId = newPickupId();
        const sep = urlBase.includes('?') ? '&' : '?';
        const url = `${urlBase}${sep}pickup=${encodeURIComponent(pickupId)}`;

        // noopener severs the opener chain: Google won't see the iframe context.
        window.open(url, 'beeflow_oauth',
            `width=${w},height=${h},left=${left},top=${top},noopener,noreferrer`);

        if (pollTimerRef.current) clearInterval(pollTimerRef.current);
        pollTimerRef.current = setInterval(async () => {
            try {
                // Try the pickup channel first (works even when 3rd-party
                // cookies are blocked).
                const pickRes = await fetch(`${API_BASE}/auth/login-pickup?id=${encodeURIComponent(pickupId)}`, {
                    credentials: 'include',
                });
                if (pickRes.ok) {
                    const pickData: { sessionToken?: string } = await pickRes.json();
                    if (pickData.sessionToken) {
                        setSessionToken(pickData.sessionToken);
                        if (pollTimerRef.current) clearInterval(pollTimerRef.current);
                        pollTimerRef.current = null;
                        // Now fetch the user with the token in place.
                        const userRes = await getAuthUser();
                        if (userRes.ok) {
                            const data: { authenticated?: boolean; user?: unknown } = await userRes.json();
                            if (data.authenticated && data.user) return onLogin(data.user);
                        }
                    }
                }

                // Fallback: cookie-based check (works in non-embedded mode or
                // when the browser allows 3rd-party cookies).
                const res = await getAuthUser();
                if (res.ok) {
                    const data: { authenticated?: boolean; user?: unknown } = await res.json();
                    if (data.authenticated && data.user) {
                        if (pollTimerRef.current) clearInterval(pollTimerRef.current);
                        pollTimerRef.current = null;
                        onLogin(data.user);
                    }
                }
            } catch (err) { logger.debug('server unreachable, keep polling', err); }
        }, 1500);

        // Stop polling after 5 minutes (safety net)
        setTimeout(() => {
            if (pollTimerRef.current) {
                clearInterval(pollTimerRef.current);
                pollTimerRef.current = null;
            }
        }, 5 * 60 * 1000);
    }, [onLogin]);

    // Clean up polling on unmount
    useEffect(() => {
        return () => {
            if (pollTimerRef.current) clearInterval(pollTimerRef.current);
        };
    }, []);

    const handleOAuthLogin = () => {
        if (isEmbedded) {
            openOAuthPopup(`${oauthBase}/auth/login/nextcloud?popup=1`);
        } else {
            window.location.href = `${oauthBase}/auth/login/nextcloud`;
        }
    };

    const handleGoogleLogin = () => {
        if (isEmbedded) {
            openOAuthPopup(`${oauthBase}/auth/login/google?popup=1`);
        } else {
            window.location.href = `${oauthBase}/auth/login/google`;
        }
    };

    const handleMicrosoftLogin = (connectionId?: string) => {
        const url = microsoftLoginUrl(oauthBase, connectionId, isEmbedded);
        if (isEmbedded) openOAuthPopup(url);
        else window.location.href = url;
    };

    return { handleOAuthLogin, handleGoogleLogin, handleMicrosoftLogin };
}
