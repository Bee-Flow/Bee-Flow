/**
 * Screenshots of the product website for the CMS MCP server.
 *
 * The goal is a picture that matches what a visitor sees, of the DRAFT (what
 * the agent just edited) or of the PUBLISHED snapshot (what is live).
 *
 * HOW: the same pipeline routes/publicRender.js serves visitors with — the
 * agent-hub shell, the server-rendered blocks, the `#__BEEFLOW_CMS__` payload —
 * is composed in memory for the chosen content, and handed to the shared,
 * network-isolated bf-browser through page.route() on a fake origin (the way
 * services/appStudioRender.js does; the browser has no route to anything real).
 * Everything the page asks for under that origin is answered by this server:
 *
 *   /                          the composed document
 *   /assets/…  /fonts/…  …     the agent-hub build, fetched server-side from
 *                              AGENT_HUB_ORIGIN (the very host core/seo/shell.js
 *                              takes the shell from, so the hashes match)
 *   /api/cms/asset/cms/…       uploaded CMS images, read from storage
 *   /api/cms/site              the same content payload the document inlines
 *   anything else              an empty 204
 *
 * With the real agent-hub bundle React hydrates exactly as it does for a
 * visitor. When the shell or the bundle cannot be reached the page still
 * renders from the server markup plus PREHYDRATE_CSS, and the tool result says
 * so ("server-rendered markup only"): a plain, unstyled-ish page, not a lie.
 *
 * Contract: never throws. { ok: true, … } or { ok: false, unavailable: true,
 * reason: '<one plain sentence>' }.
 */

'use strict';

const log = require('../../telemetry/log');

// services/browserProvider.js BACKEND_UNAVAILABLE: the code of "no browser to render with".
const BACKEND_UNAVAILABLE = 'browser_backend_unavailable';
const FAKE_ORIGIN = 'https://cms-preview.beeflow.local';
const VIEWPORTS = Object.freeze({
    desktop: { width: 1280, height: 800 },
    tablet: { width: 834, height: 1112 },
    mobile: { width: 390, height: 844 },
});
const MAX_DIM = 1280;
// A full-page capture of a very long page is cut here before it is scaled.
const MAX_FULLPAGE_HEIGHT = 12000;
const JPEG_ABOVE_BYTES = 1_500_000;
const HARD_TIMEOUT_MS = 60_000;
const NAV_TIMEOUT_MS = 20_000;
const HYDRATE_WAIT_MS = 8_000;
const SETTLE_MS = 400;
const HUB_ASSET_MAX_BYTES = 12 * 1024 * 1024;
const HUB_ASSET_TIMEOUT_MS = 8_000;
const HUB_CACHE_TTL_MS = 5 * 60 * 1000;
const HUB_CACHE_MAX = 60;
const CMS_IMAGE_MAX_BYTES = 12 * 1024 * 1024;

// What the page may fetch from the agent-hub build. A path outside this list is
// never forwarded, so the fake origin cannot be used to read arbitrary files
// off the agent-hub host.
const HUB_PATH_RE = /^\/(?:assets|fonts|module-shims|images)\/[A-Za-z0-9._@~+/-]+$|^\/(?:app-icon\.svg|favicon\.[a-z]+)$/;

const unavailable = (reason) => ({ ok: false, unavailable: true, reason });

function normaliseSlug(input) {
    const s = String(input ?? '').trim().toLowerCase().replace(/^\/+|\/+$/g, '');
    return s;
}

/** Is `pathname` a path of the agent-hub build that may be fetched? */
function isHubAssetPath(pathname) {
    return typeof pathname === 'string'
        && HUB_PATH_RE.test(pathname)
        && !pathname.includes('..')
        && !pathname.includes('//');
}

function createHubFetcher({ origin, fetchImpl = (...a) => fetch(...a), now = Date.now } = {}) {
    const cache = new Map();
    return async function fetchHubAsset(pathname) {
        if (!isHubAssetPath(pathname)) return null;
        const hit = cache.get(pathname);
        if (hit && now() - hit.at < HUB_CACHE_TTL_MS) return hit.value;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), HUB_ASSET_TIMEOUT_MS);
        try {
            const res = await fetchImpl(`${origin}${pathname}`, {
                signal: controller.signal,
                headers: { 'X-Beeflow-Internal': 'cms-mcp-screenshot' },
            });
            if (!res.ok) return null;
            const declared = Number(res.headers?.get?.('content-length')) || 0;
            if (declared > HUB_ASSET_MAX_BYTES) return null;
            const body = Buffer.from(await res.arrayBuffer());
            if (body.length > HUB_ASSET_MAX_BYTES) return null;
            const value = { body, contentType: res.headers?.get?.('content-type') || 'application/octet-stream' };
            if (cache.size >= HUB_CACHE_MAX) cache.delete(cache.keys().next().value);
            cache.set(pathname, { at: now(), value });
            return value;
        } catch (_) {
            return null;
        } finally {
            clearTimeout(timer);
        }
    };
}

/** Longest side ≤ 1280 px, PNG unless that is large, then JPEG. */
async function encodeImage(png) {
    const sharp = require('sharp');
    const meta = await sharp(png).metadata();
    let img = sharp(png);
    if ((meta.width || 0) > MAX_DIM || (meta.height || 0) > MAX_DIM) {
        img = img.resize({ width: MAX_DIM, height: MAX_DIM, fit: 'inside', withoutEnlargement: true });
    }
    let out = await img.png({ compressionLevel: 9 }).toBuffer();
    let mimeType = 'image/png';
    if (out.length > JPEG_ABOVE_BYTES) {
        out = await sharp(out).jpeg({ quality: 82 }).toBuffer();
        mimeType = 'image/jpeg';
    }
    const m = await sharp(out).metadata();
    return { data: out.toString('base64'), mimeType, width: m.width, height: m.height };
}

async function withHardTimeout(promise, ms) {
    let t;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                t = setTimeout(() => reject(new Error(`the render timed out after ${Math.round(ms / 1000)}s`)), ms);
            }),
        ]);
    } finally {
        clearTimeout(t);
        Promise.resolve(promise).catch(() => {});
    }
}

// The marketing site remembers the visitor's cookie choice in localStorage under
// `cookie_consent` ("accepted" | "declined"; agent-hub/src/marketing/components/
// consent.js). A fresh browser context has none, so every screenshot would carry
// the banner over the bottom of the page. Declining in advance keeps the banner out
// of the picture, and keeps the render from starting any consent-gated tracking.
const CONSENT_INIT_SCRIPT = "try { window.localStorage.setItem('cookie_consent', 'declined'); } catch (e) { /* storage blocked */ }";

/** Is this URL on the fake origin (exact origin match, not a string prefix)? */
function isFakeOrigin(href) {
    try {
        return new URL(href).origin === FAKE_ORIGIN;
    } catch (_) {
        return false;
    }
}

/** The default browser edge: run `serve` as the whole network of a page and capture it. */
async function captureWithBrowser({ serve, url, viewport, fullPage, offsetY }, browserProvider = require('../../services/browserProvider')) {
    const consoleErrors = [];
    return browserProvider.withContext(
        { viewport, deviceScaleFactor: 1, javaScriptEnabled: true, reducedMotion: 'reduce', colorScheme: 'light' },
        async (context) => {
            // Defence in depth: the browser container is network-isolated already.
            await context.addInitScript(CONSENT_INIT_SCRIPT);
            // Everything that is not the fake origin is refused, whatever its scheme
            // (a prefix test on the href would let https://cms-preview.beeflow.local.evil
            // through, and a scheme allow-list would let ws:, ftp: and friends through).
            await context.route('**/*', (route) => (isFakeOrigin(route.request().url()) ? route.fallback() : route.abort()));
            // Playwright's route() does not see WebSocket traffic; close any socket a page opens.
            await context.routeWebSocket(/.*/, (ws) => ws.close());
            const page = await context.newPage();
            page.setDefaultTimeout(NAV_TIMEOUT_MS);
            page.on('console', (m) => {
                try {
                    if (m.type() === 'error' && consoleErrors.length < 5) consoleErrors.push(m.text().slice(0, 200));
                } catch (_) { /* diagnostics only */ }
            });
            await page.route((u) => isFakeOrigin(u.href), async (route) => {
                const req = route.request();
                let out;
                try {
                    out = req.method() === 'GET'
                        ? await serve(new URL(req.url()).pathname, req.resourceType())
                        : { status: 204 };
                } catch (_) {
                    out = { status: 204 };
                }
                return route.fulfill({
                    status: out.status,
                    contentType: out.contentType,
                    body: out.body ?? '',
                    headers: { 'cache-control': 'no-store' },
                });
            });
            await page.goto(url, { waitUntil: 'load', timeout: NAV_TIMEOUT_MS });
            // Hydration replaces the server markup wrapper; wait for that, but
            // photograph whatever is there if it never happens.
            await page.waitForFunction(
                () => !document.querySelector('.cms-prehydrate') && !!document.querySelector('#root')?.children.length,
                { timeout: HYDRATE_WAIT_MS, polling: 100 },
            ).catch(() => {});
            await page.evaluate(() => (document.fonts ? document.fonts.ready.then(() => true) : true)).catch(() => {});
            if (fullPage) {
                // Walk down the page so lazy images load, then back up.
                await page.evaluate(async () => {
                    const step = window.innerHeight || 800;
                    for (let y = 0; y < document.documentElement.scrollHeight && y < 24000; y += step) {
                        window.scrollTo(0, y);
                        await new Promise((r) => setTimeout(r, 60));
                    }
                    window.scrollTo(0, 0);
                }).catch(() => {});
            }
            await page.waitForTimeout(SETTLE_MS);

            const hydrated = await page.evaluate(
                () => !document.querySelector('.cms-prehydrate') && !!document.querySelector('#root')?.children.length,
            ).catch(() => false);
            const pageHeight = await page.evaluate(
                () => Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0),
            ).catch(() => viewport.height);

            let png;
            if (fullPage) {
                const height = Math.max(1, Math.min(pageHeight, MAX_FULLPAGE_HEIGHT));
                png = await page.screenshot({ type: 'png', fullPage: true, clip: { x: 0, y: 0, width: viewport.width, height } });
            } else if (offsetY > 0) {
                const y = Math.min(offsetY, Math.max(0, pageHeight - viewport.height));
                png = await page.screenshot({
                    type: 'png', fullPage: true,
                    clip: { x: 0, y, width: viewport.width, height: Math.min(viewport.height, Math.max(1, pageHeight - y)) },
                });
            } else {
                png = await page.screenshot({ type: 'png' });
            }
            return { png, hydrated, pageHeight, consoleErrors };
        },
    );
}

function defaultDeps() {
    const cmsStore = require('../../stores/cmsStore');
    const { getShell, DEFAULT_ORIGIN } = require('../../core/seo/shell');
    const { buildHead } = require('../../core/seo/head');
    const { renderBlocks, PREHYDRATE_CSS } = require('../../core/seo/renderBlocks');
    const { injectIntoShell } = require('../../core/seo/inject');
    const { jsonForScript } = require('../../core/seo/html');
    const { buildPublicPath } = require('../../core/seo/publicPath');
    const { synthesizeLegacyContent } = require('../../core/cms/legacyContent');
    return {
        cmsStore,
        getShell: () => getShell(),
        buildHead,
        renderBlocks,
        PREHYDRATE_CSS,
        injectIntoShell,
        jsonForScript,
        buildPublicPath,
        synthesizeLegacyContent,
        fetchHubAsset: createHubFetcher({ origin: DEFAULT_ORIGIN }),
        readCmsAsset: async (key) => {
            const storageStore = require('../../stores/storageStore');
            if (!storageStore.isAvailable()) return null;
            const head = await storageStore.headFile(key);
            if ((Number(head.contentLength) || 0) > CMS_IMAGE_MAX_BYTES) return null;
            const { stream, contentType } = await storageStore.streamFile(key);
            const chunks = [];
            for await (const c of stream) chunks.push(c);
            return { body: Buffer.concat(chunks), contentType };
        },
        capture: captureWithBrowser,
        encode: encodeImage,
        hardTimeoutMs: HARD_TIMEOUT_MS,
    };
}

/**
 * @param {ReturnType<typeof defaultDeps>|null} [overrides] every collaborator, for tests; omitted = the real ones
 */
function createScreenshotRenderer(overrides = null) {
    const deps = overrides ? { ...overrides } : defaultDeps();

    /** The content to photograph, or an `unavailable` reason. */
    async function resolveContent({ siteId, pageId, slug, state, locale }) {
        const { cmsStore } = deps;
        const defaultLocale = await cmsStore.getDefaultLocale();
        const wanted = locale ? String(locale).toLowerCase() : defaultLocale;
        if (!cmsStore.isValidLocale(wanted)) return unavailable(`"${locale}" is not a language code such as "en" or "nl".`);

        let site;
        if (state === 'published') {
            const snap = await cmsStore.getPublishedSnapshot(siteId, { fresh: true });
            if (!snap || !snap.site) return unavailable('this site has never been published, so there is no published version to show; use state "draft".');
            site = snap.site;
        } else {
            site = await cmsStore.getProject(siteId);
            if (!site) return unavailable(`site "${siteId}" was not found.`);
        }

        const entries = Array.isArray(site.pages) ? site.pages : [];
        let entry = null;
        if (pageId) {
            entry = entries.find((p) => p.id === pageId) || null;
        } else {
            const wantedSlug = normaliseSlug(slug);
            entry = wantedSlug
                ? entries.find((p) => p.slug === wantedSlug)
                : entries.find((p) => p.isHomepage) || entries[0] || null;
        }
        if (!entry) {
            const list = entries.map((p) => `${p.id} (/${p.slug})`).join(', ') || 'none';
            return unavailable(`that page does not exist in the ${state === 'published' ? 'published' : 'draft'} version of this site. Pages: ${list}.`);
        }

        const entrySlug = entry.isHomepage ? '' : entry.slug;
        const eff = state === 'published'
            ? await cmsStore.getEffectivePublished(siteId, entrySlug || null, wanted)
            : await cmsStore.getEffective(siteId, entrySlug || null, wanted);
        if (!eff || !eff.found || !eff.page) return unavailable('the page could not be resolved for that language.');
        return { eff, entrySlug, locale: wanted, defaultLocale };
    }

    /** The full HTML document for the chosen content, plus whether the shell was reachable. */
    async function composeDocument({ eff, entrySlug, locale, defaultLocale }) {
        const siteName = (eff.header && eff.header.logoText) || 'Bee Flow';
        const head = deps.buildHead({
            origin: FAKE_ORIGIN, slug: entrySlug, locale, defaultLocale, locales: [locale],
            page: eff.page, design: eff.design || {}, siteName,
        });
        const body = deps.renderBlocks(eff.page.blocks, { fallbackTitle: eff.page.title });
        const payload = {
            enabled: true,
            found: true,
            canonicalSlug: eff.page.isHomepage ? '' : (eff.page.slug || ''),
            defaultLocale,
            locale,
            content: deps.synthesizeLegacyContent(eff),
            design: eff.design || {},
        };
        const bootstrap = deps.jsonForScript(payload);
        const headWithCss = body
            ? `${head}\n    <style>${deps.PREHYDRATE_CSS}</style>\n    <script type="application/json" id="__BEEFLOW_CMS__">${bootstrap}</script>`
            : head;

        const shell = await deps.getShell();
        const html = shell
            ? deps.injectIntoShell(shell, { head: headWithCss, body, lang: locale })
            : `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${headWithCss}</head><body><div id="root">${body}</div></body></html>`;
        return { html, hasShell: !!shell, payload };
    }

    /** What the page's network is: see the header comment. */
    function makeServe({ html, payload }) {
        return async function serve(pathname, resourceType) {
            if (resourceType === 'document') return { status: 200, contentType: 'text/html; charset=utf-8', body: html };
            if (pathname === '/api/cms/site') {
                return { status: 200, contentType: 'application/json', body: JSON.stringify({ ...payload, appOnly: false, analytics: null }) };
            }
            if (pathname.startsWith('/api/cms/asset/')) {
                let key;
                try { key = decodeURIComponent(pathname.slice('/api/cms/asset/'.length)); } catch (_) { return { status: 404 }; }
                if (!key.startsWith('cms/') || key.includes('..')) return { status: 404 };
                try {
                    const asset = await deps.readCmsAsset(key);
                    // Only still images: a clip would bloat the render and a poster is enough.
                    if (!asset || !/^image\//i.test(asset.contentType || '')) return { status: 204 };
                    return { status: 200, contentType: asset.contentType, body: asset.body };
                } catch (_) { return { status: 404 }; }
            }
            if (isHubAssetPath(pathname)) {
                const asset = await deps.fetchHubAsset(pathname);
                return asset ? { status: 200, contentType: asset.contentType, body: asset.body } : { status: 404 };
            }
            return { status: 204 };
        };
    }

    /**
     * @param {{ siteId: string, pageId?: string, slug?: string, state?: 'draft'|'published',
     *           locale?: string, viewport?: 'desktop'|'tablet'|'mobile', fullPage?: boolean, offsetY?: number }} args
     */
    async function render(args) {
        try {
            const state = args.state === 'published' ? 'published' : 'draft';
            const viewport = VIEWPORTS[args.viewport] || VIEWPORTS.desktop;
            const content = await resolveContent({ ...args, state });
            if (content.unavailable) return content;

            const doc = await composeDocument(content);
            const path = deps.buildPublicPath(content.locale, content.entrySlug, content.defaultLocale);
            const shot = await withHardTimeoutSafe(deps.capture({
                serve: makeServe(doc),
                url: `${FAKE_ORIGIN}${path}`,
                viewport,
                fullPage: args.fullPage === true,
                offsetY: Number.isFinite(args.offsetY) ? Math.max(0, Math.floor(args.offsetY)) : 0,
            }), deps.hardTimeoutMs);
            if (!shot || !shot.png) return unavailable('the browser did not produce a screenshot.');

            const image = await deps.encode(shot.png);
            const hydrated = !!shot.hydrated;
            const rendering = hydrated ? 'hydrated' : 'server-markup-only';
            const why = hydrated
                ? 'Rendered with the real site bundle, as a visitor sees it.'
                : (doc.hasShell
                    ? 'The site bundle did not start in time, so this is the server-rendered markup only (plain styling, no animations or interactive blocks). Do not judge design from it.'
                    : 'The site shell could not be fetched from the web front end, so this is the server-rendered markup only (plain styling). Do not judge design from it.');
            return {
                ok: true,
                image,
                rendering,
                pageHeight: shot.pageHeight,
                path,
                text: [
                    `Screenshot of ${state} ${path} (${content.locale}), ${args.viewport && VIEWPORTS[args.viewport] ? args.viewport : 'desktop'} ${viewport.width}px wide, image ${image.width}x${image.height}.`,
                    why,
                    `The full page is ${shot.pageHeight}px tall at this width${args.fullPage ? ' (scaled down to fit)' : '; pass offsetY to look further down it, or fullPage:true for an overview'}.`,
                ].join(' '),
            };
        } catch (err) {
            if (err && err.code === BACKEND_UNAVAILABLE) {
                return unavailable('no browser is available on this server (the browser service is not reachable), so no screenshot can be rendered.');
            }
            log.warn(`[CmsMcp] screenshot failed: ${err.message}`);
            return unavailable(`the screenshot could not be rendered (${String(err.message).slice(0, 160)}).`);
        }
    }

    function withHardTimeoutSafe(promise, ms) {
        return withHardTimeout(promise, ms || HARD_TIMEOUT_MS);
    }

    return { render, resolveContent, composeDocument, makeServe };
}

module.exports = {
    createScreenshotRenderer, createHubFetcher, isHubAssetPath, encodeImage,
    captureWithBrowser, isFakeOrigin, CONSENT_INIT_SCRIPT, FAKE_ORIGIN, VIEWPORTS, MAX_DIM,
};
