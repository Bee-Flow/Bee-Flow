// @typecheck
/**
 * A .pptx as a deck TEMPLATE — the look of somebody else's slides, reused.
 *
 * A branded template (a conference deck, a client's house deck) rarely keeps
 * its design in the slide master: it is a couple of slides carrying full-bleed
 * picture shapes (a gradient, a pattern) and a logo, with white text on top.
 * This module reads those layers out of the first slides — or, for a master-
 * based template, out of the master/layout backgrounds — and turns them into
 * what the deck engine can paint under its own content:
 *
 *   { name, cover: { image, overlays }, content: { image, overlays },
 *     background, text, fonts: { title, body } }
 *
 * `image` is ONE composited JPEG of every full-bleed layer (cropped to the
 * slide), `overlays` are the smaller pictures (a logo) with their position as
 * fractions of the slide, `background` is the composite's mean colour — what
 * the theme resolves text and chart colours against.
 *
 * The template's own text is dropped: a title on a template slide is content,
 * and the deck brings its own. Nothing is fetched; the bytes come from the
 * caller (an upload, a Nextcloud read).
 */

const JSZip = require('jszip');

const MAX_TEMPLATE_BYTES = 25 * 1024 * 1024;
const MAX_MEDIA_BYTES = 12 * 1024 * 1024;
const COMPOSITE_WIDTH = 1600;
const OVERLAY_MAX_PX = 480;
const MAX_OVERLAYS = 8;

function attr(xml, name) {
    const m = new RegExp(`${name}="([^"]*)"`).exec(xml);
    return m ? m[1] : null;
}

/** rId → target path, resolved against the part's folder. */
function parseRels(xml, partDir) {
    const rels = {};
    for (const m of String(xml || '').matchAll(/<Relationship\b([^>]*)\/?>/g)) {
        const id = attr(m[1], 'Id');
        const target = attr(m[1], 'Target');
        if (!id || !target) continue;
        rels[id] = target.startsWith('/') ? target.slice(1) : normalisePath(`${partDir}/${target}`);
    }
    return rels;
}

function normalisePath(p) {
    const out = [];
    for (const seg of p.split('/')) {
        if (!seg || seg === '.') continue;
        if (seg === '..') out.pop(); else out.push(seg);
    }
    return out.join('/');
}

function dirOf(path) {
    return path.slice(0, path.lastIndexOf('/'));
}

function relsPathFor(partPath) {
    return `${dirOf(partPath)}/_rels/${partPath.slice(partPath.lastIndexOf('/') + 1)}.rels`;
}

/**
 * The picture layers of one part (a slide, a layout, a master): the
 * background blip, `<p:pic>` shapes and picture-filled `<p:sp>` shapes, each
 * with its box as fractions of the slide. Placeholders and text-only shapes
 * are ignored.
 */
function collectLayers(xml, rels, size) {
    const layers = [];
    const bg = /<p:bg>([\s\S]*?)<\/p:bg>/.exec(xml);
    if (bg) {
        const embed = /<a:blip\b[^>]*r:embed="(rId\d+)"/.exec(bg[1]);
        if (embed && rels[embed[1]]) layers.push({ target: rels[embed[1]], x: 0, y: 0, w: 1, h: 1, full: true });
        const solid = /<a:solidFill>\s*<a:srgbClr val="([0-9A-Fa-f]{6})"/.exec(bg[1]);
        if (!embed && solid) layers.push({ solid: `#${solid[1].toUpperCase()}`, x: 0, y: 0, w: 1, h: 1, full: true });
    }
    for (const m of xml.matchAll(/<p:(pic|sp)\b[\s\S]*?<\/p:\1>/g)) {
        const body = m[0];
        if (/<p:ph\b/.test(body) && m[1] === 'sp') continue;
        const embed = /<a:blip\b[^>]*r:embed="(rId\d+)"/.exec(body);
        if (!embed || !rels[embed[1]]) continue;
        const off = /<a:off x="(-?\d+)" y="(-?\d+)"/.exec(body);
        const ext = /<a:ext cx="(\d+)" cy="(\d+)"/.exec(body);
        if (!off || !ext) continue;
        const x = Number(off[1]) / size.cx;
        const y = Number(off[2]) / size.cy;
        const w = Number(ext[1]) / size.cx;
        const h = Number(ext[2]) / size.cy;
        if (!(w > 0 && h > 0)) continue;
        // Full-bleed: covers (nearly) the whole slide, possibly beyond it.
        const coverW = Math.min(1, x + w) - Math.max(0, x);
        const coverH = Math.min(1, y + h) - Math.max(0, y);
        const full = coverW * coverH >= 0.85;
        layers.push({ target: rels[embed[1]], x, y, w, h, full });
    }
    return layers;
}

async function readPart(zip, path) {
    const f = zip.file(path);
    return f ? f.async('string') : null;
}

/** The layers of a slide, falling back to its layout and then its master. */
async function slideLayers(zip, slidePath, size) {
    const xml = await readPart(zip, slidePath);
    if (!xml) return [];
    const rels = parseRels(await readPart(zip, relsPathFor(slidePath)), dirOf(slidePath));
    let layers = collectLayers(xml, rels, size);
    const layoutPath = Object.values(rels).find((t) => /slideLayouts\/slideLayout\d+\.xml$/.test(t));
    if (layoutPath) {
        const lx = await readPart(zip, layoutPath);
        const lr = parseRels(await readPart(zip, relsPathFor(layoutPath)), dirOf(layoutPath));
        const layoutLayers = lx ? collectLayers(lx, lr, size) : [];
        const masterPath = Object.values(lr).find((t) => /slideMasters\/slideMaster\d+\.xml$/.test(t));
        let masterLayers = [];
        if (masterPath) {
            const mx = await readPart(zip, masterPath);
            const mr = parseRels(await readPart(zip, relsPathFor(masterPath)), dirOf(masterPath));
            masterLayers = mx ? collectLayers(mx, mr, size) : [];
        }
        // Slide layers paint over the layout's, which paint over the master's.
        layers = [...masterLayers, ...layoutLayers, ...layers];
    }
    return layers;
}

/**
 * The colour the template writes its text in — the most used run colour on
 * its slides (srgb, or the scheme's bg1/tx1). The deck follows it when it
 * reads on the backdrop; a template that puts white on blue means white.
 */
async function slideTextColour(zip, slidePaths, themeXml) {
    const counts = new Map();
    const lt1 = /<a:lt1>[\s\S]*?(?:lastClr|val)="([0-9A-Fa-f]{6})"/.exec(themeXml || '');
    const dk1 = /<a:dk1>[\s\S]*?(?:lastClr|val)="([0-9A-Fa-f]{6})"/.exec(themeXml || '');
    for (const path of slidePaths.slice(0, 3)) {
        const xml = await readPart(zip, path);
        if (!xml) continue;
        for (const body of xml.matchAll(/<p:txBody>([\s\S]*?)<\/p:txBody>/g)) {
            for (const run of body[1].matchAll(/<a:rPr\b[^>]*>([\s\S]*?)<\/a:rPr>/g)) {
                const srgb = /<a:solidFill>\s*<a:srgbClr val="([0-9A-Fa-f]{6})"/.exec(run[1]);
                const scheme = /<a:solidFill>\s*<a:schemeClr val="(bg1|tx1|lt1|dk1)"/.exec(run[1]);
                let hex = null;
                if (srgb) hex = srgb[1];
                else if (scheme && (scheme[1] === 'bg1' || scheme[1] === 'lt1') && lt1) hex = lt1[1];
                else if (scheme && (scheme[1] === 'tx1' || scheme[1] === 'dk1') && dk1) hex = dk1[1];
                if (hex) counts.set(hex.toUpperCase(), (counts.get(hex.toUpperCase()) || 0) + 1);
            }
        }
    }
    let best = null;
    for (const [hex, n] of counts) if (!best || n > best.n) best = { hex, n };
    return best ? `#${best.hex}` : '';
}

/** The theme's typefaces (major = titles, minor = body). */
async function themeFonts(zip) {
    const themePath = Object.keys(zip.files).find((n) => /^ppt\/theme\/theme\d+\.xml$/.test(n));
    const xml = themePath ? await readPart(zip, themePath) : '';
    const major = /<a:majorFont>\s*<a:latin typeface="([^"]*)"/.exec(xml || '');
    const minor = /<a:minorFont>\s*<a:latin typeface="([^"]*)"/.exec(xml || '');
    const clean = (v) => (v && !/^\+/.test(v) ? v.slice(0, 60) : '');
    return { title: clean(major && major[1]), body: clean(minor && minor[1]) };
}

function toHex([r, g, b]) {
    return `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

/**
 * Composite the full-bleed layers into one JPEG the size of the slide, and
 * downscale the overlays. Returns null when there is nothing to paint.
 */
async function composeSide(zip, layers, size, sharp) {
    const W = COMPOSITE_WIDTH;
    const H = Math.max(1, Math.round((W * size.cy) / size.cx));
    const full = layers.filter((l) => l.full);
    const small = layers.filter((l) => !l.full);
    let base = null;
    const composites = [];
    for (const layer of full) {
        if (layer.solid) {
            base = sharp({ create: { width: W, height: H, channels: 4, background: layer.solid } });
            composites.length = 0;
            continue;
        }
        const entry = zip.file(layer.target);
        if (!entry) continue;
        const bytes = await entry.async('nodebuffer');
        if (bytes.length > MAX_MEDIA_BYTES) continue;
        const lw = Math.max(1, Math.round(layer.w * W));
        const lh = Math.max(1, Math.round(layer.h * H));
        const lx = Math.round(layer.x * W);
        const ly = Math.round(layer.y * H);
        // The part of the layer that lies on the slide.
        const left = Math.max(0, -lx); const top = Math.max(0, -ly);
        const right = Math.min(lw, W - lx); const bottom = Math.min(lh, H - ly);
        if (right <= left || bottom <= top) continue;
        let img;
        try {
            img = await sharp(bytes, { density: 200 }).resize(lw, lh, { fit: 'fill' }).extract({ left, top, width: right - left, height: bottom - top }).png().toBuffer();
        } catch { continue; }
        composites.push({ input: img, left: Math.max(0, lx), top: Math.max(0, ly) });
    }
    if (!base && !composites.length) return null;
    if (!base) base = sharp({ create: { width: W, height: H, channels: 4, background: '#FFFFFF' } });
    const composed = await base.composite(composites).flatten({ background: '#FFFFFF' }).jpeg({ quality: 82, mozjpeg: true }).toBuffer();
    const stats = await sharp(composed).stats();
    const mean = toHex(stats.channels.slice(0, 3).map((c) => c.mean));
    const accent = await dominantColour(sharp, composed);

    const overlays = [];
    for (const layer of small.slice(0, MAX_OVERLAYS)) {
        const entry = zip.file(layer.target);
        if (!entry) continue;
        const bytes = await entry.async('nodebuffer');
        if (bytes.length > MAX_MEDIA_BYTES) continue;
        try {
            const png = await sharp(bytes, { density: 200 }).resize({ width: OVERLAY_MAX_PX, height: OVERLAY_MAX_PX, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
            overlays.push({ image: `data:image/png;base64,${png.toString('base64')}`, x: round(layer.x), y: round(layer.y), w: round(layer.w), h: round(layer.h) });
        } catch { /* not an image sharp can read */ }
    }
    return { image: `data:image/jpeg;base64,${composed.toString('base64')}`, overlays, background: mean, accent };
}

/**
 * The template's BRAND colour: the most common saturated colour in the
 * backdrop (pixels bucketed coarsely, greys and near-whites/blacks left out).
 * A gradient's mean is a colour nobody chose; its dominant bucket is.
 */
async function dominantColour(sharp, jpeg) {
    try {
        const { data, info } = await sharp(jpeg).resize(96, 54, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
        const buckets = new Map();
        for (let i = 0; i < data.length; i += info.channels) {
            const r = data[i]; const g = data[i + 1]; const b = data[i + 2];
            const max = Math.max(r, g, b); const min = Math.min(r, g, b);
            if (max - min < 40 || max < 40 || min > 235) continue; // grey, black, white
            const key = `${r >> 5},${g >> 5},${b >> 5}`;
            const e = buckets.get(key) || { n: 0, r: 0, g: 0, b: 0 };
            e.n += 1; e.r += r; e.g += g; e.b += b;
            buckets.set(key, e);
        }
        let best = null;
        for (const e of buckets.values()) if (!best || e.n > best.n) best = e;
        return best ? toHex([best.r / best.n, best.g / best.n, best.b / best.n]) : '';
    } catch { return ''; }
}

function round(v) {
    return Math.round(v * 10000) / 10000;
}

/**
 * @param {Buffer} buffer  the .pptx
 * @param {{ name?: string }} [opts]
 * @returns {Promise<{ name, aspect, cover, content, background, coverBackground, accent, text, fonts }>}
 */
async function extractDeckTemplate(buffer, { name = '' } = {}) {
    if (!buffer || buffer.length > MAX_TEMPLATE_BYTES) {
        throw Object.assign(new Error(`A template deck may be at most ${MAX_TEMPLATE_BYTES / 1048576} MB.`), { errorClass: 'template_too_large' });
    }
    let sharp;
    try { sharp = require('sharp'); } catch { throw Object.assign(new Error('Image processing is not available on this server.'), { errorClass: 'template_unsupported' }); }
    const zip = await JSZip.loadAsync(buffer);
    const pres = await readPart(zip, 'ppt/presentation.xml');
    if (!pres) throw Object.assign(new Error('That file is not a PowerPoint deck.'), { errorClass: 'template_invalid' });
    const sz = /<p:sldSz cx="(\d+)" cy="(\d+)"/.exec(pres);
    const size = { cx: sz ? Number(sz[1]) : 12192000, cy: sz ? Number(sz[2]) : 6858000 };

    const slides = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
        .sort((a, b) => Number(/slide(\d+)/.exec(a)[1]) - Number(/slide(\d+)/.exec(b)[1]));
    // The first slide is the cover's design, the second the content's; a
    // one-slide template serves both. No slides: the master alone.
    const coverLayers = slides[0] ? await slideLayers(zip, slides[0], size) : [];
    const contentLayers = slides[1] ? await slideLayers(zip, slides[1], size) : coverLayers;
    let cover = await composeSide(zip, coverLayers, size, sharp);
    let content = await composeSide(zip, contentLayers, size, sharp);
    if (!cover && !content) {
        const masterPath = Object.keys(zip.files).find((n) => /^ppt\/slideMasters\/slideMaster\d+\.xml$/.test(n));
        if (masterPath) {
            const mx = await readPart(zip, masterPath);
            const mr = parseRels(await readPart(zip, relsPathFor(masterPath)), dirOf(masterPath));
            const ml = mx ? collectLayers(mx, mr, size) : [];
            cover = content = await composeSide(zip, ml, size, sharp);
        }
    }
    if (!cover && !content) {
        throw Object.assign(new Error('No background pictures were found in the first slides of that deck — the deck engine can only reuse a template that paints its look with images.'), { errorClass: 'template_no_layers' });
    }
    if (!cover) cover = content;
    if (!content) content = cover;
    const fonts = await themeFonts(zip);
    const themePath = Object.keys(zip.files).find((n) => /^ppt\/theme\/theme\d+\.xml$/.test(n));
    const text = await slideTextColour(zip, slides, themePath ? await readPart(zip, themePath) : '');
    return {
        name: String(name || '').replace(/\.pptx$/i, '').slice(0, 80),
        aspect: round(size.cx / size.cy),
        cover: { image: cover.image, overlays: cover.overlays },
        content: { image: content.image, overlays: content.overlays },
        background: content.background,
        coverBackground: cover.background,
        accent: content.accent || cover.accent || '',
        text,
        fonts,
    };
}

module.exports = { extractDeckTemplate, MAX_TEMPLATE_BYTES, _test: { collectLayers, parseRels, normalisePath } };
