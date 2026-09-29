// @typecheck
/**
 * A web page (or a whole site) as a knowledge source.
 *
 * ── AN UNCHANGED PAGE MUST COST NOTHING ─────────────────────────────
 * A weekly refresh of a 200-page site that re-embedded every page would be
 * 200 embedding calls a week to learn that nothing happened. So the adapter
 * asks the server first, with the two answers HTTP already has:
 *
 *   ETag           → `If-None-Match`  → 304, and we stop there
 *   Last-Modified  → `If-Modified-Since` → 304, same
 *
 * The validator is kept on the document's own row (`external_id` holds the
 * URL, so the validator rides in `source_modified_at` and the content hash),
 * which means the check survives a restart and is per-page rather than
 * per-source.
 *
 * A server that offers neither still works: the fetched text is hashed by
 * `ingestDocument` and an identical hash is a no-op there. That is one wasted
 * fetch, not one wasted embedding.
 *
 * ── EVERY URL IS SCREENED, EVERY TIME ───────────────────────────────
 * Through `core/kb/fetchGuard` — the same guard the routes use, not a copy.
 * This matters more here than at the route: a URL a person screened once
 * when they added the source is re-fetched every week by a job with nobody
 * watching, and DNS can say something different by then.
 */

const { guardedFetch } = require('../fetchGuard');

/** A crawl source will not walk more than this, whatever its config says. */
const MAX_CRAWL_PAGES = 500;

const supportsModes = ['manual', 'schedule'];
const defaultMode = 'manual';

/**
 * What this source currently offers.
 *
 * K3 enumerates the entry page and, for a crawl source, the sitemap pages
 * beneath it. The `crawl.maxPages` the creator stored is honoured and then
 * clamped again here: the stored value came from a request body, and a value
 * that was clamped at write time can still be edited in the database.
 */
async function enumerate(source, ctx) {
    const config = source.config || {};
    const url = config.url;
    if (!url) return [];

    const entry = { externalId: url, url, kind: 'page' };
    if (!config.crawl) return [entry];

    const maxPages = Math.max(1, Math.min(MAX_CRAWL_PAGES, Number(config.crawl.maxPages) || 50));
    const pages = await sitemapPages(url, maxPages, ctx);
    // The entry page always belongs, whether or not the sitemap lists it.
    const seen = new Set([url]);
    const out = [entry];
    for (const p of pages) {
        if (seen.has(p)) continue;
        seen.add(p);
        out.push({ externalId: p, url: p, kind: 'page' });
        if (out.length >= maxPages) break;
    }
    return out;
}

/**
 * Always false, on purpose.
 *
 * There is no evidence about a web page that can be had without asking the
 * server — enumerate() knows a URL and nothing else. The real check is the
 * CONDITIONAL REQUEST in fetch() below, which is cheaper than this one would
 * be anyway: a 304 costs one round trip and no embedding, and it is the
 * server's own answer rather than our guess about it.
 *
 * Returning true here on a stale guess would freeze a page that changed.
 */
function isUnchanged() {
    return false;
}

/**
 * Fetch one page, conditionally.
 *
 * Returns null when the server answers 304 — the engine counts that as
 * unchanged and does nothing else, which is the whole saving: a weekly
 * refresh of a 200-page site costs 200 round trips instead of 200
 * re-embeddings.
 */
async function fetch(item, stored, _ctx, _deps) {
    const headers = { 'User-Agent': 'Mozilla/5.0 (compatible; BeeFlow/1.0)' };
    // The validator this page gave us last time, offered back to it. An
    // ETag is quoted (or W/-prefixed); anything else is a date.
    const validator = stored?.source_modified_at || null;
    if (validator) {
        if (/^(W\/)?"/.test(String(validator))) headers['If-None-Match'] = String(validator);
        else headers['If-Modified-Since'] = new Date(validator).toUTCString();
    }

    const res = await guardedFetch(item.url, {
        headers,
        redirect: 'follow',
        signal: AbortSignal.timeout(30_000),
    });

    if (res.status === 304) return null;
    if (!res.ok) throw new Error(`Fetch failed: HTTP ${res.status}`);

    const resolvedUrl = res.url || item.url;
    const contentType = res.headers.get('content-type') || '';
    const body = await res.text();

    let content = '';
    let title = '';
    if (contentType.includes('text/html')) {
        const { htmlToMarkdown } = require('../../../utils/htmlToMarkdown');
        const md = htmlToMarkdown(body, resolvedUrl, { includeLinks: true, includeImages: false });
        content = md.markdown || '';
        title = md.title || '';
        if (title && !content.startsWith(`# ${title}`)) content = `# ${title}\n\n${content}`;
    } else if (contentType.includes('text/plain') || contentType.includes('text/markdown')) {
        content = body;
    } else {
        throw new Error(`Unsupported content type: ${contentType || 'unknown'}`);
    }

    // Keep whichever validator the server gave us, so the NEXT pass can ask.
    const nextValidator = res.headers.get('etag') || res.headers.get('last-modified') || null;
    let hostname = item.url;
    try { hostname = new URL(resolvedUrl).hostname; } catch (_) { /* keep the raw url */ }

    return {
        content,
        title: title || hostname,
        sourceType: 'web',
        sourceUri: resolvedUrl,
        sourceModifiedAt: nextValidator,
        sizeBytes: Buffer.byteLength(content, 'utf8'),
        mime: contentType.split(';')[0] || 'text/html',
    };
}

/**
 * The pages a site offers, from its sitemap.
 *
 * Deliberately sitemap-only rather than a link crawler: a sitemap is the
 * site's own statement of what it wants indexed, it is bounded, and it does
 * not wander onto a third-party domain the way following links does. A site
 * without one contributes its entry page and nothing else, which is the
 * honest outcome — not a crawl of everything it happens to link to.
 */
async function sitemapPages(entryUrl, maxPages, ctx) {
    let origin;
    try { origin = new URL(entryUrl).origin; } catch (_) { return []; }

    const candidates = [`${origin}/sitemap.xml`];
    try {
        const robots = await guardedFetch(`${origin}/robots.txt`, { signal: AbortSignal.timeout(10_000) });
        if (robots.ok) {
            const text = await robots.text();
            for (const m of text.matchAll(/^\s*Sitemap:\s*(\S+)/gim)) candidates.push(m[1]);
        }
    } catch (_) { /* no robots.txt is normal */ }

    const urls = [];
    const seenMaps = new Set();
    for (const candidate of candidates) {
        if (urls.length >= maxPages) break;
        if (seenMaps.has(candidate)) continue;
        seenMaps.add(candidate);
        try {
            // Each sitemap URL is screened on its own merits by guardedFetch:
            // the <loc> entries come out of a document the site controls, so
            // they need not share the origin we started from.
            const res = await guardedFetch(candidate, { signal: AbortSignal.timeout(15_000) });
            if (!res.ok) continue;
            const xml = await res.text();
            for (const m of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
                const loc = m[1];
                if (/\.xml(\.gz)?$/i.test(loc)) {
                    if (!seenMaps.has(loc)) candidates.push(loc);   // nested index
                    continue;
                }
                urls.push(loc);
                if (urls.length >= maxPages) break;
            }
        } catch (e) {
            ctx?.log?.(`sitemap ${candidate} skipped: ${e.message}`);
        }
    }
    return urls;
}

module.exports = { enumerate, fetch, isUnchanged, supportsModes, defaultMode, MAX_CRAWL_PAGES, sitemapPages };
