// @typecheck strict
'use strict';
/**
 * The generated share image of a page: a 1200x630 card made from the page
 * title, an eyebrow, the site's brand colours and (optionally) its logo and a
 * honeycomb motif, for pages that have no `seo.ogImage` of their own.
 *
 * Pure SVG (text as outlines, see ogText.js) rendered to PNG by sharp; no
 * browser, no network. Colours come from the design and are re-validated as
 * hex here, because they end up in SVG attributes. Results are cached in memory
 * (a card is ~40 kB; the cache key carries the publish time, so a publish
 * naturally starts fresh) and at most two cards are rendered at a time.
 */

const crypto = require('node:crypto');
const { wrap, wrapLines, textPath, clean } = require('./ogText');

const WIDTH = 1200;
const HEIGHT = 630;
const TEMPLATES = Object.freeze(['light', 'dark', 'brand']);
const DEFAULT_TEMPLATE = 'light';
const LOGO_BOX = Object.freeze({ left: 80, top: 486, width: 300, height: 72 });
const CACHE_MAX_ENTRIES = 96;
const CACHE_MAX_BYTES = 24 * 1024 * 1024;
const MAX_CONCURRENT = 2;
const MAX_WAITING = 40;

/**
 * `#abc` / `#aabbcc` -> `#aabbcc`, anything else -> the fallback.
 * @param {unknown} value
 * @param {string} fallback
 */
function hex(value, fallback) {
    const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(value ?? '').trim());
    if (!m) return fallback;
    const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
    return `#${h.toLowerCase()}`;
}

/**
 * @param {string} h
 */
function luminance(h) {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
        .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Dark or light ink, whichever reads on `bg`.
 * @param {string} bg
 */
const inkFor = (bg) => (luminance(bg) > 0.4 ? '#151515' : '#ffffff');

/** @param {unknown} v */
const templateOf = (v) => (TEMPLATES.includes(/** @type {any} */ (v)) ? /** @type {string} */ (v) : DEFAULT_TEMPLATE);

/**
 * The palette of one template from the site's colours.
 * @param {{ colors?: Record<string, unknown> } | null | undefined} design
 * @param {string} template
 */
function palette(design, template) {
    const c = (design && design.colors) || {};
    const primary = hex(c.primary, '#f5a623');
    if (template === 'dark') {
        const bg = hex(c.secondary, '#1f2937');
        return { bg, title: inkFor(bg), sub: inkFor(bg), accent: primary, motif: primary };
    }
    if (template === 'brand') {
        return { bg: primary, title: inkFor(primary), sub: inkFor(primary), accent: inkFor(primary), motif: inkFor(primary) };
    }
    const bg = hex(c.background, '#faf8f4');
    return { bg, title: hex(c.textPrimary, '#1c1917'), sub: hex(c.textSecondary, '#57534e'), accent: primary, motif: primary };
}

/**
 * Pointy-top hexagon outline centred on (cx, cy) with circumradius r.
 * @param {number} cx
 * @param {number} cy
 * @param {number} r
 */
function hexagon(cx, cy, r) {
    const pts = [0, 1, 2, 3, 4, 5].map((i) => {
        const a = (Math.PI / 3) * i - Math.PI / 2;
        return `${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`;
    });
    return pts.join(' ');
}

/**
 * @param {string} color
 */
function honeycomb(color) {
    const r = 58;
    const dx = r * Math.sqrt(3);
    /** @type {string[]} */
    const cells = [];
    for (let row = 0; row < 7; row++) {
        for (let col = 0; col < 6; col++) {
            const cx = 700 + col * dx + (row % 2 ? dx / 2 : 0);
            const cy = -10 + row * r * 1.5;
            if (cx - r > WIDTH) continue;
            const filled = (row * 7 + col * 3) % 5 === 0;
            cells.push(`<polygon points="${hexagon(cx, cy, r - 5)}" fill="${filled ? color : 'none'}" fill-opacity="${filled ? 0.16 : 0}" stroke="${color}" stroke-opacity="0.3" stroke-width="2"/>`);
        }
    }
    return cells.join('');
}

/**
 * Largest headline size whose wrapped text fits without cutting anything off.
 * @param {string} title
 */
function setTitle(title) {
    const plan = [[84, 3], [72, 3], [60, 4], [52, 4]];
    const text = clean(title) || ' ';
    for (const [size, maxLines] of plan) {
        const { lines, truncated } = wrapLines('heading', text, size, 880, maxLines);
        if (!truncated) return { size, lines };
    }
    return { size: 52, lines: wrap('heading', text, 52, 880, 4) };
}

/**
 * @param {{ title: string, eyebrow?: string, brand?: string, design?: any, template?: string, motif?: boolean, logo?: boolean }} input
 * @returns {string} the SVG document
 */
function buildCardSvg(input) {
    const template = templateOf(input.template);
    const p = palette(input.design, template);
    const { size, lines } = setTitle(input.title);
    const lead = Math.round(size * 1.12);
    const top = 190 + size * 0.85;
    const out = [
        `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">`,
        `<rect width="${WIDTH}" height="${HEIGHT}" fill="${p.bg}"/>`,
    ];
    if (input.motif !== false) out.push(`<g>${honeycomb(p.motif)}</g>`);
    out.push(`<rect x="80" y="84" width="72" height="8" rx="4" fill="${p.accent}"/>`);
    const eyebrow = clean(input.eyebrow).toUpperCase();
    if (eyebrow) out.push(`<path d="${textPath('body', wrap('body', eyebrow, 26, 880, 1)[0] || '', 26, 80, 140)}" fill="${p.sub}"/>`);
    lines.forEach((line, i) => {
        out.push(`<path d="${textPath('heading', line, size, 80, top + i * lead)}" fill="${p.title}"/>`);
    });
    const brand = clean(input.brand);
    if (brand && !input.logo) out.push(`<path d="${textPath('body', wrap('body', brand, 30, 700, 1)[0] || '', 30, 80, 540)}" fill="${p.sub}"/>`);
    out.push('</svg>');
    return out.join('');
}

// ── render + cache ───────────────────────────────────────────────────

/** @type {Map<string, Buffer>} insertion order = least recently used first */
const cache = new Map();
let cacheBytes = 0;
/** @type {Map<string, Promise<Buffer>>} */
const inflight = new Map();
let running = 0;
/** @type {Array<() => void>} */
const waiting = [];

async function slot() {
    if (running >= MAX_CONCURRENT && waiting.length >= MAX_WAITING) {
        throw Object.assign(new Error('Too many share images are being drawn'), { code: 'og_busy' });
    }
    if (running >= MAX_CONCURRENT) await new Promise((resolve) => waiting.push(() => resolve(undefined)));
    running++;
}
function release() {
    running--;
    waiting.shift()?.();
}

/** @param {string} key @param {Buffer} png */
function remember(key, png) {
    cache.set(key, png);
    cacheBytes += png.length;
    for (const [k, v] of cache) {
        if (cache.size <= CACHE_MAX_ENTRIES && cacheBytes <= CACHE_MAX_BYTES) break;
        cache.delete(k);
        cacheBytes -= v.length;
    }
}

/**
 * `loadLogo` runs here, inside the render slot and only on a cache miss, so a
 * cached card never touches storage and waiting requests hold no logo bytes.
 * @param {Parameters<typeof buildCardSvg>[0] & { loadLogo?: () => Promise<Buffer | null> }} input
 * @returns {Promise<Buffer>}
 */
async function drawPng(input) {
    const sharp = require('sharp');
    const logoImage = input.loadLogo ? await input.loadLogo() : null;
    const svg = buildCardSvg({ ...input, logo: !!logoImage });
    let img = sharp(Buffer.from(svg));
    if (logoImage) {
        try {
            const logo = await sharp(logoImage, { limitInputPixels: 40e6 })
                .resize({ width: LOGO_BOX.width, height: LOGO_BOX.height, fit: 'inside' })
                .png().toBuffer();
            const meta = await sharp(logo).metadata();
            const top = LOGO_BOX.top + Math.round((LOGO_BOX.height - (meta.height || LOGO_BOX.height)) / 2);
            img = sharp(await img.png().toBuffer()).composite([{ input: logo, left: LOGO_BOX.left, top }]);
        } catch {
            // An unreadable logo costs the logo, not the card.
            img = sharp(Buffer.from(buildCardSvg({ ...input, logo: false })));
        }
    }
    return img.png({ compressionLevel: 9 }).toBuffer();
}

/**
 * The card as PNG bytes. `identity` is anything that changes the picture
 * (site, publish time, page, locale); equal identities share one render.
 * @param {string} identity
 * @param {Parameters<typeof drawPng>[0]} input
 * @returns {Promise<Buffer>}
 */
async function renderCard(identity, input) {
    // nosemgrep: ajinabraham.njsscan.crypto.crypto_node.node_sha1 -- cache key of a rendered image, not a security use
    const key = crypto.createHash('sha1').update(identity).update(JSON.stringify([input.title, input.eyebrow, input.brand, input.design?.colors, input.template, input.motif, !!input.loadLogo])).digest('hex');
    const hit = cache.get(key);
    if (hit) {
        cache.delete(key);
        cache.set(key, hit);
        return hit;
    }
    const pending = inflight.get(key);
    if (pending) return pending;
    const job = (async () => {
        await slot();
        try {
            const png = await drawPng(input);
            remember(key, png);
            return png;
        } finally {
            release();
        }
    })().finally(() => inflight.delete(key));
    inflight.set(key, job);
    return job;
}

/** The publish-time token that versions a card's URL; '' when the site has never been published. @param {string | null | undefined} publishedAt */
const versionOf = (publishedAt) => {
    const t = Date.parse(publishedAt || '');
    return Number.isFinite(t) ? String(t) : '';
};

module.exports = { versionOf, WIDTH, HEIGHT, TEMPLATES, DEFAULT_TEMPLATE, templateOf, hex, buildCardSvg, renderCard };
