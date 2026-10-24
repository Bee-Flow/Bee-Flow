// @typecheck
/**
 * Export Template — builds a professional HTML document for PDF rendering.
 *
 * Wraps notebook HTML content in a print-ready layout with:
 *  - Optional cover page with title, date, author
 *  - Page headers (title) and footers (page numbers)
 *  - Clean typography, proper heading hierarchy
 *  - Print-optimized CSS (page breaks, orphans/widows)
 */

const fs = require('fs');
const path = require('path');

const { EXPORT_CSS, EXPORT_MERMAID_FALLBACK_SCRIPT } = require('./exportTemplateParts');

// Load and cache the Bee Flow logo as base64 for PDF embedding
let _logoDataUri = null;
function getLogoDataUri() {
    if (_logoDataUri) return _logoDataUri;
    try {
        const logoPath = path.resolve(__dirname, '../assets/brand/BeeFlow-logo-Icon-2026.svg');
        const svgContent = fs.readFileSync(logoPath, 'utf8');
        _logoDataUri = `data:image/svg+xml;base64,${Buffer.from(svgContent).toString('base64')}`;
    } catch {
        _logoDataUri = '';
    }
    return _logoDataUri;
}

function buildExportHTML(content, { title = 'Untitled', author = '', date = '' } = {}) {
    const formattedDate = date || new Date().toLocaleDateString('en-US', {
        year: 'numeric', month: 'long', day: 'numeric'
    });
    const logoUri = getLogoDataUri();

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
${EXPORT_CSS}
</style>
</head>
<body>
    <!-- Cover page -->
    <div class="cover-page">
        <h1 class="cover-title">${escapeHtml(title)}</h1>
        <div class="cover-divider"></div>
        <div class="cover-meta">
            ${author ? `<div><span class="meta-label">Author</span> ${escapeHtml(author)}</div>` : ''}
            <div><span class="meta-label">Date</span> ${escapeHtml(formattedDate)}</div>
        </div>
        <div class="cover-branding">
            ${logoUri ? `<img src="${logoUri}" class="bee-logo" alt="Bee Flow" />` : '<span class="bee-mark">🐝</span>'}
            Generated with Bee Flow
        </div>
    </div>

    <!-- Document content -->
    <div class="document-body">
        ${content}
    </div>

    <!-- Mermaid: the client pre-renders diagrams to images. One that arrives un-rendered stays a code block
         (no external script: the export must work on a server without outbound internet). -->
    <script>
${EXPORT_MERMAID_FALLBACK_SCRIPT}
    </script>
</body>
</html>`;
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * Strip anything active or network-reaching from document HTML before it is
 * rendered by the export pipeline.
 *
 * This is the security half of the export path. The HTML arrives in a request
 * body and is loaded into a real, networked Chromium (Playwright) to make the
 * PDF. Without this, that page could run script, and could reach out over the
 * network from INSIDE the cluster — `<img src="http://169.254.169.254/…">`,
 * `<iframe src="http://internal-service/">` — turning "export my notebook" into
 * a server-side request forge and a data-exfiltration channel.
 *
 * Deliberately conservative: an exported document needs no script, no frames,
 * no external stylesheets, and no remote assets (the client already inlines
 * images as data: URLs before sending). Anything it does need is inert markup.
 */
function sanitizeContentForExport(html) {
    let s = String(html || '');

    // Executable / embedding elements, content and all.
    s = s.replace(/<script[\s\S]*?<\/script\s*>/gi, '');
    s = s.replace(/<style[\s\S]*?<\/style\s*>/gi, '');
    s = s.replace(/<(iframe|frame|frameset|object|embed|applet|template|noscript)\b[\s\S]*?<\/\1\s*>/gi, '');
    s = s.replace(/<(iframe|frame|frameset|object|embed|applet|link|meta|base|form|input|button|textarea|select|audio|video|source|track)\b[^>]*\/?>/gi, '');

    // Inline event handlers, quoted and unquoted.
    s = s.replace(/\s+on[a-z]+\s*=\s*"[^"]*"/gi, '');
    s = s.replace(/\s+on[a-z]+\s*=\s*'[^']*'/gi, '');
    s = s.replace(/\s+on[a-z]+\s*=\s*[^\s>]+/gi, '');

    // Active URL schemes anywhere they can appear.
    s = s.replace(/(href|src|xlink:href)\s*=\s*"(?:\s*)(?:javascript|vbscript|data:text\/html)[^"]*"/gi, '$1="#"');
    s = s.replace(/(href|src|xlink:href)\s*=\s*'(?:\s*)(?:javascript|vbscript|data:text\/html)[^']*'/gi, "$1='#'");

    // Remote asset loads. The client inlines images as data: URLs before
    // exporting, so a remaining http(s) src is either a tracking pixel or an
    // attempt to make the renderer fetch something for the caller.
    s = s.replace(/(<img\b[^>]*?)\ssrc\s*=\s*"https?:\/\/[^"]*"/gi, '$1 src=""');
    s = s.replace(/(<img\b[^>]*?)\ssrc\s*=\s*'https?:\/\/[^']*'/gi, "$1 src=''");

    // CSS that can fetch or execute, in any surviving style="" attribute.
    s = s.replace(/style\s*=\s*"([^"]*)"/gi, (m, css) => `style="${css.replace(/(url\s*\(|expression\s*\(|@import|behavior\s*:)/gi, '')}"`);
    s = s.replace(/style\s*=\s*'([^']*)'/gi, (m, css) => `style='${css.replace(/(url\s*\(|expression\s*\(|@import|behavior\s*:)/gi, '')}'`);

    return s;
}

/**
 * Clean notebook HTML for export — strip editor-specific markup,
 * preserve content styles (image widths, text colors, table widths).
 */
function cleanContentForExport(html) {
    // Sanitize FIRST: everything below is cosmetic normalisation that assumes
    // the markup is already inert.
    let cleaned = sanitizeContentForExport(html);

    // ── Table fixes ────────────────────────────────────────────
    // Remove column-resize-handle divs (TipTap editor artifact)
    cleaned = cleaned.replace(/<div[^>]*class="column-resize-handle"[^>]*>(<\/div>)?/gi, '');

    // Remove selectedCell class (editor selection state)
    cleaned = cleaned.replace(/\s*selectedCell/gi, '');

    // Strip <colgroup>...</colgroup> — TipTap adds these with min-width styles
    // that confuse html-to-docx and cause single-character-wide columns
    cleaned = cleaned.replace(/<colgroup[\s\S]*?<\/colgroup>/gi, '');

    // Convert TipTap data-colwidth to HTML width attributes on td/th
    // html-to-docx reads HTML width="" attributes, NOT CSS style widths
    cleaned = cleaned.replace(/<(t[dh])([^>]*?)data-colwidth="(\d+)"([^>]*?)>/gi, (match, tag, before, width, after) => {
        // Remove the data-colwidth and add HTML width attribute instead
        const cleanBefore = before.replace(/data-colwidth="\d+"\s*/gi, '');
        const cleanAfter = after.replace(/data-colwidth="\d+"\s*/gi, '');
        return `<${tag}${cleanBefore}${cleanAfter} width="${width}">`;
    });

    // Unwrap tableWrapper divs — TipTap wraps <table> in <div class="tableWrapper">
    cleaned = cleaned.replace(/<div[^>]*class="[^"]*tableWrapper[^"]*"[^>]*>/gi, '');
    // Remove closing div that was the tableWrapper
    cleaned = cleaned.replace(/(<table[\s\S]*?<\/table>)\s*<\/div>/gi, '$1');

    // Ensure table has width="100%" and border for DOCX compatibility
    cleaned = cleaned.replace(/<table(?![^>]*width=)/gi, '<table width="100%" border="1" cellpadding="6" cellspacing="0" style="border-collapse: collapse;"');

    // ── General cleanup ────────────────────────────────────────
    // Remove TipTap/ProseMirror editor-specific classes
    cleaned = cleaned.replace(/\s*class="(ProseMirror|tiptap|is-editor-empty|is-empty|has-focus|resizable-image-wrapper|resizable-image-container|notebook-image|resize-handle|resize-width-indicator)[^"]*"/gi, '');

    // Remove data attributes except the ones the export itself consumes
    // downstream (table-related ones are already converted above).
    //
    // `data-code` MUST be in this list: the in-page mermaid pass below reads it
    // to get the diagram source. Stripping it here left an empty div, so every
    // mermaid diagram silently vanished from exported PDFs and DOCX files —
    // the code that renders them ran after the code that erased their input.
    // `data-latex` / `data-spec` / `data-formula` are kept for the same reason:
    // they are content, not editor chrome.
    cleaned = cleaned.replace(/\s*data-(?!type|checked|code|latex|spec|formula)[a-z-]+="[^"]*"/gi, '');

    // Remove contenteditable attributes
    cleaned = cleaned.replace(/\s*contenteditable="[^"]*"/gi, '');

    // Remove draggable attributes
    cleaned = cleaned.replace(/\s*draggable="[^"]*"/gi, '');

    // Clean up empty class attributes
    cleaned = cleaned.replace(/\s*class=""/g, '');

    // Clean up resize handle divs
    cleaned = cleaned.replace(/<div class="resize-handle[^"]*"><\/div>/gi, '');

    // Clean up width indicator divs
    cleaned = cleaned.replace(/<div class="resize-width-indicator">[^<]*<\/div>/gi, '');

    // ── Mermaid diagram fallback for DOCX ──────────────────────
    // Convert unrendered mermaid diagram divs to styled code blocks
    // (DOCX cannot execute JS, so diagrams must be pre-rendered to images by the client)
    cleaned = cleaned.replace(/<div[^>]*data-type="mermaid-diagram"[^>]*data-code="([^"]*?)"[^>]*>.*?<\/div>/gi, (match, encodedCode) => {
        let code;
        try {
            code = decodeURIComponent(escape(Buffer.from(encodedCode, 'base64').toString('binary')));
        } catch {
            code = encodedCode
                .replace(/&amp;/g, '&')
                .replace(/&lt;/g, '<')
                .replace(/&gt;/g, '>')
                .replace(/&quot;/g, '"');
        }
        // Render as a styled code block with diagram label
        const escaped = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        return `<div style="margin:12pt 0;page-break-inside:avoid;">
            <div style="background:#eef2ff;border:1pt solid #c7d2fe;border-radius:6pt;padding:4pt 10pt;font-size:9pt;font-weight:600;color:#4338ca;">📊 Diagram</div>
            <pre style="background:#f8fafc;border:1pt solid #e2e8f0;border-radius:0 0 6pt 6pt;padding:10pt 14pt;font-size:9pt;color:#334155;white-space:pre-wrap;margin:0;">${escaped}</pre>
        </div>`;
    });

    return cleaned;
}

module.exports = { buildExportHTML, cleanContentForExport, sanitizeContentForExport, escapeHtml };
