/**
 * Knowledge Bases — sitemap ingestion.
 *
 * Walks robots.txt, sitemap.xml and every nested sitemap of a site and ingests
 * the pages it finds. Every url here is caller-influenced — the posted origin,
 * the Sitemap: lines and the <loc> entries alike — so each one goes through
 * guardedFetch (shared.js) on its own merits, and maxPages is clamped.
 *
 * ── WHAT A CALLER MAY SEND ──────────────────────────────────────────
 * `{ url, maxPages? }`, `.strict()`. maxPages is a whole number of at least
 * one page. It used to be read with `Number()` and a fallback, so
 * `maxPages: "all of them"` walked the 50-page default under a 200, and 0,
 * null, '' or a negative number walked nothing and answered 404 "No pages
 * found in sitemap" — a statement about the site that the site had not made.
 * A value above MAX_SITEMAP_PAGES is still clamped rather than refused, and
 * the response says so (`maxPagesCapped`).
 *
 * `:id` is not checked here — see the header of ./detail.js.
 */

const express = require('express');
const log = require('../../telemetry/log');
const router = express.Router();
const kbStore = require('../../stores/knowledgeBases');
const { requireAuth, requirePermission } = require('../../auth');
const { ingestDocument } = require('../../core/kb/kbIngestionHelpers');
const { getUserId, guardedFetch, canAccessKB, blockIfSystemKB, ensureKbSource } = require('./shared');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');

/** Upper bound on pages one sitemap ingest may walk (req.body.maxPages is clamped to it). */
const MAX_SITEMAP_PAGES = 500;
const DEFAULT_SITEMAP_PAGES = 50;

// ── What a caller may send ──────────────────────────────────────────

/** A string whose every refusal — including "you left it out" — is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });

const URL_TEXT = 'An address is required — the site whose sitemap to read.';
const MAX_PAGES_TEXT = 'maxPages is a whole number of pages, at least 1.';
const SitemapBody = z.preprocess((v) => (v === undefined || v === null ? {} : v), z.object({
    // Whether the site may be fetched is guardedFetch's answer, per address.
    url: worded(URL_TEXT).trim().min(1, URL_TEXT),
    // A number, or the digits of one (a JSON client may quote it).
    maxPages: z.preprocess(
        (v) => (typeof v === 'string' && /^\s*\d+\s*$/.test(v) ? Number(v) : v),
        z.number({ invalid_type_error: MAX_PAGES_TEXT }).int(MAX_PAGES_TEXT).min(1, MAX_PAGES_TEXT),
    ).optional(),
}).strict());

/**
 * Ingest all pages from a website sitemap into a KB
 */
router.post('/:id/ingest/sitemap', requireAuth, requirePermission('manage_knowledge'), validate({ body: SitemapBody }), async (req, res) => {
    const kb = await kbStore.getKB(req.params.id);
    if (!kb) return res.status(404).json({ error: 'KB not found' });
    if (!(await canAccessKB(req, kb))) return res.status(403).json({ error: 'Access denied' });
    if (blockIfSystemKB(kb, res)) return;

    const { url } = req.body;

    // maxPages is attacker-chosen; clamp it. Unbounded, it lets one request
    // walk an arbitrary number of pages (and, before the SSRF guard below,
    // sweep an arbitrary number of internal hosts) inside a single call.
    // The schema has already refused anything that is not a page count, so
    // only a MISSING value defaults, and nothing below 1 arrives here.
    const requestedMax = req.body.maxPages === undefined ? DEFAULT_SITEMAP_PAGES : req.body.maxPages;
    const maxPages = Math.min(requestedMax, MAX_SITEMAP_PAGES);
    // A >500-page ingest is truncated rather than refused, so say so in the
    // response instead of reporting a partial walk as a complete one.
    const maxPagesCapped = requestedMax > MAX_SITEMAP_PAGES;

    // Validate URL
    let parsedUrl;
    try {
        parsedUrl = new URL(url);
        if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
            return res.status(400).json({ error: 'Only HTTP/HTTPS URLs supported' });
        }
    } catch {
        return res.status(400).json({ error: 'Invalid URL' });
    }

    // ── Step 1: Fetch sitemap URLs using the sitemap-fetcher component ──
    const baseUrl = parsedUrl.origin;
    const { fetchUrl: fetchSitemapUrl } = (() => {
        // Inline the core sitemap logic from website-sitemap-fetcher
        async function fetchUrl(targetUrl, timeout = 10000, userAgent = 'Mozilla/5.0 (compatible; BeeFlow/1.0)') {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeout);
            try {
                // guardedFetch, not the global fetch: robots.txt and every
                // (nested) sitemap URL is caller-influenced too.
                const response = await guardedFetch(targetUrl, {
                    headers: { 'User-Agent': userAgent },
                    signal: controller.signal,
                    redirect: 'follow',
                });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                return await response.text();
            } finally {
                clearTimeout(timer);
            }
        }

        return { fetchUrl };
    })();

    const { parseString } = require('xml2js');

    async function parseSitemap(xml, sitemapBaseUrl) {
        return new Promise((resolve, reject) => {
            parseString(xml, (err, result) => {
                if (err) return reject(err);
                const urls = [];
                const sitemaps = [];
                if (result.urlset && Array.isArray(result.urlset.url)) {
                    result.urlset.url.forEach(u => {
                        if (u.loc && u.loc[0]) urls.push(new URL(u.loc[0], sitemapBaseUrl).href);
                    });
                }
                if (result.sitemapindex && Array.isArray(result.sitemapindex.sitemap)) {
                    result.sitemapindex.sitemap.forEach(sm => {
                        if (sm.loc && sm.loc[0]) sitemaps.push(new URL(sm.loc[0], sitemapBaseUrl).href);
                    });
                }
                resolve({ urls, sitemaps });
            });
        });
    }

    async function processSitemap(sitemapUrl, allUrls, visitedSitemaps, limit) {
        if (visitedSitemaps.has(sitemapUrl) || allUrls.size >= limit) return;
        visitedSitemaps.add(sitemapUrl);
        try {
            const xml = await fetchSitemapUrl(sitemapUrl);
            const { urls, sitemaps } = await parseSitemap(xml, sitemapUrl);
            for (const u of urls) {
                if (allUrls.size >= limit) return;
                allUrls.add(u);
            }
            for (const nested of sitemaps) {
                if (allUrls.size >= limit) break;
                await processSitemap(nested, allUrls, visitedSitemaps, limit);
            }
        } catch (e) {
            log.warn(`[KB] Sitemap fetch failed for ${sitemapUrl}: ${e.message}`);
        }
    }

    // Try robots.txt first for sitemap locations
    const sitemapUrls = new Set([
        `${baseUrl}/sitemap.xml`,
        `${baseUrl}/sitemap_index.xml`,
    ]);

    try {
        const robotsTxt = await fetchSitemapUrl(`${baseUrl}/robots.txt`);
        const matches = robotsTxt.match(/^sitemap:\s*(.+)$/gim);
        if (matches) {
            matches.forEach(line => {
                const smUrl = line.replace(/^sitemap:\s*/i, '').trim();
                try { sitemapUrls.add(new URL(smUrl, baseUrl).href); } catch { }
            });
        }
    } catch { }

    const allPageUrls = new Set();
    const visitedSitemaps = new Set();
    for (const smUrl of sitemapUrls) {
        if (allPageUrls.size >= maxPages) break;
        await processSitemap(smUrl, allPageUrls, visitedSitemaps, maxPages);
    }

    const pageUrls = Array.from(allPageUrls);
    if (pageUrls.length === 0) {
        return res.status(404).json({ error: 'No pages found in sitemap. Make sure the URL has a valid sitemap.xml' });
    }

    log.info(`[KB] Sitemap: found ${pageUrls.length} pages from ${url}`);

    // One `webpage` source for the whole walk, keyed on the site origin —
    // every page of this sitemap hangs off it, so the Sources tab shows
    // "example.com · 43 pages" instead of 43 unrelated rows. K3's refresh
    // engine re-walks it from config.crawl.
    const sitemapSource = await ensureKbSource(kb.id, 'webpage', {
        name: parsedUrl.hostname,
        config: { url: baseUrl, crawl: { maxPages } },
        configMatch: { url: baseUrl },
        createdBy: getUserId(req),
    });

    // ── Step 2: Ingest each page ──
    const { htmlToMarkdown } = require('../../utils/htmlToMarkdown');
    const results = { ingested: 0, skipped: 0, errors: 0, details: [] };

    for (let i = 0; i < pageUrls.length; i++) {
        const pageUrl = pageUrls[i];
        try {
            // Fetch page — guardedFetch re-validates THIS url, not just the
            // origin the caller posted. A <loc> entry is attacker-authored
            // and can point anywhere, so the origin check upstream says
            // nothing about it.
            const response = await guardedFetch(pageUrl, {
                headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BeeFlow/1.0)' },
                redirect: 'follow',
                signal: AbortSignal.timeout(15000)
            });

            if (!response.ok) {
                results.errors++;
                results.details.push({ url: pageUrl, status: 'error', reason: `HTTP ${response.status}` });
                continue;
            }

            const html = await response.text();
            const contentType = response.headers.get('content-type') || '';
            let content = '', pageTitle = '';

            if (contentType.includes('text/html')) {
                const result = htmlToMarkdown(html, response.url || pageUrl, { includeLinks: true, includeImages: false });
                content = result.markdown;
                pageTitle = result.title || new URL(pageUrl).pathname;
                if (pageTitle && !content.startsWith(`# ${pageTitle}`)) {
                    content = `# ${pageTitle}\n\n${content}`;
                }
            } else if (contentType.includes('text/plain') || contentType.includes('text/markdown')) {
                content = html;
                pageTitle = new URL(pageUrl).pathname;
            } else {
                results.skipped++;
                results.details.push({ url: pageUrl, status: 'skipped', reason: `Unsupported: ${contentType}` });
                continue;
            }

            if (!content || content.trim().length < 20) {
                results.skipped++;
                results.details.push({ url: pageUrl, status: 'skipped', reason: 'No content' });
                continue;
            }

            // Dedupe check
            const hash = kbStore.hashContent(content);
            const existing = await kbStore.hasContentHash(kb.id, hash);
            if (existing) {
                results.skipped++;
                results.details.push({ url: pageUrl, status: 'skipped', reason: 'Duplicate' });
                continue;
            }

            const result = await ingestDocument(
                kb.tenant_id,
                kb.id,
                content,
                pageTitle,
                'web',
                response.url || pageUrl,
                {
                    skipDedup: true,
                    sourceId: sitemapSource ? sitemapSource.id : null,
                    externalId: response.url || pageUrl,
                    createdBy: getUserId(req),
                    mime: 'text/html',
                }
            );

            results.ingested++;
            results.details.push({ url: pageUrl, status: 'ingested', chunks: result.chunks || 0 });

            log.info(`[KB] Sitemap page ${i + 1}/${pageUrls.length}: ${pageTitle} (${result.chunks} chunks)`);
        } catch (e) {
            results.errors++;
            results.details.push({ url: pageUrl, status: 'error', reason: e.message });
        }
    }

    await kbStore.bumpKBVersion(kb.id);

    res.json({
        success: true,
        totalPages: pageUrls.length,
        // The limit actually applied, and whether the caller's request was
        // reduced to reach it — a 5000-page sitemap walked to 500 is a
        // partial ingest and the caller has to be able to see that.
        maxPages,
        maxPagesCapped,
        ingested: results.ingested,
        skipped: results.skipped,
        errors: results.errors,
        details: results.details
    });
});
module.exports = router;
