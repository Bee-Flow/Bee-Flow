'use strict';

/**
 * The seam to the suggestion engine (agent-hub/src/editor/suggest, bundled into
 * core/markdown/editorCollab.cjs): hunksFrom, anchorsForFragment, applyHunks,
 * hunkWords. Everything in core/documents/suggestions and the document tools
 * reach the engine through `engine()`, so tests inject a fake and a server
 * whose bundle predates the engine fails with a clear message, not a
 * TypeError somewhere deep.
 *
 * The HTML <-> AST conversion the engine works on comes from core/markdown
 * (the same serialisation core the editor uses).
 */

const NAMES = ['hunksFrom', 'anchorsForFragment', 'applyHunks', 'hunkWords'];

/**
 * What applyHunks resolves an anchor's relative positions with: positions in
 * the live fragment (core/collab withFragment), so a suggestion finds its
 * passage even after colleagues moved or duplicated the text around it.
 */
function relResolver(bundle, fragment, ydoc) {
    return {
        toRel: () => null,
        fromRel: (b64) => {
            const rel = bundle.decodeRelpos(b64);
            const pos = rel ? bundle.posFromRelative(fragment, ydoc, rel) : null;
            return pos ? { path: pos.path, offset: pos.offset } : null;
        },
    };
}

let cached = null;
let override = null;

function load() {
    const bundle = require('../../markdown/editorCollab.cjs');
    const missing = NAMES.filter((n) => typeof bundle[n] !== 'function');
    if (missing.length) throw new Error(`[Suggestions] the editor bundle has no ${missing.join(', ')}; rebuild it with npm run build:editor-collab`);
    const md = require('../../markdown');
    return {
        hunksFrom: bundle.hunksFrom, anchorsForFragment: bundle.anchorsForFragment,
        applyHunks: bundle.applyHunks, hunkWords: bundle.hunkWords,
        htmlToAst: md.htmlToAst, astToHtml: md.astToHtml,
        relResolver: (fragment, ydoc) => relResolver(bundle, fragment, ydoc),
    };
}

/** @returns {{ hunksFrom: Function, anchorsForFragment: Function, applyHunks: Function, hunkWords: Function, htmlToAst: (html: string) => any, astToHtml: (ast: any) => string, relResolver?: (fragment: any, ydoc: any) => any }} */
function engine() {
    if (override) return override;
    if (!cached) cached = load();
    return cached;
}

/** Test seam: pass a fake engine, or nothing to restore the real one. */
function _setEngine(fake) {
    override = fake || null;
}

module.exports = { engine, _setEngine };
