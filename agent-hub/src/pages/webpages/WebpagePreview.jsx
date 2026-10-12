import { RefreshCw, ExternalLink, Monitor, Shield, Smartphone } from 'lucide-react';
import React, { useMemo, useState, useEffect, useRef } from 'react';
import useTranslation from '../../hooks/useTranslation';
import composeWebpageDocument from '../../utils/composeWebpageDocument';
import { API_BASE, authFetch } from '../../utils/helpers';

/**
 * Sandboxed live preview of a webpage's three slots.
 *
 * Critical: the iframe uses sandbox="allow-scripts allow-forms" — NO
 * allow-same-origin. This is the same approach Claude Artifacts / v0 / bolt
 * use. It guarantees:
 *  • the previewed page's CSS / JS can never reach into the host app
 *  • the host app's CSS / JS can never reach into the preview
 *  • parent.location, document.cookie, fetch() to the host app all fail
 *
 * `allow-forms` is required because AI-generated pages routinely use
 * `<form>` elements; without it the browser blocks the submit event and
 * any JS preventDefault never runs. Forms still cannot navigate cross-
 * origin against the host (the target origin is `null`), so they're safe
 * — the form action is effectively inert and the JS submit handler runs.
 *
 * Database access from the iframe goes through a separate cross-origin
 * channel: the editor fetches a short-lived bearer token below, bakes it
 * into the iframe document, and the injected `window.beeflowDB` shim sends
 * it on every call to /api/webpages-preview/:id/db/...
 */
/** Friendly placeholder for a React project stranded in vanilla (plain-HTML) mode. */
function strandedReactDoc() {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:32px;text-align:center;background:#fff;color:#475569;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif">
  <div style="font-size:16px;font-weight:600;color:#334155">This looks like a React project</div>
  <div style="font-size:13.5px;margin-top:8px;max-width:400px;line-height:1.55">It has React source files (<code style="background:#f1f5f9;padding:1px 4px;border-radius:4px">src/main.jsx</code>) but the project is in plain-HTML mode, so nothing renders. Ask the assistant to "switch this to React + Material UI" and the preview will build.</div>
</body></html>`;
}

/**
 * The two widths the toolbar's monitor/phone toggle switches between (plan
 * W2). They are a CAP, not a fixed size: a pane narrower than 1440 shows the
 * page at the pane's width, which is why the toolbar reads the size back from
 * the DOM instead of printing these numbers.
 */
export const PREVIEW_DEVICES = Object.freeze({
    desktop: { width: 1440 },
    mobile: { width: 390 },
});

/**
 * The size read-out: the iframe's REAL rendered box, measured, in CSS pixels.
 *
 * It is measured rather than declared because the declared width is only a
 * cap — printing "1440 × 900" beside a preview that is actually 620 wide
 * would be a confident lie about the thing the user is looking at. Where the
 * size cannot be measured (no ResizeObserver — jsdom, older browsers) it
 * returns null and the toolbar prints NOTHING.
 */
function useMeasuredSize(ref) {
    const [size, setSize] = useState(null);
    useEffect(() => {
        const el = ref.current;
        if (!el || typeof ResizeObserver === 'undefined') return undefined;
        const read = () => {
            const r = el.getBoundingClientRect();
            const w = Math.round(r.width);
            const h = Math.round(r.height);
            setSize((w > 0 && h > 0) ? { w, h } : null);
        };
        read();
        const ro = new ResizeObserver(read);
        ro.observe(el);
        return () => ro.disconnect();
    }, [ref]);
    return size;
}

/** One half of the monitor/phone toggle: a radio, not a button that guesses. */
function DeviceButton({ icon, value, active, label, onPick }) {
    const Icon = icon;
    return (
        <button
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onPick(value)}
            title={label}
            aria-label={label}
            data-testid={`preview-device-${value}`}
            className="grid place-items-center w-6 h-6 rounded transition-colors"
            style={{
                color: active ? 'var(--vsc-fg)' : 'var(--vsc-fg-muted)',
                background: active ? 'var(--vsc-hover-bg)' : 'transparent',
            }}
        >
            <Icon className="w-3.5 h-3.5" aria-hidden="true" />
        </button>
    );
}

export default function WebpagePreview({ webpageId, html, css, js, extraFiles = [], extraContents = {}, onSelectionAttach, isStreaming = false, framework = 'vanilla', runtime = 'light' }) {
    const { t } = useTranslation();
    const [refreshKey, setRefreshKey] = useState(0);
    const [device, setDevice] = useState('desktop');
    const [dbToken, setDbToken] = useState(null);
    const [dbTokenExpiresAt, setDbTokenExpiresAt] = useState(0);

    // The composed doc embeds a small script that posts user selections back
    // to the parent. Only enable the bridge when the parent supplied a
    // callback — keeps the iframe minimal everywhere else.
    const bridgeOn = typeof onSelectionAttach === 'function';

    // The iframe has an opaque origin, so `/api/...` relative URLs would
    // resolve against `null` and fail. Build an absolute base — VITE_API_URL
    // already gives an absolute URL in dev; in prod (relative API_BASE) we
    // use the editor's own origin since nginx proxies /api through it.
    const dbApiBase = useMemo(() => {
        if (API_BASE) return API_BASE;
        if (typeof window !== 'undefined') return window.location.origin;
        return '';
    }, []);

    // Fetch a fresh preview token whenever the webpage changes or the user
    // reloads the iframe. We deliberately do NOT cache by remaining TTL: the
    // signing secret can rotate (server restart in dev, key rotation in prod)
    // mid-session, and the only way to recover is to mint a new token. Token
    // fetches are cheap (single HMAC), so always doing it on these triggers
    // is the safe default.
    useEffect(() => {
        if (!webpageId) { setDbToken(null); setDbTokenExpiresAt(0); return; }
        const controller = new AbortController();
        let cancelled = false;
        (async () => {
            try {
                const res = await authFetch(`${API_BASE}/api/webpages/${webpageId}/preview-token`, {
                    method: 'POST',
                    signal: controller.signal,
                });
                if (!res.ok) throw new Error(`token fetch ${res.status}`);
                const data = await res.json();
                if (cancelled) return;
                setDbToken(data.token);
                setDbTokenExpiresAt(data.expiresAt || 0);
            } catch (err) {
                if (err?.name === 'AbortError') return;
                console.warn('[WebpagePreview] preview-token fetch failed:', err.message);
                if (!cancelled) { setDbToken(null); setDbTokenExpiresAt(0); }
            }
        })();
        return () => { cancelled = true; controller.abort(); };
    }, [webpageId, refreshKey]);

    // M1: keep the latest webpageId in a ref so the token-refresh postMessage
    // handler always mints a token for the *currently* selected webpage even if
    // the user has swapped pages between request and reply.
    const webpageIdRef = useRef(webpageId);
    useEffect(() => { webpageIdRef.current = webpageId; }, [webpageId]);

    // The preview iframe is the ONLY window allowed to drive these postMessage
    // handlers. Without this check any other frame/window could post
    // `__beeflowTokenRefresh` and receive a fresh preview bearer token, or spoof
    // a selection. The iframe is sandboxed without `allow-same-origin`, so it has
    // an opaque origin (`event.origin === 'null'`) and `event.source` is its
    // contentWindow — verify both.
    const iframeRef = useRef(null);
    // The read-out measures the IFRAME, so a capped device width shows the
    // real box the page renders in rather than the cap.
    const frameWrapRef = useRef(null);
    const size = useMeasuredSize(iframeRef);
    const isFromPreviewIframe = (event) =>
        !!iframeRef.current && event?.source === iframeRef.current.contentWindow;

    // Merge metadata + content into a single shape composeWebpageDocument expects.
    const extras = useMemo(() => extraFiles.map(f => {
        const c = extraContents[f.path];
        return c
            ? { path: f.path, isText: c.isText, mimeType: c.mimeType, content: c.content, dataUrl: c.dataUrl }
            : { path: f.path, isText: f.isText, mimeType: f.mimeType };
    }), [extraFiles, extraContents]);

    const isReact = framework === 'react-mui';
    // Full tier: a real per-project Node/Vite container (server/services/
    // webpageRuntimeManager.js), reverse-proxied same-origin through
    // /api/webpages-preview/:id/full/ (server/routes/webpagesFullTierProxy.js).
    // GATED server-side — inert unless WEBPAGE_FULL_RUNTIME_ENABLED=1; if the
    // gate is off the proxy 404s and the iframe shows a normal browser error,
    // same as any other unreachable URL. Reuses the SAME dbToken this
    // component already mints for the light-tier DB bridge — the proxy's
    // requirePreviewToken middleware verifies it via query string (an
    // Authorization header isn't settable on a plain iframe navigation).
    const isFull = runtime === 'full';
    const fullTierUrl = useMemo(() => {
        if (!isFull || !webpageId || !dbToken) return null;
        return `${dbApiBase}/api/webpages-preview/${encodeURIComponent(webpageId)}/full/?token=${encodeURIComponent(dbToken)}`;
    }, [isFull, webpageId, dbToken, dbApiBase]);

    // A project can hold React source (src/main.jsx) while its framework is still
    // 'vanilla' (e.g. created before react-mui became the default, or the flag
    // didn't propagate). The vanilla composer would inline an index.html whose
    // <div id="root"> is never filled → blank. Detect it and show a clear hint.
    const hasReactSource = useMemo(
        () => extraFiles.some(f => f.path === 'src/main.jsx' || /^src\/.+\.(jsx|tsx)$/.test(f.path || '')),
        [extraFiles]
    );
    const stranded = !isReact && hasReactSource;

    // Vanilla: synchronous inline compose (unchanged). Only computed for vanilla
    // projects so react-mui pages don't pay for it.
    const vanillaSrcDoc = useMemo(
        () => {
            if (isReact) return '';
            if (stranded) return strandedReactDoc();
            return composeWebpageDocument(
                { html, css, js },
                {
                    selectionBridge: bridgeOn,
                    extraFiles: extras,
                    dbToken,
                    dbApiBase,
                    dbWebpageId: webpageId,
                }
            );
        },
        [isReact, stranded, html, css, js, extras, bridgeOn, dbToken, dbApiBase, webpageId]
    );

    // React-mui: bundle asynchronously in the browser via esbuild-wasm. The
    // builder module (and the ~3MB wasm) is dynamically imported so it never
    // loads for vanilla pages or the rest of the app. Debounced so streaming
    // edits don't trigger a rebuild storm; cancel-guarded against races.
    const [reactDoc, setReactDoc] = useState('');
    const [building, setBuilding] = useState(false);
    useEffect(() => {
        // Full tier renders the container's proxied URL directly (see isFull
        // above) — skip the in-browser esbuild-wasm bundle entirely so a
        // full-tier + react-mui project doesn't pay for a build nobody uses.
        if (!isReact || isFull) return;
        let cancelled = false;
        setBuilding(true);
        // While the AI is streaming files, intermediate states have missing
        // imports — debounce longer and suppress build errors (composeReactPreview
        // shows a "Building…" state instead of a scary red panel mid-generation).
        const delay = isStreaming ? 600 : 200;
        const timer = setTimeout(async () => {
            try {
                const mod = await import('../../utils/buildWebpagePreview');
                const doc = await mod.composeReactPreview(
                    { html, css, js },
                    { selectionBridge: bridgeOn, extraFiles: extras, dbToken, dbApiBase, dbWebpageId: webpageId, runtime, isStreaming }
                );
                if (!cancelled) setReactDoc(doc);
            } catch (err) {
                if (!cancelled) {
                    console.error('[WebpagePreview] react preview build failed:', err);
                    const msg = String(err?.message || err).replace(/[<>&]/g, '');
                    setReactDoc(`<!DOCTYPE html><html><body style="font:13px/1.5 ui-monospace,monospace;color:#b91c1c;padding:24px">Preview build failed: ${msg}</body></html>`);
                }
            } finally {
                if (!cancelled) setBuilding(false);
            }
        }, delay);
        return () => { cancelled = true; clearTimeout(timer); };
    }, [isReact, isFull, html, css, js, extras, bridgeOn, dbToken, dbApiBase, webpageId, runtime, refreshKey, isStreaming]);

    const srcDoc = isReact ? reactDoc : vanillaSrcDoc;

    useEffect(() => {
        if (!bridgeOn) return;
        const handler = (event) => {
            if (!isFromPreviewIframe(event)) return;
            const data = event?.data;
            if (!data || data.__beeflowWebpageSelection !== true) return;
            const text = typeof data.text === 'string' ? data.text.trim() : '';
            if (!text) return;
            onSelectionAttach({
                text,
                tagName: data.tagName || null,
                className: data.className || null,
                elementId: data.elementId || null,
            });
        };
        window.addEventListener('message', handler);
        return () => window.removeEventListener('message', handler);
    }, [bridgeOn, onSelectionAttach]);

    // Token refresh bridge — the sandboxed iframe asks for a fresh token
    // whenever it sees a 401 from /api/webpages-preview/*. We mint one from
    // the session-authenticated /preview-token endpoint and postMessage it
    // back. The iframe swaps it into its TOKEN constant and retries the
    // original call without the user noticing. Keeps chat widgets / DB
    // calls working across dev-server restarts and key rotation.
    useEffect(() => {
        const handler = async (event) => {
            if (!isFromPreviewIframe(event)) return;
            const data = event?.data;
            if (!data || data.__beeflowTokenRefresh !== true) return;
            const currentId = webpageIdRef.current;
            if (!currentId) return;
            const reqId = data.requestId;
            const respond = (body) => {
                try {
                    event.source?.postMessage({ __beeflowTokenResponse: true, requestId: reqId, ...body }, event.origin || '*');
                } catch (_) { /* ignore */ }
            };
            try {
                const res = await authFetch(`${API_BASE}/api/webpages/${currentId}/preview-token`, { method: 'POST' });
                if (!res.ok) throw new Error(`token fetch ${res.status}`);
                const body = await res.json();
                // Only update state if the page hasn't been swapped during the fetch.
                if (webpageIdRef.current === currentId) {
                    setDbToken(body.token);
                    setDbTokenExpiresAt(body.expiresAt || 0);
                }
                respond({ token: body.token, expiresAt: body.expiresAt || 0 });
            } catch (err) {
                respond({ error: err.message || 'token refresh failed' });
            }
        };
        window.addEventListener('message', handler);
        return () => window.removeEventListener('message', handler);
    }, []);

    const openInNewTab = () => {
        if (isFull) {
            // Already a real, same-origin proxied URL — no blob indirection needed
            // (there's no srcDoc to wrap; the container serves live HTML directly).
            if (fullTierUrl) window.open(fullTierUrl, '_blank', 'noopener,noreferrer');
            return;
        }
        // A blob: URL with a unique opaque origin — gives the user a full-window
        // view without ever sharing an origin with the host app.
        const blob = new Blob([srcDoc], { type: 'text/html' });
        const url = URL.createObjectURL(blob);
        window.open(url, '_blank', 'noopener,noreferrer');
        // Revoke after a long beat so even high-latency networks finish loading
        // the document before the URL is invalidated. Browsers will GC the blob
        // when the page is gone; this is best-effort cleanup.
        setTimeout(() => URL.revokeObjectURL(url), 120_000);
    };

    return (
        <div className="flex flex-col h-full" style={{ background: 'var(--vsc-sidebar-bg)' }}>
            <div className="shrink-0 px-3 py-1.5 border-b flex items-center justify-between gap-2"
                 style={{ borderColor: 'var(--vsc-border)' }}>
                <div className="flex items-center gap-2 min-w-0">
                    <span className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--vsc-fg-muted)', letterSpacing: '0.06em' }}>
                        {t('webpages.preview.title', 'Preview')}
                    </span>
                    {/* What the shield claims is exactly what the iframe does:
                        sandbox="allow-scripts allow-forms" with NO
                        allow-same-origin (see the file header). If that ever
                        changes, this wording has to change with it. */}
                    <span
                        className="inline-flex items-center gap-1 text-[10px]"
                        data-testid="preview-shield"
                        title={t('webpages.preview.shielded_hint', 'The page runs in an isolated frame: it cannot reach your session, your cookies, or the app around it.')}
                        style={{ color: 'var(--vsc-fg-muted)' }}
                    >
                        <Shield className="w-3 h-3" aria-hidden="true" />
                        {t('webpages.preview.shielded', 'Running shielded')}
                    </span>
                    {/* Measured, never declared — see useMeasuredSize. Absent
                        when it cannot be measured. */}
                    {size && (
                        <span
                            className="text-[10px] tabular-nums"
                            data-testid="preview-size"
                            style={{ color: 'var(--vsc-fg-muted)', opacity: 0.7 }}
                        >
                            {size.w} × {size.h}
                        </span>
                    )}
                </div>
                <div className="flex items-center gap-1">
                    <div className="flex items-center mr-1" role="radiogroup" aria-label={t('webpages.preview.device', 'Preview width')}>
                        <DeviceButton
                            icon={Monitor} value="desktop" active={device === 'desktop'}
                            label={t('webpages.preview.desktop', 'Desktop')} onPick={setDevice}
                        />
                        <DeviceButton
                            icon={Smartphone} value="mobile" active={device === 'mobile'}
                            label={t('webpages.preview.mobile', 'Mobile')} onPick={setDevice}
                        />
                    </div>
                    <button
                        onClick={() => setRefreshKey(k => k + 1)}
                        className="px-2 py-0.5 rounded text-[11px] flex items-center gap-1 transition-colors"
                        style={{ color: 'var(--vsc-fg)' }}
                        onMouseEnter={(e) => e.currentTarget.style.background = 'var(--vsc-hover-bg)'}
                        onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                        title={t('webpages.preview.reload_hint', 'Reload preview')}
                    >
                        <RefreshCw className="w-3 h-3" /> {t('webpages.preview.reload', 'Reload')}
                    </button>
                    <button
                        onClick={openInNewTab}
                        className="px-2 py-0.5 rounded text-[11px] flex items-center gap-1 transition-colors"
                        style={{ color: 'var(--vsc-fg)' }}
                        onMouseEnter={(e) => e.currentTarget.style.background = 'var(--vsc-hover-bg)'}
                        onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                        title={t('webpages.preview.open_hint', 'Open preview in a new tab')}
                    >
                        <ExternalLink className="w-3 h-3" /> {t('webpages.preview.open', 'Open')}
                    </button>
                </div>
            </div>
            <div className="flex-1 min-h-0 relative flex justify-center" ref={frameWrapRef}>
                {/* The device width is a CAP applied to the wrapper, so the
                    iframe element itself is never re-keyed by the toggle — the
                    postMessage origin guard (isFromPreviewIframe) compares
                    against this exact contentWindow, and a remount would swap
                    it out from under an in-flight token request. */}
                <iframe
                    key={refreshKey}
                    ref={iframeRef}
                    title={t('webpages.preview.frame_title', 'Webpage preview')}
                    data-device={device}
                    {...(isFull ? { src: fullTierUrl || 'about:blank' } : { srcDoc })}
                    sandbox="allow-scripts allow-forms"
                    referrerPolicy="no-referrer"
                    style={{
                        width: '100%',
                        maxWidth: PREVIEW_DEVICES[device].width,
                        height: '100%',
                        border: 0,
                        background: '#fff',
                        ...(device === 'mobile'
                            ? { borderLeft: '1px solid var(--vsc-border)', borderRight: '1px solid var(--vsc-border)' }
                            : null),
                    }}
                />
                {/* Full tier: the only "generating" state we can show client-side is
                    "waiting for a preview token" — the container's own boot/HMR
                    progress isn't observable from here (it's whatever Vite renders
                    once the proxied document loads). */}
                {isFull && !fullTierUrl && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 pointer-events-none"
                         style={{ background: '#fff', color: '#475569' }}>
                        <RefreshCw className="w-5 h-5 animate-spin" />
                        <span className="text-sm">{t('webpages.preview_starting_dev', 'Starting the dev server…')}</span>
                    </div>
                )}
                {/* While the page is still being generated and nothing has been
                    painted yet, show a clear in-progress state instead of a blank
                    white iframe that looks broken (BFSF-178). For react-mui this
                    is the first in-browser bundle (no doc yet). */}
                {!isFull && ((isStreaming && !isReact && !(html && html.trim())) || (isReact && building && !reactDoc)) && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 pointer-events-none"
                         style={{ background: '#fff', color: '#475569' }}>
                        <RefreshCw className="w-5 h-5 animate-spin" />
                        <span className="text-sm">{isReact ? 'Building React preview…' : 'Generating preview…'}</span>
                    </div>
                )}
                {/* Nothing built yet and nothing streaming — a friendly hint beats
                    a blank white iframe that reads as broken. */}
                {!isFull && !isStreaming && !isReact && !(html && html.trim()) && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 pointer-events-none px-6 text-center"
                         style={{ background: '#fff', color: '#94a3b8' }}>
                        <span className="text-2xl">🌐</span>
                        <span className="text-sm font-medium" style={{ color: '#475569' }}>{t('webpages.preview_empty_title', 'Nothing to preview yet')}</span>
                        <span className="text-xs" style={{ maxWidth: 280 }}>{t('webpages.preview_empty_text', 'Ask the AI in the chat to build something — the preview will appear here as it works.')}</span>
                    </div>
                )}
            </div>
        </div>
    );
}
