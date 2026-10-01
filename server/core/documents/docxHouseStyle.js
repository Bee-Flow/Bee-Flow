/**
 * Word (.docx) house style — the organisation's "kantoorstijl" applied to a
 * document built with html-to-docx.
 *
 * Not to be confused with core/documents/documentHouseStyle.js: that one is
 * the letterhead of rendered Documents and decks (CSS custom properties, a
 * logo). This one is the uploaded Word template's metadata
 * (`org_house_styles.style_meta`: fonts, heading sizes, margins, header and
 * footer text) turned into the CSS block and html-to-docx options a .docx is
 * built with.
 *
 * Two callers, one source: the notebook export route
 * (routes/notebookExport.js, a button) and the chat's `create_word_document`
 * tool (integrations/wordDocumentTools.js). Moved here from the export route
 * so the tool does not reach into a route file.
 */

const houseStyleStore = require('../../stores/houseStyleStore');

/** resolveHouseStyle's answer for an explicit id that names no style of this org. */
const NO_SUCH_STYLE = Symbol('no such house style');

function escapeHtml(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * Resolve the house style to apply to a .docx.
 *   - `id === 'none'`  → no style (null)
 *   - `id === '<id>'`  → that style if it belongs to `orgId`, else NO_SUCH_STYLE
 *   - otherwise        → the org's default style, or null
 *
 * A store failure on the default lookup is "no style", never an error: a
 * document without the org's fonts is better than no document.
 *
 * @param {string|null} orgId
 * @param {string|null|undefined} id
 */
async function resolveHouseStyle(orgId, id) {
    if (id === 'none') return null;
    if (id) {
        if (!orgId) return NO_SUCH_STYLE;
        const style = await houseStyleStore.getById(id, orgId).catch(() => null);
        return style || NO_SUCH_STYLE;
    }
    if (!orgId) return null;
    return await houseStyleStore.getDefaultForOrg(orgId).catch(() => null);
}

/**
 * Font names and colours come from an uploaded Word template and are
 * interpolated into CSS and into style="…" attributes. Keep only what a font
 * name or a CSS colour needs, so a quote or an angle bracket cannot break out.
 */
function cssToken(value, fallback) {
    const v = String(value ?? '').replace(/[^\w\s#.,%()-]/g, '').trim();
    return v || fallback;
}

/** A heading's inline declarations: what html-to-docx honours on a tag. */
function headingDecl(h, defaultFont, fallbackColor) {
    const size = Number(h.size);
    return [
        `font-family:'${cssToken(h.font, defaultFont)}'`,
        Number.isFinite(size) && size > 0 ? `font-size:${size}pt` : null,
        `font-weight:${h.bold ? 'bold' : 'normal'}`,
        `color:${cssToken(h.color, fallbackColor)}`,
    ].filter(Boolean).join(';');
}

/**
 * Build a CSS block + html-to-docx options object from a house style.
 * Returns sensible defaults when style is null so callers don't branch.
 *
 * html-to-docx ignores <style> blocks: only inline style attributes and the
 * document-level options (font, fontSize, margin, header/footer) reach the
 * .docx. So the heading fonts, sizes and colours also come back as
 * `inline` — tag → declarations — for applyInlineStyles to put on the tags.
 * The CSS stays for anything that renders the HTML itself.
 *
 * @returns {{ css: string, opts: object, inline: Record<string, string> }}
 */
function buildDocxStylingFromHouseStyle(style) {
    const meta = style?.styleMeta || {};
    const defaultFont = cssToken(meta.defaultFont, 'Calibri');
    const defaultSize = Number(meta.defaultFontSize) || 11;
    const margins = meta.margins || { top: 1440, right: 1440, bottom: 1440, left: 1440 };
    const h1 = meta.headings?.h1 || { font: defaultFont, size: 20, bold: true, color: '#111111' };
    const h2 = meta.headings?.h2 || { font: defaultFont, size: 16, bold: true, color: '#1e293b' };
    const h3 = meta.headings?.h3 || { font: defaultFont, size: 13, bold: true, color: '#334155' };
    const accent = cssToken(meta.accents?.secondary, '#3b82f6');
    const hCss = (h, color) => `font-family: "${cssToken(h.font, defaultFont)}", sans-serif; font-size: ${Number(h.size) || defaultSize}pt; font-weight: ${h.bold ? 'bold' : 'normal'}; color: ${cssToken(h.color, color)};`;

    const css = `
        body { font-family: "${defaultFont}", Calibri, Arial, sans-serif; font-size: ${defaultSize}pt; line-height: 1.5; color: #1a1a1a; }
        h1 { ${hCss(h1, '#111111')} margin-top: 18pt; margin-bottom: 8pt; }
        h2 { ${hCss(h2, '#1e293b')} margin-top: 14pt; margin-bottom: 6pt; }
        h3 { ${hCss(h3, '#334155')} margin-top: 12pt; margin-bottom: 4pt; }
        p { margin-bottom: 6pt; }
        table { width: 100%; border-collapse: collapse; margin: 8pt 0; }
        th, td { border: 1pt solid #999; padding: 4pt 8pt; vertical-align: top; text-align: left; }
        th { background-color: #f0f0f0; font-weight: bold; }
        blockquote { border-left: 3pt solid ${accent}; padding: 6pt 12pt; margin: 8pt 0; background: #f8f9fa; }
        code { font-family: Consolas, monospace; font-size: 9pt; background: #f1f5f9; padding: 1pt 3pt; }
        pre { background: #f5f5f5; padding: 10pt; font-family: Consolas, monospace; font-size: 9pt; margin: 8pt 0; border: 1pt solid #ddd; }
        pre code { background: none; padding: 0; }
        ul, ol { margin-left: 0.4in; margin-bottom: 6pt; }
        li { margin-bottom: 2pt; }
        img { max-width: 100%; }
    `;

    const inline = {
        h1: headingDecl(h1, defaultFont, '#111111'),
        h2: headingDecl(h2, defaultFont, '#1e293b'),
        h3: headingDecl(h3, defaultFont, '#334155'),
    };

    const opts = {
        margin: margins,
        font: defaultFont,
        fontSize: defaultSize * 2, // html-to-docx wants half-points
    };

    // Header / footer best-effort text injection. html-to-docx takes these as
    // HTML fragments (positional arguments, see services/documentRenderer.js).
    if (meta.header?.text) {
        opts.header = true;
        opts.headerType = 'default';
        opts.headerHTML = `<p style="font-family:'${defaultFont}',sans-serif;font-size:${Math.max(8, defaultSize - 2)}pt;color:#555">${escapeHtml(meta.header.text)}</p>`;
    }
    if (meta.footer?.text) {
        opts.footer = true;
        opts.footerHTML = `<p style="font-family:'${defaultFont}',sans-serif;font-size:${Math.max(8, defaultSize - 2)}pt;color:#555">${escapeHtml(meta.footer.text)}</p>`;
    }

    return { css, opts, inline };
}

/**
 * Put `inline` (tag → declarations, from buildDocxStylingFromHouseStyle) on
 * every opening tag of that name in `html`. A style attribute the tag already
 * has is kept AFTER the house style's declarations, so it still wins.
 *
 * @param {string} html
 * @param {Record<string, string>|null|undefined} inline
 */
function applyInlineStyles(html, inline) {
    if (!inline || typeof html !== 'string') return html;
    let out = html;
    for (const [tag, decl] of Object.entries(inline)) {
        if (!/^h[1-6]$/.test(tag) || !decl) continue;
        out = out.replace(new RegExp(`<${tag}(\\s[^>]*)?>`, 'gi'), (_m, attrs = '') => {
            const m = attrs.match(/\sstyle\s*=\s*("([^"]*)"|'([^']*)')/i);
            if (!m) return `<${tag}${attrs} style="${decl}">`;
            const existing = m[2] !== undefined ? m[2] : m[3];
            const merged = `${decl};${existing}`.replace(/"/g, "'");
            return `<${tag}${attrs.replace(m[0], ` style="${merged}"`)}>`;
        });
    }
    return out;
}

module.exports = { resolveHouseStyle, buildDocxStylingFromHouseStyle, applyInlineStyles, NO_SUCH_STYLE };
