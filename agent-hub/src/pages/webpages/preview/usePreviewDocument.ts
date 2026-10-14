import { useEffect, useMemo, useState } from 'react';
import composeWebpageDocument from '../../../utils/composeWebpageDocument';
import type { WebpageExtraFile } from '../../../utils/composeWebpageDocument';
import type { ExtraContents, ExtraFileMeta, PrimaryContent } from '../webpageEditorTypes';

/** Friendly placeholder for a React project stranded in vanilla (plain-HTML) mode. */
function strandedReactDoc(): string {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:32px;text-align:center;background:#fff;color:#475569;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif">
  <div style="font-size:16px;font-weight:600;color:#334155">This looks like a React project</div>
  <div style="font-size:13.5px;margin-top:8px;max-width:400px;line-height:1.55">It has React source files (<code style="background:#f1f5f9;padding:1px 4px;border-radius:4px">src/main.jsx</code>) but the project is in plain-HTML mode, so nothing renders. Ask the assistant to "switch this to React + Material UI" and the preview will build.</div>
</body></html>`;
}

/**
 * The base URL the iframe's DB shim calls. The iframe has an opaque origin, so
 * `/api/...` relative URLs would resolve against `null` and fail: VITE_API_URL
 * already gives an absolute URL in dev; in prod (relative API_BASE) the
 * editor's own origin is used, since nginx proxies /api through it.
 */
export function previewApiBase(apiBase: string): string {
    if (apiBase) return apiBase;
    if (typeof window !== 'undefined') return window.location.origin;
    return '';
}

export interface PreviewDocumentInputs {
    webpageId?: string;
    content: PrimaryContent;
    extraFiles: ExtraFileMeta[];
    extraContents: ExtraContents;
    framework: string;
    runtime: string;
    isStreaming: boolean;
    bridgeOn: boolean;
    dbToken: string | null;
    dbApiBase: string;
    refreshKey: number;
}

/**
 * React-mui: bundle asynchronously in the browser via esbuild-wasm. The
 * builder module (and the ~3MB wasm) is dynamically imported so it never loads
 * for vanilla pages or the rest of the app. Debounced so streaming edits don't
 * trigger a rebuild storm; cancel-guarded against races.
 */
function useReactBuild(enabled: boolean, inputs: PreviewDocumentInputs, extras: WebpageExtraFile[]) {
    const [reactDoc, setReactDoc] = useState('');
    const [building, setBuilding] = useState(false);
    const { content: { html, css, js }, bridgeOn, dbToken, dbApiBase, webpageId, runtime, refreshKey, isStreaming } = inputs;
    useEffect(() => {
        if (!enabled) return;
        let cancelled = false;
        setBuilding(true);
        // While the AI is streaming files, intermediate states have missing
        // imports — debounce longer and suppress build errors (composeReactPreview
        // shows a "Building…" state instead of a scary red panel mid-generation).
        const delay = isStreaming ? 600 : 200;
        const timer = setTimeout(async () => {
            try {
                const mod = await import('../../../utils/buildWebpagePreview');
                const doc = await mod.composeReactPreview(
                    { html, css, js },
                    { selectionBridge: bridgeOn, extraFiles: extras, dbToken, dbApiBase, dbWebpageId: webpageId, runtime, isStreaming },
                );
                if (!cancelled) setReactDoc(doc);
            } catch (err) {
                if (!cancelled) {
                    console.error('[WebpagePreview] react preview build failed:', err);
                    const msg = String((err as Error)?.message || err).replace(/[<>&]/g, '');
                    setReactDoc(`<!DOCTYPE html><html><body style="font:13px/1.5 ui-monospace,monospace;color:#b91c1c;padding:24px">Preview build failed: ${msg}</body></html>`);
                }
            } finally {
                if (!cancelled) setBuilding(false);
            }
        }, delay);
        return () => { cancelled = true; clearTimeout(timer); };
    }, [enabled, html, css, js, extras, bridgeOn, dbToken, dbApiBase, webpageId, runtime, refreshKey, isStreaming]);
    return { reactDoc, building };
}

/**
 * What the preview iframe shows: the composed document (vanilla: inline and
 * synchronous; react-mui: built in the browser) or, for the full tier, the
 * container's proxied URL.
 */
export function usePreviewDocument(inputs: PreviewDocumentInputs) {
    const { webpageId, extraFiles, extraContents, framework, runtime, dbToken, dbApiBase, bridgeOn } = inputs;
    const { html, css, js } = inputs.content;
    // Merge metadata + content into a single shape composeWebpageDocument expects.
    const extras = useMemo(() => extraFiles.map(f => {
        const c = extraContents[f.path];
        return c
            ? { path: f.path, isText: c.isText, mimeType: c.mimeType, content: c.content, dataUrl: c.dataUrl }
            : { path: f.path, isText: f.isText, mimeType: f.mimeType };
    }), [extraFiles, extraContents]);

    const isReact = framework === 'react-mui';
    // Full tier: a real per-project Node/Vite container, reverse-proxied
    // same-origin through /api/webpages-preview/:id/full/. GATED server-side —
    // inert unless WEBPAGE_FULL_RUNTIME_ENABLED=1; if the gate is off the proxy
    // 404s and the iframe shows a normal browser error. Reuses the SAME dbToken
    // minted for the light-tier DB bridge — the proxy verifies it via query
    // string (an Authorization header isn't settable on a plain iframe navigation).
    const isFull = runtime === 'full';
    const fullTierUrl = useMemo(() => {
        if (!isFull || !webpageId || !dbToken) return null;
        return `${dbApiBase}/api/webpages-preview/${encodeURIComponent(webpageId)}/full/?token=${encodeURIComponent(dbToken)}`;
    }, [isFull, webpageId, dbToken, dbApiBase]);

    // A project can hold React source (src/main.jsx) while its framework is
    // still 'vanilla'. The vanilla composer would inline an index.html whose
    // <div id="root"> is never filled → blank. Detect it and show a clear hint.
    const hasReactSource = useMemo(
        () => extraFiles.some(f => f.path === 'src/main.jsx' || /^src\/.+\.(jsx|tsx)$/.test(f.path || '')),
        [extraFiles],
    );
    const stranded = !isReact && hasReactSource;

    // Vanilla: synchronous inline compose, only for vanilla projects so
    // react-mui pages don't pay for it.
    const vanillaSrcDoc = useMemo(() => {
        if (isReact) return '';
        if (stranded) return strandedReactDoc();
        return composeWebpageDocument(
            { html, css, js },
            { selectionBridge: bridgeOn, extraFiles: extras, dbToken, dbApiBase, dbWebpageId: webpageId },
        );
    }, [isReact, stranded, html, css, js, extras, bridgeOn, dbToken, dbApiBase, webpageId]);

    // Full tier renders the container's proxied URL directly — skip the
    // in-browser bundle so a full-tier + react-mui project doesn't pay for a
    // build nobody uses.
    const { reactDoc, building } = useReactBuild(isReact && !isFull, inputs, extras);
    const srcDoc = isReact ? reactDoc : vanillaSrcDoc;
    return { srcDoc, fullTierUrl, isReact, isFull, building, reactDoc };
}
