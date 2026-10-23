/**
 * Compose a complete HTML document from the three webpage slots, inlining
 * the CSS into a <style> block and the JS into an inline <script>. This is
 * the form used by the in-app preview iframe (sandboxed without
 * `allow-same-origin`, so external file references would resolve against a
 * `null` origin and fail).
 *
 * Options:
 *   selectionBridge — append a small relay script that posts the user's
 *     text selection up to the parent window via postMessage.
 *   extraFiles — array of { path, isText, mimeType, content?, dataUrl? } for
 *     additional files in the project. Text files are inlined when their
 *     path matches a <link href="..."> or <script src="..."> in the HTML;
 *     binary files (data URLs) replace src/href references inline.
 *
 * The downloaded zip uses a different composition — see downloadWebpageZip.js.
 */

import {
    buildBeeflowAuthScript,
    buildBeeflowBridgesScript,
    buildBeeflowDbScript,
    buildBridgeHeadScripts,
} from '@shared/webpage/previewBridges.mjs';
import {
    buildSelectionBridgeScript,
    defangScriptClose,
    inlineExtras,
    inlineScript,
    inlineStylesheet,
} from '@shared/webpage/previewInline.mjs';

// Het bf-*-elementvocabulaire staat NIET in dit bestand: het staat in
// ./bfElements.js, een gegenereerde spiegel van server/core/webpages/bfElements.js.
// Schrijf hier dus geen tagnaam met de hand bij — bfElements.drift.test.js verbiedt
// dat, juist omdat een tweede lijst in deze composer precies de drift is die W4
// moet voorkomen. De renderer die eruit leest staat in ./bfElementsRuntime.js en
// wordt hieronder NA de bestaande shims uitgezonden.
import { buildBfElementsScript } from './bfElementsRuntime';

// The bridges, the selection relay and the inliners are shared with the
// server's draft document (server/shared/webpage/previewBridges.mjs and
// previewInline.mjs; these are their generated mirrors).
export { defangScriptClose, buildSelectionBridgeScript, buildBridgeHeadScripts };

/** The three editable slots of a webpage; each may be empty. */
export interface WebpageSlots {
    html?: string | null;
    css?: string | null;
    js?: string | null;
}

/** One extra project file, as the preview wants it (text inlined, binary as a data URL). */
export interface PreviewExtraFile {
    path?: string;
    isText?: boolean;
    mimeType?: string;
    content?: string;
    dataUrl?: string;
}

/** What the preview needs beyond the slots. */
export interface WebpageDocumentOptions {
    selectionBridge?: boolean;
    extraFiles?: PreviewExtraFile[];
    dbToken?: string | null;
    dbApiBase?: string | null;
    dbWebpageId?: string | null;
}

const toBase64 = (text: string): string => btoa(unescape(encodeURIComponent(text)));

export function composeWebpageDocument({ html, css, js }: WebpageSlots, options: WebpageDocumentOptions = {}): string {
    const { selectionBridge = false, extraFiles = [], dbToken = null, dbApiBase = null, dbWebpageId = null } = options;
    const safeHtml = html && html.trim()
        ? html
        : '<!DOCTYPE html><html><head></head><body></body></html>';
    const styleTag = css ? `<style>\n${css}\n</style>` : '';
    // The closing `</script>` is split so the surrounding script the iframe
    // is rendered inside can't be mistaken for a closing tag by some parsers.
    // The user's JS body is additionally defanged in case it embeds a literal
    // `</script` sequence (regex, KaTeX delimiters, marked source, etc.).
    const scriptTag = js ? `<script>\n${defangScriptClose(js)}\n<\/script>` : '';
    // Auth helper must be first so both shims can reach window.__beeflowAuth.
    // Gated identically to the shims it serves.
    const beeflowAuthScript = (dbToken && dbApiBase && dbWebpageId)
        ? buildBeeflowAuthScript({ dbToken })
        : '';
    const beeflowDbScript = (dbToken && dbApiBase && dbWebpageId)
        ? buildBeeflowDbScript({ dbApiBase, dbWebpageId })
        : '';
    // Bridges (AI / Automations / Integrations) live alongside the DB shim.
    // Same token + base, different route surface — see webpagesPreview.js.
    const beeflowBridgesScript = (dbToken && dbApiBase && dbWebpageId)
        ? buildBeeflowBridgesScript({ dbToken, dbApiBase, dbWebpageId })
        : '';
    // De Bee Flow-elementen. Met opzet NIET achter dezelfde poort als de shims
    // hierboven: zonder token bestaan die bruggen niet, en juist dan moet elk
    // element ZEGGEN dat het zijn bron niet kan bereiken in plaats van als een
    // leeg, onbekend element onzichtbaar te blijven. Het blok definieert geen
    // enkele brug — het leest ze op naam.
    const bfElementsScript = buildBfElementsScript();
    const bridgeScript = selectionBridge ? buildSelectionBridgeScript() : '';

    let working = safeHtml;

    // Inline PRIMARY slots if the user's HTML references them. Without this
    // pass, AI-generated index.html that contains `<link rel="stylesheet"
    // href="style.css">` or `<script src="script.js"></script>` produces 404
    // errors in the iframe (it has an opaque origin; relative URLs resolve to
    // the parent app's path). When the reference is present we replace it
    // in-place; when it's absent we fall back to appending styleTag/scriptTag
    // at the default head/body positions below.
    let cssInlined = false;
    let jsInlined = false;
    if (css) {
        const replaced = inlineStylesheet(working, 'style.css', css);
        if (replaced !== working) { working = replaced; cssInlined = true; }
    }
    if (js) {
        const replaced = inlineScript(working, 'script.js', js);
        if (replaced !== working) { working = replaced; jsInlined = true; }
    }

    // Inline extra files (two passes: <link>/<script> text first, then data: URLs).
    working = inlineExtras(working, extraFiles, toBase64);

    // Skip the head/body fallback inserts when the user's HTML already
    // referenced the primary slot (the inliner pass above substituted the
    // real content in-place; re-inserting would double-evaluate the script
    // and double-apply the styles).
    const headStyleTag = cssInlined ? '' : styleTag;
    const bodyScriptTag = jsInlined ? '' : scriptTag;

    if (/<head[^>]*>/i.test(working)) {
        // beeflowDbScript + beeflowBridgesScript go immediately after <head>
        // so the globals are defined before any user CSS/JS that might reach
        // for them.
        let out = working.replace(/<head([^>]*)>/i, `<head$1>\n${beeflowAuthScript}\n${beeflowDbScript}\n${beeflowBridgesScript}\n${bfElementsScript}\n${headStyleTag}`);
        if (/<\/body>/i.test(out)) {
            out = out.replace(/<\/body>/i, `${bodyScriptTag}\n${bridgeScript}\n</body>`);
        } else {
            out += bodyScriptTag + bridgeScript;
        }
        return out;
    }
    return `<!DOCTYPE html><html><head>${beeflowAuthScript}${beeflowDbScript}${beeflowBridgesScript}${bfElementsScript}${headStyleTag}</head><body>${working}${bodyScriptTag}${bridgeScript}</body></html>`;
}

export default composeWebpageDocument;
