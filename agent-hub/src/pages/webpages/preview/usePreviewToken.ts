import { useEffect, useRef, useState, type RefObject } from 'react';
import { API_BASE } from '../../../utils/helpers';
import { errorMessage, isAbortError, messageOf } from '../../../utils/caughtError';
import { logger } from '../../../utils/logger';
import { mutate, ApiError } from '../../../api/mutate';

/** The selection the preview's bridge script posts back. */
export interface PreviewSelection {
    text: string;
    tagName: string | null;
    className: string | null;
    elementId: string | null;
}

/**
 * The preview iframe is the ONLY window allowed to drive the postMessage
 * handlers below. Without this check any other frame/window could post
 * `__beeflowTokenRefresh` and receive a fresh preview bearer token, or spoof a
 * selection. The iframe is sandboxed without `allow-same-origin`, so it has an
 * opaque origin (`event.origin === 'null'`) and `event.source` is its
 * contentWindow — that is what is verified.
 */
function isFromPreviewIframe(iframeRef: RefObject<HTMLIFrameElement | null>, event: MessageEvent): boolean {
    return !!iframeRef.current && event?.source === iframeRef.current.contentWindow;
}

async function mintToken(webpageId: string, signal?: AbortSignal): Promise<{ token: string; expiresAt?: number }> {
    let res: Response;
    try {
        res = await mutate(`${API_BASE}/api/webpages/${webpageId}/preview-token`, { method: 'POST', ...(signal ? { signal } : {}) });
    } catch (err) {
        if (!(err instanceof ApiError)) throw err;
        throw new Error(`token fetch ${err.status}`);
    }
    return res.json();
}

/**
 * The short-lived preview bearer token the iframe's DB shim sends.
 *
 * A fresh token is fetched whenever the webpage changes or the user reloads
 * the iframe. Deliberately NOT cached by remaining TTL: the signing secret can
 * rotate (server restart in dev, key rotation in prod) mid-session, and the
 * only way to recover is to mint a new token. Token fetches are cheap (single
 * HMAC), so always doing it on these triggers is the safe default.
 *
 * Also the token refresh bridge: the sandboxed iframe asks for a fresh token
 * whenever it sees a 401 from /api/webpages-preview/*; one is minted and
 * posted back, and the iframe retries the original call without the user
 * noticing.
 */
export function usePreviewToken(webpageId: string | undefined, refreshKey: number, iframeRef: RefObject<HTMLIFrameElement | null>) {
    const [dbToken, setDbToken] = useState<string | null>(null);
    const [, setDbTokenExpiresAt] = useState(0);

    useEffect(() => {
        if (!webpageId) { setDbToken(null); setDbTokenExpiresAt(0); return; }
        const controller = new AbortController();
        let cancelled = false;
        (async () => {
            try {
                const data = await mintToken(webpageId, controller.signal);
                if (cancelled) return;
                setDbToken(data.token);
                setDbTokenExpiresAt(data.expiresAt || 0);
            } catch (err) {
                if (isAbortError(err)) return;
                console.warn('[WebpagePreview] preview-token fetch failed:', errorMessage(err));
                if (!cancelled) { setDbToken(null); setDbTokenExpiresAt(0); }
            }
        })();
        return () => { cancelled = true; controller.abort(); };
    }, [webpageId, refreshKey]);

    // Keep the latest webpageId in a ref so the token-refresh handler always
    // mints a token for the *currently* selected webpage even if the user has
    // swapped pages between request and reply.
    const webpageIdRef = useRef(webpageId);
    useEffect(() => { webpageIdRef.current = webpageId; }, [webpageId]);

    useEffect(() => {
        const handler = async (event: MessageEvent) => {
            if (!isFromPreviewIframe(iframeRef, event)) return;
            const data = event?.data;
            if (!data || data.__beeflowTokenRefresh !== true) return;
            const currentId = webpageIdRef.current;
            if (!currentId) return;
            const reqId = data.requestId;
            // targetOrigin must be '*': the sandboxed iframe has an opaque
            // origin, so event.origin is the string 'null', and
            // postMessage(msg, 'null') throws a SyntaxError (it is not a
            // parseable URL) — the reply would never arrive and the iframe's
            // refresh would time out. The real guard is isFromPreviewIframe
            // above, and the token is scoped to this preview.
            const respond = (body: Record<string, unknown>) => {
                try {
                    // nosemgrep: javascript.browser.security.wildcard-postmessage-configuration.wildcard-postmessage-configuration -- targetOrigin '*' is intended: the sandboxed preview's opaque origin cannot be named; the reply goes to event.source, which isFromPreviewIframe checks above
                    (event.source as Window | null)?.postMessage({ __beeflowTokenResponse: true, requestId: reqId, ...body }, '*');
                } catch (err) { logger.debug('ignore', err); }
            };
            try {
                const body = await mintToken(currentId);
                // Only update state if the page hasn't been swapped during the fetch.
                if (webpageIdRef.current === currentId) {
                    setDbToken(body.token);
                    setDbTokenExpiresAt(body.expiresAt || 0);
                }
                respond({ token: body.token, expiresAt: body.expiresAt || 0 });
            } catch (err) {
                respond({ error: messageOf(err, 'token refresh failed') });
            }
        };
        window.addEventListener('message', handler);
        return () => window.removeEventListener('message', handler);
    }, [iframeRef]);

    return dbToken;
}

/**
 * The selection bridge: a selection the composed document posts back becomes
 * a chat chip. Only on when the caller supplied a callback.
 */
export function useSelectionBridge(onSelectionAttach: ((s: PreviewSelection) => void) | undefined, iframeRef: RefObject<HTMLIFrameElement | null>) {
    const bridgeOn = typeof onSelectionAttach === 'function';
    useEffect(() => {
        if (!bridgeOn) return;
        const handler = (event: MessageEvent) => {
            if (!isFromPreviewIframe(iframeRef, event)) return;
            const data = event?.data;
            if (!data || data.__beeflowWebpageSelection !== true) return;
            const text = typeof data.text === 'string' ? data.text.trim() : '';
            if (!text) return;
            onSelectionAttach?.({
                text,
                tagName: data.tagName || null,
                className: data.className || null,
                elementId: data.elementId || null,
            });
        };
        window.addEventListener('message', handler);
        return () => window.removeEventListener('message', handler);
    }, [bridgeOn, onSelectionAttach, iframeRef]);
    return bridgeOn;
}
