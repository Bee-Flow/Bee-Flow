// @typecheck
const { featureModule } = require('../featureModules');
const dns = require('dns').promises;
const net = require('net');
const { isForbiddenAddress } = require('../http/ssrfGuard');
const log = require('../../telemetry/log');
const { bestEffort, fallback } = require('../../utils/bestEffort');

/**
 * SSRF guard — reject any URL that resolves to a private, loopback,
 * link-local, or otherwise non-routable address. Used by every code path
 * that fetches user-supplied URLs server-side (KB/notebook/webpage source
 * ingestion). Pre-validates the hostname; callers should also re-check the
 * `response.url` post-fetch to catch redirects to internal services.
 *
 * The address decision is NOT made here: every literal and every resolved
 * address goes through core/http/ssrfGuard.isForbiddenAddress, the one range
 * table the whole product screens against (the same one safeFetch applies at
 * connect time). A second, local table drifted from it once (no IPv4-
 * compatible ::a.b.c.d, no hex-form ::ffff:7f00:1, no broadcast); keeping a
 * single table is what stops that from happening again. This wrapper only
 * keeps this module's own error texts and return value (the parsed URL),
 * which routes show to the user as-is.
 *
 * Rejects:
 *   - non-http(s) schemes (file:, gopher:, ftp:, ...)
 *   - a host (literal, or ANY address it resolves to) that isForbiddenAddress
 *     refuses
 *
 * Throws on rejection; resolves with the validated parsed URL on success.
 *
 * @param {string} url
 * @param {{ lookup?: (host: string, opts: { all: true }) => Promise<import('dns').LookupAddress[]> }} [options]
 *   `lookup` is the resolver (default dns.promises.lookup), injectable for tests
 */
async function assertUrlIsPublic(url, { lookup = (host, opts) => dns.lookup(host, opts) } = {}) {
    /** @type {URL} */
    let parsed;
    try { parsed = new URL(url); }
    catch (_) { throw new Error('Invalid URL'); }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error('Only HTTP/HTTPS URLs are allowed');
    }
    const host = parsed.hostname;
    if (!host) throw new Error('URL is missing a hostname');

    // Resolve hostnames to one or more addresses; literal IPs short-circuit.
    /** @type {{ address: string; family: number; }[]} */
    let addresses;
    if (net.isIP(host)) {
        addresses = [{ address: host, family: net.isIP(host) }];
    } else {
        try {
            addresses = await lookup(host, { all: true });
        } catch (e) {
            throw new Error(`DNS lookup failed for ${host}: ${/** @type {Error} */ (e).message}`);
        }
    }
    for (const a of addresses) {
        if (isForbiddenAddress(a && a.address)) {
            throw new Error(`URL ${host} resolves to a private/loopback address (${a && a.address})`);
        }
    }
    return parsed;
}

/**
 * Fetch a URL and return its content as clean Markdown.
 *
 * Strategy:
 *   1. Simple HTTP fetch + htmlToMarkdown (fast, works for most sites)
 *   2. If content < 20 chars → Playwright headless browser fallback (handles SPAs)
 *
 * @param {string} url — the URL to fetch
 * @returns {Promise<{content: string, title: string, resolvedUrl: string}>}
 */
async function fetchUrlContent(url) {
    // SSRF guard — block private/loopback/link-local hosts (AWS metadata,
    // localhost services, etc.) before opening the socket.
    const parsedUrl = await assertUrlIsPublic(url);

    // ── Step 1: Simple HTTP fetch (fast path) ────────────────────
    let content = '', pageTitle = '', resolvedUrl = url;

    try {
        // safeFetch, not the global fetch. assertUrlIsPublic above resolves DNS
        // to validate, then a plain fetch() resolves DNS AGAIN to connect — and
        // a hostile name server can answer those two lookups differently (DNS
        // rebinding), so the check passes on a public IP and the socket lands on
        // 169.254.169.254. safeFetch revalidates inside the connect handler, on
        // the initial request and on every redirect hop, so both rebinding and
        // redirect laundering fail at the socket instead of after the fact.
        const { safeFetch } = require('../../utils/ssrfGuard');
        const response = await safeFetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BeeFlow/1.0)' },
            redirect: 'follow',
            signal: AbortSignal.timeout(30000)
        });

        if (!response.ok) {
            throw new Error(`Fetch failed: HTTP ${response.status}`);
        }

        resolvedUrl = response.url || url;
        // Redirect-target re-validation: even though the initial host passed,
        // a chain of 3xx responses could have hopped into an internal host.
        if (resolvedUrl !== url) {
            await assertUrlIsPublic(resolvedUrl);
        }
        const html = await require('../http/httpResponseLimits').readKbPage(response, url);
        const contentType = response.headers.get('content-type') || '';

        if (contentType.includes('text/html')) {
            const { htmlToMarkdown } = require('../../utils/htmlToMarkdown');
            const result = htmlToMarkdown(html, resolvedUrl, { includeLinks: true, includeImages: false });
            content = result.markdown;
            pageTitle = result.title || parsedUrl.hostname;
            if (pageTitle && !content.startsWith(`# ${pageTitle}`)) {
                content = `# ${pageTitle}\n\n${content}`;
            }
        } else if (contentType.includes('text/plain') || contentType.includes('text/markdown')) {
            content = html;
            pageTitle = parsedUrl.hostname;
        } else {
            throw new Error(`Unsupported content type: ${contentType}`);
        }
    } catch (fetchErr) {
        if (fetchErr?.oversize) throw fetchErr; // a refusal, not a failure: the headless fallback would load the same page
        log.info(`[KBHelpers] Simple fetch failed for ${url}: ${/** @type {Error} */ (fetchErr).message}, trying headless browser...`);
        content = '';
    }

    // ── Step 2: Playwright headless fallback (for SPAs / JS-rendered pages) ──
    if (!content || content.trim().length < 20) {
        log.info(`[KBHelpers] Content too short (${content.trim().length} chars), using Playwright headless browser for: ${url}`);
        try {
            const result = await fetchWithPlaywright(url);
            content = result.content;
            pageTitle = result.title || pageTitle || parsedUrl.hostname;
            resolvedUrl = result.resolvedUrl || resolvedUrl;
            log.info(`[KBHelpers] Playwright extracted ${content.length} chars from ${url}`);
        } catch (pwErr) {
            log.error(`[KBHelpers] Playwright fallback failed for ${url}:`, /** @type {Error} */ (pwErr).message);
            throw new Error(`No meaningful content extracted from URL (simple fetch and headless browser both failed)`);
        }
    }

    if (!content || content.trim().length < 20) {
        throw new Error('No meaningful content extracted from URL');
    }

    // Truncate very long pages
    const maxChars = 200000;
    if (content.length > maxChars) {
        content = content.slice(0, maxChars);
    }

    return { content, title: pageTitle, resolvedUrl };
}

/**
 * Fetch URL content using a remote headless Chromium (via browserProvider).
 * Waits for the page to load + JS to render, then extracts the HTML.
 *
 * The browser runs in an isolated container, so navigating to arbitrary
 * user-supplied URLs never happens inside the API process.
 *
 * SSRF: the caller validates the initial URL (assertUrlIsPublic) before this
 * runs, but a JS-rendered page can itself issue further requests — redirects,
 * XHR/fetch, iframes — that a plain-fetch flow never triggers. So every
 * request Chromium makes for this navigation is re-screened via
 * context.route(), and the final page.url() is re-checked once navigation
 * settles, mirroring the redirect re-check in fetchUrlContent() above.
 *
 * @param {string} url
 * @param {{ onFrame?: (base64Jpeg: string) => void, waitForSelector?: string }} [opts]  `onFrame` is called on
 *   each throttled screenshot while the page loads (chat live preview); omit it for the default
 *   KB-ingestion behavior (no screenshots taken). `waitForSelector`: a CSS selector to wait for before
 *   extracting content; best-effort, a timeout here is swallowed.
 * @returns {Promise<{content: string, title: string, resolvedUrl: string}>}
 */
async function fetchWithPlaywright(url, opts = {}) {
    const browserProvider = featureModule('services/browserProvider');
    const { isPrivateHostname, isPrivateIp } = require('../../utils/ssrfGuard');

    return browserProvider.withContext(
        {
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
        async (context) => {
            await context.route('**/*', (route) => {
                /** @type {URL} */
                let target;
                try { target = new URL(route.request().url()); } catch (_) { return route.abort('blockedbyclient'); }
                if (!['http:', 'https:'].includes(target.protocol)) return route.abort('blockedbyclient');
                if (isPrivateHostname(target.hostname) || isPrivateIp(target.hostname)) return route.abort('blockedbyclient');
                return route.continue();
            });

            const page = await context.newPage();

            /** @type {NodeJS.Timeout | null} */
            let frameTimer = null;
            if (typeof opts.onFrame === 'function') {
                let capturing = false;
                frameTimer = setInterval(async () => {
                    if (capturing) return;
                    capturing = true;
                    try {
                        const buf = await page.screenshot({ type: 'jpeg', quality: 50, timeout: 2000 });
                        opts.onFrame(buf.toString('base64'));
                    } catch (err) { bestEffort('core/kb/kbUrlFetch:fetchWithPlaywright', err); /* mid-navigation or page closed — skip this tick */ }
                    finally { capturing = false; }
                }, 350);
            }

            try {
                // domcontentloaded, not networkidle: many real-world sites never
                // go fully idle (continuous analytics/tracking beacons, chat
                // widgets polling), which would throw a timeout here and abandon
                // an otherwise perfectly-loaded page. Settle for JS rendering is
                // handled below as a best-effort wait that can't fail the fetch.
                let downloadTriggered = false;
                try {
                    await page.goto(url, {
                        waitUntil: 'domcontentloaded',
                        timeout: 20000,
                    });
                } catch (navErr) {
                    // A direct link to a file (PDF, zip, ...) makes Playwright
                    // reject navigation instead of loading a page — that's not a
                    // broken fetch, it's the wrong tool for a non-HTML resource.
                    if (/download is starting/i.test(/** @type {Error} */ (navErr).message)) downloadTriggered = true;
                    else throw navErr;
                }
                if (downloadTriggered) {
                    throw new Error('This URL triggers a file download (e.g. a PDF) rather than rendering a webpage — a headless browser cannot read downloaded files this way.');
                }

                // Best-effort settle for JS-rendered content; don't fail the
                // whole fetch just because the page never goes fully idle.
                await page.waitForLoadState('networkidle', { timeout: 8000 }).catch((e) => bestEffort('core/kb/kbUrlFetch:fetchWithPlaywright#2', e));

                const resolvedUrl = page.url();
                let resolvedHost = '';
                try { resolvedHost = new URL(resolvedUrl).hostname; } catch (err) { fallback('core/kb/kbUrlFetch:fetchWithPlaywright#3', err); /* keep empty */ }
                if (isPrivateHostname(resolvedHost) || isPrivateIp(resolvedHost)) {
                    throw new Error(`Navigation resolved to a private/internal address (${resolvedHost})`);
                }

                if (opts.waitForSelector) {
                    await page.waitForSelector(opts.waitForSelector, { timeout: 5000 }).catch((e) => bestEffort('core/kb/kbUrlFetch:fetchWithPlaywright#4', e));
                }

                // Additional wait for late-rendering SPAs
                await page.waitForTimeout(1500);

                const pageTitle = await page.title();

                // Get the fully rendered HTML
                const html = await page.content();

                // Convert rendered HTML to markdown
                const { htmlToMarkdown } = require('../../utils/htmlToMarkdown');
                const result = htmlToMarkdown(html, resolvedUrl, { includeLinks: true, includeImages: false });
                let content = result.markdown;

                if (pageTitle && !content.startsWith(`# ${pageTitle}`)) {
                    content = `# ${pageTitle}\n\n${content}`;
                }

                return {
                    content,
                    title: result.title || pageTitle,
                    resolvedUrl,
                };
            } finally {
                if (frameTimer) clearInterval(frameTimer);
            }
        }
    );
}

module.exports = { assertUrlIsPublic, fetchUrlContent, fetchWithPlaywright };
