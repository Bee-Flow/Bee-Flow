/**
 * Presentation Renderer — a deck in, a real .pptx (or a PDF deck) out.
 *
 * The twin of documentRenderer.renderDocument for presentations, and the ONE
 * function every surface calls: the chat tool, the Nextcloud tool, the
 * automation `presentation` step and the App Studio step all hand their input
 * here and get the same file back for the same deck. What lives here is
 * everything a renderer needs that the pure builders must not know:
 *
 *   - the deck model      → core/documents/deckModel.js normalizeDeck
 *   - the org's theme     → core/documents/documentHouseStyle.js deckThemeFor
 *   - image bytes         → a caller-injected resolver (ownership is the
 *                           caller's knowledge, not this module's) plus sharp
 *                           for the formats PowerPoint cannot show
 *   - the AI-Act marking  → flattened into what officegen / the PDF path write
 *   - the two formats     → integrations/officegen.js buildPresentation (.pptx)
 *                           or documentRenderer.renderDeckPdf (PDF)
 *
 * NOTHING HERE FETCHES. A slide image is a data: URL or a Bee Flow storage
 * object the resolver may read; an http(s) reference was already dropped by
 * the deck model with a warning. A deck is untrusted content on its way into
 * two libraries that would happily fetch on its behalf, and a fetch from the
 * server is an SSRF primitive.
 */

const { normalizeDeck, DeckError } = require('../core/documents/deckModel');
const { deckThemeFor, DEFAULT_DECK_THEME } = require('../core/documents/documentHouseStyle');
const log = require('../telemetry/log');

const PPTX_IMAGE_RE = /^data:image\/(png|jpeg);base64,/;
const RASTER_IMAGE_RE = /^data:image\/(png|jpeg|jpg|webp|gif|svg\+xml);base64,/;
// A slide image at 2× a 16:9 slide's width is already more than a projector shows.
const MAX_IMAGE_EDGE_PX = 1920;

/**
 * Bring any accepted data: image to PNG/JPEG. SVG (pptxgenjs writes it as a
 * broken "png preview"), WebP and GIF (not PowerPoint image types) are
 * rasterised with sharp; PNG/JPEG pass through untouched. Returns null when
 * the bytes cannot be made presentable.
 */
async function toPptxImage(dataUrl, { maxEdge = MAX_IMAGE_EDGE_PX, width = null } = {}) {
    const s = String(dataUrl || '').replace(/\s+/g, '');
    if (PPTX_IMAGE_RE.test(s) && !width) return s;
    if (!RASTER_IMAGE_RE.test(s)) return null;
    let sharp;
    try { sharp = require('sharp'); } catch { return PPTX_IMAGE_RE.test(s) ? s : null; }
    try {
        const input = Buffer.from(s.slice(s.indexOf(',') + 1), 'base64');
        const isSvg = /^data:image\/svg\+xml/.test(s);
        const resize = width ? { width } : { width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true };
        const png = await sharp(input, isSvg ? { density: 288 } : {}).resize(resize).png().toBuffer();
        return `data:image/png;base64,${png.toString('base64')}`;
    } catch (e) {
        log.warn(`[presentationRenderer] image could not be rasterised: ${e.message}`);
        return null;
    }
}

/**
 * The resolver a chat/Nextcloud caller injects: reads a user's own storage
 * objects (by key or by the proxy URL the chat hands out) and passes data:
 * URLs through. Anything else is null — never a fetch.
 */
function makeUserImageResolver(userId) {
    const own = `users/${String(userId || '')}/`;
    return async function resolveImage(ref) {
        if (!ref || typeof ref !== 'object') return null;
        if (ref.dataUrl) return String(ref.dataUrl);
        const key = ref.storageKey ? String(ref.storageKey) : null;
        if (!key || !userId) return null;
        if (key.includes('\\') || key.includes('\0') || key.split('/').some((seg) => seg === '..')) return null;
        if (!key.startsWith(own)) return null;
        const { readAsDataUrl } = require('../core/documents/imageInline');
        try { return await readAsDataUrl(key); } catch (e) {
            log.warn(`[presentationRenderer] storage image ${key} unreadable: ${e.message}`);
            return null;
        }
    };
}

/**
 * A logo exported on a white card (a JPEG, a flattened PNG) sits as a white
 * box on an accent or dark slide. This knocks the card out: every near-white
 * pixel REACHABLE FROM THE EDGES becomes transparent — a flood fill, so
 * white inside the mark (a letter's counter, a highlight) is kept. Images
 * that already carry transparency, or whose corners are not white, are
 * returned untouched.
 */
async function knockoutWhiteBackground(dataUrl, { tolerance = 18 } = {}) {
    let sharp;
    try { sharp = require('sharp'); } catch { return dataUrl; }
    try {
        const s = String(dataUrl || '');
        const input = Buffer.from(s.slice(s.indexOf(',') + 1), 'base64');
        const img = sharp(input).ensureAlpha();
        const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
        const { width: w, height: h, channels } = info;
        if (channels !== 4 || w < 2 || h < 2) return dataUrl;
        const at = (x, y) => (y * w + x) * 4;
        const white = (i) => data[i] >= 255 - tolerance && data[i + 1] >= 255 - tolerance && data[i + 2] >= 255 - tolerance && data[i + 3] > 200;
        // Only a card: all four corners white, and no real transparency yet.
        const corners = [at(0, 0), at(w - 1, 0), at(0, h - 1), at(w - 1, h - 1)];
        if (!corners.every(white)) return dataUrl;
        let opaque = 0;
        for (let i = 3; i < data.length; i += 4) if (data[i] > 200) opaque += 1;
        if (opaque < data.length / 4 * 0.98) return dataUrl;
        const seen = new Uint8Array(w * h);
        const stack = [];
        for (let x = 0; x < w; x += 1) { stack.push(x, 0, x, h - 1); }
        for (let y = 0; y < h; y += 1) { stack.push(0, y, w - 1, y); }
        let cleared = 0;
        while (stack.length) {
            const y = stack.pop(); const x = stack.pop();
            if (x < 0 || y < 0 || x >= w || y >= h) continue;
            const idx = y * w + x;
            if (seen[idx]) continue;
            seen[idx] = 1;
            const i = idx * 4;
            if (!white(i)) continue;
            data[i + 3] = 0;
            cleared += 1;
            stack.push(x + 1, y, x - 1, y, x, y + 1, x, y - 1);
        }
        if (!cleared) return dataUrl;
        const png = await sharp(data, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
        return `data:image/png;base64,${png.toString('base64')}`;
    } catch (e) {
        log.warn(`[presentationRenderer] logo knockout skipped: ${e.message}`);
        return dataUrl;
    }
}

/**
 * The width/height ratio of a data: image, measured — pptxgenjs' own
 * `sizing:'contain'` fits an image with a NEGATIVE srcRect crop, which
 * Collabora/LibreOffice ignore and then stretch the picture to its box. So
 * the renderer measures, and officegen sizes every box from the ratio.
 */
async function imageAspect(dataUrl) {
    try {
        const sharp = require('sharp');
        const s = String(dataUrl || '');
        const meta = await sharp(Buffer.from(s.slice(s.indexOf(',') + 1), 'base64')).metadata();
        return meta.width && meta.height ? meta.width / meta.height : null;
    } catch {
        return null;
    }
}

/**
 * Resolve every slide image — and every card picture — to a PNG/JPEG data:
 * URL, degrading what cannot be had; rasterise the icons cards and tiles
 * name (for pptxgenjs; the PDF draws them as SVG from the same names).
 */
async function resolveDeckImages(deck, resolveImage, warnings, theme = null) {
    const { iconPng } = require('../core/documents/deckIcons');
    const iconColour = theme && theme.accentOnSlide ? theme.accentOnSlide : '#123A5E';
    for (const [i, s] of deck.slides.entries()) {
        for (const c of [...(s.cards || []), ...(s.stats || [])]) {
            if (c.icon) c.iconDataUrl = await iconPng(c.icon, iconColour, 192);
            if (!c.image) continue;
            let url = c.image.dataUrl || null;
            if (!url && typeof resolveImage === 'function') { try { url = await resolveImage(c.image); } catch { url = null; } }
            const ready = url ? await toPptxImage(url, { maxEdge: 1200 }) : null;
            if (ready) c.image = { dataUrl: ready, alt: c.image.alt || '', aspect: await imageAspect(ready) };
            else { warnings.push(`slide ${i + 1}: a card picture could not be resolved and was left out`); c.image = null; }
        }
        if (!s.image) continue;
        let dataUrl = s.image.dataUrl || null;
        if (!dataUrl && typeof resolveImage === 'function') {
            try { dataUrl = await resolveImage(s.image); } catch (e) { dataUrl = null; warnings.push(`slide ${i + 1}: image could not be read (${e.message})`); }
        }
        const ready = dataUrl ? await toPptxImage(dataUrl) : null;
        if (ready) {
            s.image = { dataUrl: ready, alt: s.image.alt || '', aspect: await imageAspect(ready) };
        } else {
            if (dataUrl === null || dataUrl === undefined) warnings.push(`slide ${i + 1}: the image could not be resolved and was left out`);
            else warnings.push(`slide ${i + 1}: the image format is not supported on a slide and was left out`);
            s.image = null;
            if (s.layout === 'image') s.layout = s.bullets.length || s.body ? 'bullets' : 'section';
        }
    }
}

/**
 * The logo as PNG at a size that stays crisp in the footer and on the cover.
 * A per-deck logo REFERENCE (theme.logoRef — a storage key or proxy URL) is
 * read through the caller's resolver, like a slide image; when it cannot be
 * had the deck simply carries no logo and says so.
 */
async function prepareTheme(theme, resolveImage = null, warnings = []) {
    const t = { ...theme };
    if (t.logoRef && !t.logoDataUrl) {
        const { classifyImageRef } = require('../core/documents/deckModel');
        const ref = classifyImageRef(t.logoRef);
        let dataUrl = null;
        if (ref && !ref.rejected && typeof resolveImage === 'function') {
            try { dataUrl = await resolveImage(ref); } catch (e) { warnings.push(`the deck logo could not be read (${e.message})`); }
        } else if (ref && ref.rejected) {
            warnings.push('the deck logo must be a Bee Flow storage URL or a data: URL — it was left out');
        }
        if (dataUrl) t.logoDataUrl = dataUrl;
        else { if (ref && !ref.rejected) warnings.push('the deck logo could not be resolved and was left out'); t.logoPlacement = 'none'; }
        delete t.logoRef;
    }
    if (t.logoDataUrl) {
        const px = Math.round(t.logoWidthIn * 96 * 2.5);
        const ready = await toPptxImage(t.logoDataUrl, { width: px });
        t.logoDataUrl = ready ? await knockoutWhiteBackground(ready) : '';
        if (!ready) { warnings.push('the deck logo is not an image format a slide can show — it was left out'); t.logoPlacement = 'none'; }
        else t.logoAspect = await imageAspect(t.logoDataUrl);
    }
    return t;
}

/**
 * Flatten the compliance marking into what the builders write. Same rule as
 * renderDocument: a marking that is switched off or has no footer sentence is
 * no marking at all.
 */
function flattenMarking(marking) {
    if (!marking || marking.enabled === false) return null;
    const { AI_MARK_SUBJECT, markingKeywords, markingText } = require('./documentRenderer');
    const line = markingText(marking);
    if (!line) return null;
    return {
        subject: AI_MARK_SUBJECT,
        creator: String(marking.org_name || ''),
        keywords: markingKeywords(marking),
        description: line,
        footerLine: line,
    };
}

/**
 * Render a presentation.
 *
 * @param {object} args
 * @param {object|string} [args.deck]      a normalised deck, a raw JSON deck, or a markdown outline
 * @param {string} [args.content]          markdown outline (alternative to `deck`)
 * @param {'pptx'|'pdf'|'html'} [args.format]  html = the on-screen slide viewer (documentRenderer, mode 'screen')
 * @param {string} [args.title]            overrides the deck's cover title
 * @param {string} [args.author]
 * @param {string} [args.date]
 * @param {string|null} [args.orgId]       whose house style; null = neutral
 * @param {boolean} [args.houseStyle]      false = the neutral theme (the user's opt-out)
 * @param {object|null} [args.theme]       per-deck look overrides (deckThemeOptions: preset, accent, background, font, coverStyle, tableStyle, logo, logoPlacement, footerText…)
 * @param {object|null} [args.marking]     compliance marking (compliance/marking.js shape) or null
 * @param {Function} [args.resolveImage]   async (imageRef) => data: URL | null
 * @returns {Promise<{buffer:Buffer, contentType:string, format:string, extension:string, slideCount:number,
 *   warnings:string[], degraded:boolean, marking:null|{visible:boolean,metadata:boolean}, houseStyle:boolean}>}
 */
async function renderPresentation({
    deck = null, content = null, format = 'pptx', title = '', author = '', date = '',
    orgId = null, houseStyle = true, theme: overrides = null, marking = null, resolveImage = null,
} = {}) {
    const fmt = format === 'pdf' ? 'pdf' : (format === 'html' ? 'html' : 'pptx');
    const input = deck !== null && deck !== undefined ? deck : content;
    let normalized;
    try {
        normalized = input && typeof input === 'object' && input.normalized ? input : normalizeDeck(input);
    } catch (e) {
        if (e instanceof DeckError) throw Object.assign(new Error(e.message), { errorClass: e.errorClass === 'deck_empty' ? 'document_empty' : e.errorClass, cause: e });
        throw e;
    }
    const warnings = [...(normalized.warnings || [])];

    const rawTheme = await deckThemeFor(orgId, { houseStyle: houseStyle !== false, overrides });
    const theme = await prepareTheme(rawTheme, resolveImage, warnings);
    await resolveDeckImages(normalized, resolveImage, warnings, theme);
    const flat = flattenMarking(marking);
    const coverTitle = String(title || normalized.title || '').trim();

    if (fmt === 'html') {
        // The viewer: no bytes, the same slides. Notes are not shown (a viewer
        // is not a presenter view) and the marking rides in the footer line.
        const { deckToSlidesHtml } = require('./documentRenderer');
        const html = deckToSlidesHtml(normalized, { theme, marking, date, title: coverTitle, mode: 'screen' });
        return {
            html, contentType: 'text/html; charset=utf-8', format: 'html', extension: 'html',
            slideCount: normalized.slides.length + 1, warnings, degraded: false,
            marking: flat ? { visible: true, metadata: false } : null, houseStyle: !!theme.enabled, deck: normalized,
        };
    }
    if (fmt === 'pdf') {
        const { renderDeckPdf } = require('./documentRenderer');
        const out = await renderDeckPdf({ deck: normalized, theme, title: coverTitle, marking, date });
        return {
            ...out, slideCount: normalized.slides.length + 1, warnings,
            houseStyle: !!theme.enabled, deck: normalized,
        };
    }

    const officegen = require('../integrations/officegen');
    const out = await officegen.buildPresentation({ deck: normalized, theme, title: coverTitle, author, date, marking: flat });
    return {
        buffer: out.buffer, contentType: out.contentType, format: 'pptx', extension: 'pptx',
        slideCount: out.slideCount, warnings, degraded: false,
        marking: flat ? { visible: true, metadata: true } : null,
        houseStyle: !!theme.enabled,
        // The normalised deck, so a caller can keep the outline (deckToMarkdown).
        deck: normalized,
    };
}

module.exports = {
    renderPresentation,
    makeUserImageResolver,
    toPptxImage,
    imageAspect,
    knockoutWhiteBackground,
    DEFAULT_DECK_THEME,
    _test: { resolveDeckImages, prepareTheme, flattenMarking },
};
