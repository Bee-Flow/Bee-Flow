// @typecheck
/**
 * The generated share image of a page, for pages without their own og:image:
 *
 *   GET /api/cms/og/<locale>/<page-slug>.png      (public, mounted by routes/cms.js)
 *
 * Only PUBLISHED content is drawn (the live site's snapshot), only for a
 * language the site publishes, and only for a page that exists, so the URL
 * space is the page list, not an open generator. The page head points at it
 * with ?v=<publish time> (core/seo/head.js): a new publish is a new URL, so the
 * response can be cached for a year; without a matching v it is cached for
 * minutes. The picture itself is core/seo/ogCard.js.
 */

const crypto = require('node:crypto');
const cmsStore = require('../stores/cmsStore');
const storageStore = require('../stores/storageStore');
const log = require('../telemetry/log');
const { HttpError } = require('../core/http/errors');
const { renderCard, versionOf } = require('../core/seo/ogCard');
const { assetKeyFromSrc } = require('../utils/mediaDims');
const { getLiveSiteId } = require('./cmsShared');

const LOGO_MAX_BYTES = 3 * 1024 * 1024;
const RASTER = new Set(['png', 'jpeg', 'webp']);

/** Locales the published snapshot has content for, default first. */
function publishedLocales(snapshot, defaultLocale) {
    const set = new Set([defaultLocale, ...Object.keys(snapshot.siteLocaleOverrides || {})]);
    for (const perPage of Object.values(snapshot.pageLocaleOverrides || {})) {
        for (const l of Object.keys(perPage || {})) set.add(l);
    }
    return set;
}

/** The first short eyebrow a block of the page carries ("Features"), or ''. */
function eyebrowOf(page) {
    for (const block of page.blocks || []) {
        const e = block && block.enabled !== false && block.content && block.content.eyebrow;
        if (typeof e === 'string' && e.trim() && e.length <= 60) return e.trim();
    }
    return '';
}

/**
 * The logo bytes when the design has a raster logo of ours, else null. SVG is
 * never composited: its renderer may follow references the upload check does not.
 * @returns {Promise<Buffer | null>}
 */
async function loadLogo(src) {
    const key = assetKeyFromSrc(src);
    if (!key || !storageStore.isAvailable()) return null;
    try {
        const { stream, contentLength } = await storageStore.streamFile(key);
        if (contentLength > LOGO_MAX_BYTES) { stream.destroy(); return null; }
        const chunks = [];
        let size = 0;
        for await (const chunk of stream) {
            size += chunk.length;
            if (size > LOGO_MAX_BYTES) { stream.destroy(); return null; }
            chunks.push(chunk);
        }
        const buf = Buffer.concat(chunks);
        const meta = await require('sharp')(buf, { limitInputPixels: 40e6 }).metadata();
        return RASTER.has(String(meta.format)) ? buf : null;
    } catch (e) {
        log.warn(`[CMS] share image logo skipped: ${e.message}`);
        return null;
    }
}

async function serveOgImage(req, res) {
    const siteId = await getLiveSiteId();
    const snapshot = siteId ? await cmsStore.getPublishedSnapshot(siteId) : null;
    if (!siteId || !snapshot) throw new HttpError(404, 'not_found', 'Not found');
    const locale = String(req.params[0]);
    const slug = String(req.params[1]);
    const defaultLocale = await cmsStore.getDefaultLocale();
    if (!publishedLocales(snapshot, defaultLocale).has(locale)) throw new HttpError(404, 'not_found', 'Not found');
    const eff = await cmsStore.getEffectivePublished(siteId, slug, locale);
    if (!eff || !eff.found || !eff.page) throw new HttpError(404, 'not_found', 'Not found');

    const design = eff.design || {};
    const share = design.shareImage || {};
    const version = versionOf(snapshot.publishedAt);
    const etag = `"og-${crypto.createHash('sha1').update(`${siteId}|${version}|${locale}|${slug}`).digest('hex').slice(0, 20)}"`;
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', req.query.v === version
        ? 'public, max-age=31536000, immutable'
        : 'public, max-age=300');
    if (req.headers['if-none-match'] === etag) return res.status(304).end();

    let png;
    try {
        png = await renderCard(`${siteId}|${version}|${locale}|${slug}|${design.logo || ''}`, {
            title: (eff.page.seo && eff.page.seo.metaTitle) || eff.page.title || '',
            eyebrow: eyebrowOf(eff.page),
            brand: (eff.header && eff.header.logoText) || (snapshot.site && snapshot.site.name) || '',
            design,
            template: share.template,
            motif: share.motif !== false,
            loadLogo: design.logo ? () => loadLogo(design.logo) : undefined,
        });
    } catch (e) {
        if (e && e.code === 'og_busy') {
            res.setHeader('Retry-After', '5');
            res.setHeader('Cache-Control', 'no-store');
            throw new HttpError(503, 'og_busy', 'Busy, try again shortly');
        }
        throw e;
    }
    res.type('image/png');
    return res.send(png);
}

module.exports = { serveOgImage, eyebrowOf, publishedLocales };
