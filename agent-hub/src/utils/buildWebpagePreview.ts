/**
 * React + Material UI light-tier preview build.
 *
 * Bundles a react-mui project's source files (src/*.jsx, *.css, …) into ONE ES
 * module string with esbuild-wasm IN THE BROWSER, leaving bare specifiers
 * (react, @mui/material, …) external so they resolve at runtime through an
 * import map pointing at https://esm.sh. The single inline module + import map
 * are injected into the sandboxed srcdoc by composeReactPreview().
 *
 * Why this exact shape — the preview iframe's CSP (set in
 * agent-hub/nginx.conf.template) is:
 *     script-src 'self' 'unsafe-inline' 'unsafe-eval' https:
 * That permits an inline <script type="module"> and https: imports/fetches, but
 * NOT blob:/data: module URLs. So a single inline bundle whose only external
 * imports are https://esm.sh URLs (via an import map) is the ONLY
 * CSP-compatible way to run React + MUI inside the no-same-origin sandbox.
 *
 * esbuild-wasm runs in the HOST app (origin 'self', where 'unsafe-eval' + WASM
 * are already allowed for Monaco/vega/mermaid), never inside the iframe. This
 * module is dynamically imported only when a react-mui page is previewed, so
 * the ~3MB wasm never loads for vanilla projects or the rest of the app.
 */

import { buildBridgeHeadScripts } from '@shared/webpage/previewBridges.mjs';
import { buildSelectionBridgeScript } from '@shared/webpage/previewInline.mjs';
import {
    REACT_ENTRY,
    buildImportMap,
    bundleReact,
    reactBodyHtml,
    shellDoc,
} from '@shared/webpage/reactPreview.mjs';

import { buildBfElementsScript } from './bfElementsRuntime';

// The pinned esm.sh runtime, the import map, the esbuild virtual-fs plugin, the
// runtime guard, the asset resolver and the document shell live in
// server/shared/webpage/reactPreview.mjs (this is its generated mirror), shared
// with the server's headless screenshot and public React share.
export { buildImportMap };

// ── esbuild-wasm lazy singleton ────────────────────────────────────────────

let _esbuild: typeof import('esbuild-wasm') | null = null;
let _initPromise: Promise<typeof import('esbuild-wasm')> | null = null;

async function getEsbuild() {
    if (_esbuild) return _esbuild;
    if (!_initPromise) {
        _initPromise = (async () => {
            const esbuild = await import('esbuild-wasm');
            // Serve the wasm from the app origin ('self') via Vite's ?url asset
            // import — keeps the bundler itself working without any CDN (only
            // react/@mui come from esm.sh), which matters for self-hosted installs.
            const wasmURL = (await import('esbuild-wasm/esbuild.wasm?url')).default;
            await esbuild.initialize({ wasmURL, worker: false });
            _esbuild = esbuild;
            return esbuild;
        })().catch((err) => { _initPromise = null; throw err; });
    }
    return _initPromise;
}

/**
 * Bundle the react-mui project into a single ESM string. Throws an Error whose
 * `.formatted` carries readable esbuild diagnostics on failure.
 */
interface PreviewFile {
    isText: boolean;
    content?: string;
    dataUrl?: string;
}

interface BuildReactBundleArgs {
    entry?: string;
    files: Record<string, PreviewFile>;
}

export async function buildReactBundle({ entry = REACT_ENTRY, files }: BuildReactBundleArgs) {
    return bundleReact(await getEsbuild(), { entry, files });
}

// ── Document assembly ──────────────────────────────────────────────────────

function escapeHtml(s: string | null | undefined) {
    return String(s || '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

interface OverlayDocArgs {
    headBridges: string;
    importMap: ReturnType<typeof buildImportMap>;
    message: string;
    isInfo: boolean;
}

function overlayDoc({ headBridges, importMap, message, isInfo }: OverlayDocArgs) {
    const bg = isInfo ? '#f8fafc' : '#fef2f2';
    const fg = isInfo ? '#334155' : '#b91c1c';
    const title = isInfo ? 'React preview' : 'Build error';
    const bodyHtml = `<div id="root"></div>
<div style="position:fixed;inset:0;display:flex;align-items:center;justify-content:center;padding:24px;background:${bg};color:${fg};font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace">
  <div style="max-width:680px;width:100%">
    <div style="font-weight:600;margin-bottom:8px">${title}</div>
    <pre style="white-space:pre-wrap;word-break:break-word;margin:0">${escapeHtml(message)}</pre>
  </div>
</div>`;
    return shellDoc({ headScripts: headBridges, importMap, bodyHtml });
}

/**
 * Friendly, non-technical placeholder shown when a react-mui project has no
 * entry yet (e.g. a brand-new project). NOT the developer code snippet — this
 * is the first thing a non-technical user sees, so it just points them at the
 * chat. (Build errors still get the developer overlay above.)
 */
function emptyStateDoc({ hasSource }: { hasSource: boolean }) {
    const heading = hasSource ? 'Almost there…' : 'Your webpage will appear here';
    const sub = hasSource
        ? 'Ask the assistant in the chat to finish setting up your page.'
        : "Describe what you'd like to build in the chat on the right, and I'll create it for you.";
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:32px;text-align:center;background:#fff;color:#475569;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif">
  <div style="width:52px;height:52px;border-radius:14px;background:#f1f5f9;display:flex;align-items:center;justify-content:center;margin-bottom:18px">
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></svg>
  </div>
  <div style="font-size:16px;font-weight:600;color:#334155">${heading}</div>
  <div style="font-size:13.5px;margin-top:8px;max-width:380px;line-height:1.55">${sub}</div>
</body></html>`;
}

/** "Building…" placeholder shown while the AI is still streaming files in. */
function buildingDoc() {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#fff;color:#64748b;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif">
  <div style="width:34px;height:34px;border:3px solid #e2e8f0;border-top-color:#94a3b8;border-radius:50%;animation:spin 0.8s linear infinite"></div>
  <div style="font-size:13.5px;margin-top:14px">Building your app…</div>
  <style>@keyframes spin{to{transform:rotate(360deg)}}</style>
</body></html>`;
}

/**
 * Compose the full sandboxed preview document for a react-mui project.
 * Returns an HTML string suitable for the iframe srcDoc / a blob: open-in-tab.
 *
 * options mirrors composeWebpageDocument's: { extraFiles, dbToken, dbApiBase,
 * dbWebpageId, selectionBridge, runtime }.
 */
interface PreviewExtraFile {
    path?: string;
    isText?: boolean;
    content?: string;
    dataUrl?: string;
    mimeType?: string;
}

interface ComposeReactPreviewOptions {
    extraFiles?: PreviewExtraFile[];
    dbToken?: string | null;
    dbApiBase?: string | null;
    dbWebpageId?: string | null;
    selectionBridge?: boolean;
    isStreaming?: boolean;
    runtime?: string;
}

export async function composeReactPreview(_slots: { html?: string; css?: string; js?: string; }, options: ComposeReactPreviewOptions = {}) {
    const {
        extraFiles = [],
        dbToken = null,
        dbApiBase = null,
        dbWebpageId = null,
        selectionBridge = false,
        isStreaming = false,
    } = options;

    const files: Record<string, PreviewFile> = {};
    const assetMap: Record<string, string> = {};
    for (const f of extraFiles) {
        if (!f || !f.path) continue;
        if (f.isText && typeof f.content === 'string') files[f.path] = { isText: true, content: f.content };
        else if (f.dataUrl) {
            files[f.path] = { isText: false, dataUrl: f.dataUrl };
            // Runtime-resolvable map for string `src`/`url()` references the
            // bundler can't see (e.g. <img src="assets/logo.jpg">).
            assetMap[f.path] = f.dataUrl;
        }
    }

    // The element block sits BESIDE the bridges, not behind them: buildBridgeHeadScripts
    // returns '' as soon as (token, base, id) is missing, and precisely then every
    // bf-element must say that it cannot reach its source. Without this, a
    // bf-element in a react-mui preview was an empty inline box — no notice, no
    // visible error, nothing. The same silence the public share had.
    const headBridges = buildBridgeHeadScripts({ dbToken, dbApiBase, dbWebpageId })
        + buildBfElementsScript();
    const importMap = buildImportMap();

    if (!files[REACT_ENTRY]) {
        // No entry yet. While streaming, the entry may still be on its way →
        // show "Building…" rather than the empty/come-back-later placeholder.
        if (isStreaming) return buildingDoc();
        const hasSource = extraFiles.some(f =>
            f && f.isText && /\.(jsx?|tsx?|css)$/i.test(f.path || '') && !/^assets\//i.test(f.path || ''));
        return emptyStateDoc({ hasSource });
    }

    let bundle: string;
    try {
        const r = await buildReactBundle({ entry: REACT_ENTRY, files });
        bundle = r.code;
    } catch (e) {
        // Mid-stream a missing import is expected (files arrive incrementally) —
        // keep "Building…" instead of flashing a red error. Show the real error
        // only once the AI has finished.
        if (isStreaming) return buildingDoc();
        return overlayDoc({ headBridges, importMap, isInfo: false, message: (e as { formatted?: string }).formatted || (e as Error).message || String(e) });
    }

    const selBridge = selectionBridge ? buildSelectionBridgeScript() : '';
    const bodyHtml = reactBodyHtml({ bundle, assetMap, extraScripts: [selBridge] });
    return shellDoc({ headScripts: headBridges, importMap, bodyHtml });
}

export default composeReactPreview;
