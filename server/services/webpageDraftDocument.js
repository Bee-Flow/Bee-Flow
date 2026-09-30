/**
 * A webpage's current draft as ONE ready-to-run HTML document — what the web
 * editor's preview iframe shows, built on the server so a client that cannot
 * bundle React in the browser (the phone) shows the same page.
 *
 * Two frameworks, the same two paths the web takes:
 *
 *   - 'vanilla': the three slots plus the project's extra files, inlined
 *     exactly as agent-hub/src/utils/composeWebpageDocument.js does (the
 *     inliners below are pinned to it by webpagePreviewBridges.lockstep.test.js);
 *   - 'react-mui': the extra files bundled by reactBundleServer.composeReactDoc,
 *     the code that also builds the public React share and the builder's
 *     screenshot — here with the LIVE bridges instead of the stubs.
 *
 * The caller supplies `headScripts` (the token-carrying bridges from
 * webpagePreviewBridges.js) and the slots it is allowed to read (a reader gets
 * the published snapshot, see routes/webpages/publishedSnapshot.js). This
 * module mints nothing and decides no access.
 *
 * What is left out on purpose: the web's selection relay (it posts to an
 * editor the phone does not have) and the web's bf-* element runtime
 * (agent-hub/src/utils/bfElementsRuntime.js, client-only; it has no server
 * twin yet).
 *
 * Bundling costs real CPU, so a React build is cached per (webpage, hash of
 * every file's bytes): reopening an unchanged draft reuses the bundle.
 */

'use strict';

const crypto = require('crypto');

const webpageStore = require('../stores/webpageStore');
const { resolveFramework, resolveRuntime } = require('../integrations/webpageFramework');
const { REACT_ENTRY, buildReactBundle, composeReactDoc } = require('./reactBundleServer');

const EMPTY_DOC = '<!DOCTYPE html><html><head></head><body></body></html>';

// ── Vanilla composition (port of composeWebpageDocument.js) ─────────────────

function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function defangScriptClose(jsContent) {
    return String(jsContent || '').replace(/<\/script/gi, '<\\/script');
}

function inlineStylesheet(html, targetPath, css) {
    const re = new RegExp(`<link\\b[^>]*\\bhref\\s*=\\s*["']${escapeRegExp(targetPath)}["'][^>]*>`, 'gi');
    // Use the function-form replacer so `$` chars in `css` aren't interpreted
    // as String.replace backreferences ($&, $', $`, $1-$9).
    return html.replace(re, () => `<style>\n${css}\n</style>`);
}

function inlineScript(html, targetPath, js) {
    const re = new RegExp(`<script\\b[^>]*\\bsrc\\s*=\\s*["']${escapeRegExp(targetPath)}["'][^>]*>\\s*<\\/script>`, 'gi');
    const replacement = `<script>\n${defangScriptClose(js)}\n<\/script>`;
    // Function-form replacer — JS bodies routinely contain `$` (template
    // literals, KaTeX delimiters, regexes). The string form would interpret
    // those as backreferences and silently corrupt the inlined script.
    return html.replace(re, () => replacement);
}

function inlineDataUrl(html, targetPath, dataUrl) {
    const reHref = new RegExp(`(\\bhref\\s*=\\s*["'])${escapeRegExp(targetPath)}(["'])`, 'gi');
    const reSrc = new RegExp(`(\\bsrc\\s*=\\s*["'])${escapeRegExp(targetPath)}(["'])`, 'gi');
    // dataUrl is base64 but the surrounding HTML segments could contain `$`;
    // use the function form for the same reason as inlineScript above.
    return html
        .replace(reHref, (_match, p1, p2) => `${p1}${dataUrl}${p2}`)
        .replace(reSrc, (_match, p1, p2) => `${p1}${dataUrl}${p2}`);
}

function inlineExtras(html, extras) {
    let working = html;
    // Pass 1: text files referenced by <link>/<script> tags.
    for (const f of extras) {
        if (!f.isText || typeof f.content !== 'string') continue;
        if (/\.css$/i.test(f.path)) working = inlineStylesheet(working, f.path, f.content);
        else if (/\.m?js$/i.test(f.path)) working = inlineScript(working, f.path, f.content);
    }
    // Pass 2: data URLs for everything still referenced by src/href.
    for (const f of extras) {
        if (f.dataUrl) {
            working = inlineDataUrl(working, f.path, f.dataUrl);
        } else if (f.isText && typeof f.content === 'string') {
            const url = `data:${f.mimeType || 'text/plain'};base64,${Buffer.from(f.content, 'utf8').toString('base64')}`;
            working = inlineDataUrl(working, f.path, url);
        }
    }
    return working;
}

/** composeWebpageDocument with the live bridges as `headScripts`. */
function composeVanillaDocument({ html, css, js }, { extras = [], headScripts = '' } = {}) {
    const safeHtml = html && html.trim() ? html : EMPTY_DOC;
    const styleTag = css ? `<style>\n${css}\n</style>` : '';
    const scriptTag = js ? `<script>\n${defangScriptClose(js)}\n<\/script>` : '';

    let working = safeHtml;
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
    working = inlineExtras(working, extras);

    const headStyleTag = cssInlined ? '' : styleTag;
    const bodyScriptTag = jsInlined ? '' : scriptTag;
    if (/<head[^>]*>/i.test(working)) {
        let out = working.replace(/<head([^>]*)>/i, (_m, attrs) => `<head${attrs}>\n${headScripts}\n${headStyleTag}`);
        if (/<\/body>/i.test(out)) out = out.replace(/<\/body>/i, () => `${bodyScriptTag}\n</body>`);
        else out += bodyScriptTag;
        return out;
    }
    return `<!DOCTYPE html><html><head>${headScripts}${headStyleTag}</head><body>${working}${bodyScriptTag}</body></html>`;
}

// ── Project files ───────────────────────────────────────────────────────────

/**
 * Every extra file, in the shape the web preview composes from:
 * { path, isText, mimeType, content? | dataUrl? }. Bytes live under the
 * OWNER's prefix, whoever is asking (same rule as webpageReactFiles.js).
 */
async function loadExtras(webpageId, ownerId) {
    const metas = await webpageStore.listExtraFiles(webpageId);
    const out = [];
    for (const meta of metas) {
        if (!meta || !meta.path) continue;
        const res = await webpageStore.readExtraFile({ webpageId, userId: ownerId, path: meta.path });
        if (!res) continue;
        const mimeType = meta.mimeType || 'application/octet-stream';
        if (meta.isText && typeof res.text === 'string') {
            out.push({ path: meta.path, isText: true, mimeType, content: res.text });
        } else if (res.bytes) {
            out.push({ path: meta.path, isText: false, mimeType, dataUrl: `data:${mimeType};base64,${res.bytes.toString('base64')}` });
        }
    }
    return out;
}

/** The web's "React source in a plain-HTML project" test (WebpagePreview.jsx). */
function hasReactSource(extras) {
    return extras.some((f) => f.path === REACT_ENTRY || /^src\/.+\.(jsx|tsx)$/.test(f.path || ''));
}

// ── React bundle cache ──────────────────────────────────────────────────────

const BUNDLE_CACHE_MAX = 32;
const bundleCache = new Map();

function hashFiles(files) {
    const h = crypto.createHash('sha256');
    for (const path of Object.keys(files).sort()) {
        const f = files[path];
        h.update(path).update('\0').update(f.isText ? f.content : f.dataUrl).update('\0');
    }
    return h.digest('hex');
}

/**
 * buildReactBundle, remembered per (webpage, draft hash). A failed build is
 * remembered too: the same bytes fail the same way. Oldest entry out first.
 */
function cachedBuilder(webpageId, hash) {
    const key = `${webpageId}:${hash}`;
    return async (opts) => {
        if (bundleCache.has(key)) {
            const hit = bundleCache.get(key);
            bundleCache.delete(key);
            bundleCache.set(key, hit);
            if (hit.error) throw hit.error;
            return hit.result;
        }
        let entry;
        try {
            entry = { result: await buildReactBundle(opts) };
        } catch (error) {
            entry = { error };
        }
        bundleCache.set(key, entry);
        while (bundleCache.size > BUNDLE_CACHE_MAX) bundleCache.delete(bundleCache.keys().next().value);
        if (entry.error) throw entry.error;
        return entry.result;
    };
}

async function composeReactDraft(webpageId, extras, headScripts) {
    const files = {};
    const assetMap = {};
    for (const f of extras) {
        if (f.isText) files[f.path] = { isText: true, content: f.content };
        else {
            files[f.path] = { isText: false, dataUrl: f.dataUrl };
            assetMap[f.path] = f.dataUrl;
        }
    }
    if (!files[REACT_ENTRY]) return { status: 'empty' };
    const build = cachedBuilder(webpageId, hashFiles(files));
    const composed = await composeReactDoc({ files, assetMap, headScripts, build });
    if (composed.buildError) return { status: 'build_error', buildError: composed.buildError };
    return { status: 'ready', html: composed.doc };
}

/**
 * @param {object} opts
 * @param {object} opts.webpage      the page row (owner in `userId`)
 * @param {{html:string,css:string,js:string}} opts.slots  what the caller may read
 * @param {string} opts.headScripts  the bridges to bake into <head>
 * @returns {Promise<{ status:'ready'|'empty'|'stranded'|'build_error', html:string|null,
 *   buildError:string|null, framework:string, runtime:string }>}
 */
async function buildDraftDocument({ webpage, slots, headScripts }) {
    const framework = resolveFramework(webpage);
    const runtime = resolveRuntime(webpage);
    const extras = await loadExtras(webpage.id, webpage.userId);
    let out;
    if (framework === 'react-mui') out = await composeReactDraft(webpage.id, extras, headScripts);
    else if (hasReactSource(extras)) out = { status: 'stranded' };
    else out = { status: 'ready', html: composeVanillaDocument(slots, { extras, headScripts }) };
    return { html: null, buildError: null, ...out, framework, runtime };
}

module.exports = {
    buildDraftDocument,
    composeVanillaDocument,
    // test/lockstep
    _internals: { inlineStylesheet, inlineScript, inlineDataUrl, bundleCache, BUNDLE_CACHE_MAX },
};
