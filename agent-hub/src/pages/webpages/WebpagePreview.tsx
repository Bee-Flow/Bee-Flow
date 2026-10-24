import { RefreshCw } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import PreviewToolbar, { type PreviewDevice } from './preview/PreviewToolbar';
import { previewApiBase, usePreviewDocument } from './preview/usePreviewDocument';
import { usePreviewToken, useSelectionBridge, type PreviewSelection } from './preview/usePreviewToken';
import type { ExtraContents, ExtraFileMeta } from './webpageEditorTypes';
import useTranslation from '../../hooks/useTranslation';
import { API_BASE } from '../../utils/helpers';

/*
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
 * channel: the editor fetches a short-lived bearer token (usePreviewToken),
 * bakes it into the iframe document, and the injected `window.beeflowDB` shim
 * sends it on every call to /api/webpages-preview/:id/db/...
 */

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
function useMeasuredSize(ref: RefObject<HTMLElement | null>) {
    const [size, setSize] = useState<{ w: number; h: number } | null>(null);
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

/** Full-cover status over the iframe ("Starting…", "Building…", or the empty hint). */
function PreviewOverlay({ kind, label }: { kind: 'busy' | 'empty'; label?: string }) {
    const { t } = useTranslation();
    if (kind === 'busy') {
        return (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 pointer-events-none [background:#fff] [color:#475569]">
                <RefreshCw className="w-5 h-5 animate-spin" />
                <span className="text-sm">{label}</span>
            </div>
        );
    }
    // Nothing built yet and nothing streaming — a friendly hint beats a blank
    // white iframe that reads as broken.
    return (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 pointer-events-none px-6 text-center [background:#fff] [color:#94a3b8]!">
            <span className="text-2xl">🌐</span>
            <span className="text-sm font-medium [color:#475569]!">{t('webpages.preview_empty_title', 'Nothing to preview yet')}</span>
            <span className="text-xs max-w-[280px]">{t('webpages.preview_empty_text', 'Ask the AI in the chat to build something — the preview will appear here as it works.')}</span>
        </div>
    );
}

/**
 * Open the preview full-window. The full tier is already a real, same-origin
 * proxied URL; otherwise a blob: URL with a unique opaque origin gives a
 * full-window view without ever sharing an origin with the host app.
 */
function openPreviewInNewTab(isFull: boolean, fullTierUrl: string | null, srcDoc: string) {
    if (isFull) {
        if (fullTierUrl) window.open(fullTierUrl, '_blank', 'noopener,noreferrer');
        return;
    }
    const url = URL.createObjectURL(new Blob([srcDoc], { type: 'text/html' }));
    window.open(url, '_blank', 'noopener,noreferrer');
    // Revoke after a long beat so even high-latency networks finish loading the
    // document before the URL is invalidated (best-effort cleanup).
    setTimeout(() => URL.revokeObjectURL(url), 120_000);
}

export interface WebpagePreviewProps {
    webpageId?: string;
    html?: string;
    css?: string;
    js?: string;
    extraFiles?: ExtraFileMeta[];
    extraContents?: ExtraContents;
    onSelectionAttach?: (selection: PreviewSelection) => void;
    isStreaming?: boolean;
    framework?: string;
    runtime?: string;
}

const NO_FILES: ExtraFileMeta[] = [];
const NO_CONTENTS: ExtraContents = {};

export default function WebpagePreview({ webpageId, html = '', css = '', js = '', extraFiles = NO_FILES, extraContents = NO_CONTENTS, onSelectionAttach, isStreaming = false, framework = 'vanilla', runtime = 'light' }: WebpagePreviewProps) {
    const { t } = useTranslation();
    const [refreshKey, setRefreshKey] = useState(0);
    const [device, setDevice] = useState<PreviewDevice>('desktop');
    const iframeRef = useRef<HTMLIFrameElement | null>(null);
    // The read-out measures the IFRAME, so a capped device width shows the
    // real box the page renders in rather than the cap.
    const size = useMeasuredSize(iframeRef);
    const dbApiBase = useMemo(() => previewApiBase(API_BASE), []);
    const dbToken = usePreviewToken(webpageId, refreshKey, iframeRef);
    // The composed doc embeds a small script that posts user selections back
    // to the parent; only enabled when the parent supplied a callback.
    const bridgeOn = useSelectionBridge(onSelectionAttach, iframeRef);
    const doc = usePreviewDocument({
        webpageId, content: { html, css, js }, extraFiles, extraContents, framework, runtime, isStreaming, bridgeOn, dbToken, dbApiBase, refreshKey,
    });
    const { isFull, isReact, fullTierUrl, srcDoc } = doc;
    const hasHtml = !!(html && html.trim());

    return (
        <div className="flex flex-col h-full bg-[var(--vsc-sidebar-bg)]">
            <PreviewToolbar
                size={size} device={device} onDevice={setDevice}
                onReload={() => setRefreshKey(k => k + 1)}
                onOpen={() => openPreviewInNewTab(isFull, fullTierUrl, srcDoc)}
            />
            <div className="flex-1 min-h-0 relative flex justify-center">
                {/* The device width is a CAP applied to the wrapper, so the
                    iframe element itself is never re-keyed by the toggle — the
                    postMessage origin guard compares against this exact
                    contentWindow, and a remount would swap it out from under
                    an in-flight token request. */}
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
                {/* Full tier: the only "generating" state visible client-side is
                    "waiting for a preview token" — the container's own boot/HMR
                    progress isn't observable from here. */}
                {isFull && !fullTierUrl && (
                    <PreviewOverlay kind="busy" label={t('webpages.preview_starting_dev', 'Starting the dev server…')} />
                )}
                {/* While the page is still being generated and nothing has been
                    painted yet, show a clear in-progress state instead of a blank
                    white iframe that looks broken (BFSF-178). For react-mui this
                    is the first in-browser bundle (no doc yet). */}
                {!isFull && ((isStreaming && !isReact && !hasHtml) || (isReact && doc.building && !doc.reactDoc)) && (
                    <PreviewOverlay kind="busy" label={isReact ? 'Building React preview…' : 'Generating preview…'} />
                )}
                {!isFull && !isStreaming && !isReact && !hasHtml && <PreviewOverlay kind="empty" />}
            </div>
        </div>
    );
}
