// @typecheck
/**
 * The inliners of a webpage PREVIEW document and its selection relay: the
 * sandboxed, opaque-origin preview iframe cannot fetch the project's other
 * files, so every <link>/<script>/src/href that names one is replaced by its
 * content or a data: URL. One source for the web editor's preview
 * (agent-hub/src/utils/composeWebpageDocument.js, through the generated mirror
 * agent-hub/src/shared/webpage/) and the server's draft document for the phone
 * (services/webpageDraftDocument.js).
 *
 * Plain functions over strings, no imports and no platform API: the base64
 * step of inlineExtras is passed in (btoa in the browser, Buffer on the server).
 *
 * Edit this file, never the mirror; then run `npm run gen:shared`.
 * server/shared/webpage/previewDocument.pin.test.mjs pins every document built
 * from it.
 */

export function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/**
 * Defang any `</script` sequence inside JS content so it can't terminate the
 * wrapping inline `<script>` block. The HTML parser ends the script element
 * at the literal `</script` (case-insensitive); `<\/script` is byte-different
 * to the parser but identical at runtime (the leading `\` before `/` is
 * meaningless inside a JS string literal). Without this, an AI-generated
 * markdown renderer that mentions `</script>` in a regex, string or comment
 * silently breaks the entire page with a SyntaxError around the truncation
 * point.
 */
export function defangScriptClose(jsContent) {
    return String(jsContent || '').replace(/<\/script/gi, '<\\/script');
}

/**
 * The selection-relay script: posts the user's text selection up to the parent
 * window via postMessage. Extracted so the react-mui preview pipeline
 * (buildWebpagePreview.js) can reuse the exact same bridge.
 */
export function buildSelectionBridgeScript() {
    return `<script>(function(){
  function relay(){
    try {
      var sel = window.getSelection && window.getSelection();
      var text = sel && sel.toString ? sel.toString() : '';
      if (!text || !text.trim()) return;
      var anchor = sel && sel.anchorNode;
      var el = anchor && anchor.nodeType === 3 ? anchor.parentElement : (anchor || null);
      var tagName = el && el.tagName ? el.tagName.toLowerCase() : null;
      var className = el && el.className && typeof el.className === 'string' ? el.className.slice(0, 120) : null;
      var id = el && el.id ? String(el.id).slice(0, 120) : null;
      parent.postMessage({
        __beeflowWebpageSelection: true,
        text: text.slice(0, 4000),
        tagName: tagName,
        className: className,
        elementId: id
      }, '*');
    } catch(_){}
  }
  document.addEventListener('mouseup', relay, true);
  document.addEventListener('keyup', function(e){
    if (e.shiftKey || e.ctrlKey || e.metaKey) relay();
  }, true);
})();<\/script>`;
}

/**
 * Replace every <link rel="stylesheet" href="path"> in `html` whose href
 * matches `targetPath` with an inline <style> block. Idempotent — won't
 * replace tags that have already been substituted because we look for the
 * literal href= pattern.
 */
export function inlineStylesheet(html, targetPath, css) {
    const re = new RegExp(`<link\\b[^>]*\\bhref\\s*=\\s*["']${escapeRegExp(targetPath)}["'][^>]*>`, 'gi');
    // Use the function-form replacer so `$` chars in `css` aren't interpreted
    // as String.replace backreferences ($&, $', $`, $1-$9).
    return html.replace(re, () => `<style>\n${css}\n</style>`);
}

/**
 * Replace every <script src="path"></script> in `html` whose src matches
 * `targetPath` with an inline <script> block. The user-supplied JS body
 * gets defanged so any embedded `</script` token can't escape the wrapper.
 */
export function inlineScript(html, targetPath, js) {
    const re = new RegExp(`<script\\b[^>]*\\bsrc\\s*=\\s*["']${escapeRegExp(targetPath)}["'][^>]*>\\s*<\\/script>`, 'gi');
    const replacement = `<script>\n${defangScriptClose(js)}\n<\/script>`;
    // Function-form replacer — JS bodies routinely contain `$` (template
    // literals, KaTeX delimiters, regexes). The string form would interpret
    // those as backreferences and silently corrupt the inlined script.
    return html.replace(re, () => replacement);
}

/**
 * Replace every src="path" / href="path" attribute (on any tag) with a
 * data: URL. Used for binary assets so <img src="logo.png"> renders inside
 * the sandbox-without-same-origin iframe where relative URLs would otherwise
 * fail to resolve.
 */
export function inlineDataUrl(html, targetPath, dataUrl) {
    const reHref = new RegExp(`(\\bhref\\s*=\\s*["'])${escapeRegExp(targetPath)}(["'])`, 'gi');
    const reSrc = new RegExp(`(\\bsrc\\s*=\\s*["'])${escapeRegExp(targetPath)}(["'])`, 'gi');
    // dataUrl is base64 but the surrounding HTML segments could contain `$`;
    // use the function form for the same reason as inlineScript above.
    return html
        .replace(reHref, (_match, p1, p2) => `${p1}${dataUrl}${p2}`)
        .replace(reSrc, (_match, p1, p2) => `${p1}${dataUrl}${p2}`);
}

/**
 * Inline a project's extra files into `html`, in two passes so that earlier
 * text inlining does not swallow other references: first the text files a
 * <link>/<script> tag names, then a data: URL for every src/href still
 * pointing at a file. `toBase64(text)` encodes a text file's UTF-8 bytes.
 */
export function inlineExtras(html, extraFiles, toBase64) {
    let working = html;
    if (!Array.isArray(extraFiles) || extraFiles.length === 0) return working;
    // Pass 1: text files referenced by <link>/<script> tags.
    for (const f of extraFiles) {
        if (!f || !f.path) continue;
        if (f.isText && typeof f.content === 'string') {
            if (/\.css$/i.test(f.path)) {
                working = inlineStylesheet(working, f.path, f.content);
            } else if (/\.m?js$/i.test(f.path)) {
                working = inlineScript(working, f.path, f.content);
            }
        }
    }
    // Pass 2: data URLs for everything that's left referenced (binaries +
    // any text file referenced as src/href that wasn't a stylesheet/script).
    for (const f of extraFiles) {
        if (!f || !f.path) continue;
        if (f.dataUrl) {
            working = inlineDataUrl(working, f.path, f.dataUrl);
        } else if (f.isText && typeof f.content === 'string') {
            // e.g. <img src="icon.svg"> when the file is an SVG.
            const mime = f.mimeType || 'text/plain';
            working = inlineDataUrl(working, f.path, `data:${mime};base64,${toBase64(f.content)}`);
        }
    }
    return working;
}
