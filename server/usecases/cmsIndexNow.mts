/**
 * IndexNow: tell Bing, Yandex, Seznam and the other IndexNow engines which
 * addresses of the live CMS site a publish (or a switch of the live site)
 * added, changed or removed, so they do not wait for their next crawl of
 * sitemap.xml. A removed address is sent too: the engine recrawls it, gets the
 * 404 and drops it.
 *
 * Off unless INDEXNOW_KEY is set (8-128 letters, digits or dashes; the
 * protocol's rule). With a key, the public renderer serves it at
 * `/<key>.txt` (routes/publicFilesRender.mts): that file proves to the engine
 * that the site owner sent the list.
 *
 * What a publish sends: the sitemap of the live site before and after the
 * publish, compared per address (new, a different <lastmod>, or gone), at most
 * INDEXNOW_MAX_URLS addresses (default 1000; 0 = the protocol's own limit of
 * 10 000). Both sides are built without the publish-time fallback date, so
 * the integration pages, whose only date is the publish, do not count as
 * changed on every publish. Only public addresses of the site leave Bee
 * Flow: no page content, no names, nothing about the person who published.
 *
 * Fire and forget: the ping runs after the publish has answered, a failure
 * is logged and never reaches the editor, and only the live site is
 * announced (a draft site has no public addresses). The site's address is
 * PUBLIC_SITE_URL (or PUBLIC_BASE_URL), the same origin as the canonicals:
 * without it nothing is sent, as the site is not indexable then either.
 */

import { createRequire } from 'node:module';
import { fetchFixedEndpoint } from '../utils/fixedEndpointFetch.mts';
import { envInt } from '../utils/envNumber.mts';

const nodeRequire = createRequire(import.meta.url);
const log = nodeRequire('../telemetry/log') as { info: (...a: unknown[]) => void, warn: (...a: unknown[]) => void };

export const INDEXNOW_ENDPOINT = 'https://api.indexnow.org/indexnow';
/** The protocol accepts at most this many addresses in one POST. */
export const PROTOCOL_MAX_URLS = 10_000;
export const DEFAULT_MAX_URLS = 1000;
const KEY_RE = /^[A-Za-z0-9-]{8,128}$/;

/** How long a publish waits for the sitemap before it, by default; INDEXNOW_BEFORE_TIMEOUT_MS. */
export const DEFAULT_BEFORE_TIMEOUT_MS = 2000;

type Env = Record<string, string | undefined>;
type FetchLike = (url: string, init: RequestInit) => Promise<{ status: number, body?: { cancel?: () => Promise<void> } | null }>;

/** The configured key, or null when IndexNow is off (unset or not a valid key). */
export function indexNowKey(env: Env = process.env): string | null {
    const raw = String(env.INDEXNOW_KEY || '').trim();
    return KEY_RE.test(raw) ? raw : null;
}

/** The path the key file is served at (`/<key>.txt`), or null when IndexNow is off. */
export function keyFilePath(env: Env = process.env): string | null {
    const key = indexNowKey(env);
    return key ? `/${key}.txt` : null;
}

/** How many addresses one publish may send: INDEXNOW_MAX_URLS, 0 = the protocol limit. */
export function maxUrls(): number {
    const n = envInt('INDEXNOW_MAX_URLS', DEFAULT_MAX_URLS, { min: 0 });
    return n === 0 ? PROTOCOL_MAX_URLS : Math.min(n, PROTOCOL_MAX_URLS);
}

/**
 * How long a publish waits for the sitemap it compares against:
 * INDEXNOW_BEFORE_TIMEOUT_MS (default 2000), 0 = no limit. Past it the publish
 * goes ahead and nothing is announced for it.
 */
export function beforeTimeoutMs(): number {
    return envInt('INDEXNOW_BEFORE_TIMEOUT_MS', DEFAULT_BEFORE_TIMEOUT_MS, { min: 0 });
}

function unescapeXml(s: string): string {
    return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

/** Between `open` and `close` inside `text`, or '' when either is missing. */
function between(text: string, open: string, close: string): string {
    const start = text.indexOf(open);
    if (start === -1) return '';
    const end = text.indexOf(close, start + open.length);
    return end === -1 ? '' : text.slice(start + open.length, end).trim();
}

/** Every <url> of a sitemap (our own buildSitemap output): address → lastmod ('' when it has none). */
export function sitemapLastmods(xml: string): Map<string, string> {
    const out = new Map<string, string>();
    let at = 0;
    for (;;) {
        const start = xml.indexOf('<url>', at);
        if (start === -1) break;
        const end = xml.indexOf('</url>', start);
        if (end === -1) break;
        const block = xml.slice(start, end);
        const loc = between(block, '<loc>', '</loc>');
        if (loc) out.set(unescapeXml(loc), between(block, '<lastmod>', '</lastmod>'));
        at = end + 6;
    }
    return out;
}

/**
 * Addresses that are new in `after` or carry a different lastmod there, then
 * the ones `after` no longer lists; at most `cap`.
 */
export function changedUrls(beforeXml: string, afterXml: string, cap: number): string[] {
    const before = sitemapLastmods(beforeXml);
    const after = sitemapLastmods(afterXml);
    const changed: string[] = [];
    for (const [url, lastmod] of after) {
        if (!before.has(url) || before.get(url) !== lastmod) changed.push(url);
    }
    for (const url of before.keys()) {
        if (!after.has(url)) changed.push(url);
    }
    return changed.slice(0, cap);
}

/** POST the list to the IndexNow endpoint; resolves to the HTTP status. */
export async function submitUrls(
    { origin, key, urls }: { origin: string, key: string, urls: string[] },
    fetchImpl: FetchLike = fetchFixedEndpoint,
): Promise<number> {
    const res = await fetchImpl(INDEXNOW_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ host: new URL(origin).host, key, keyLocation: `${origin}/${key}.txt`, urlList: urls }),
    });
    // Only the status matters; release the connection instead of leaving the body to the garbage collector.
    try {
        await res.body?.cancel?.();
    } catch {
        // an already consumed or closed body: nothing to release
    }
    return res.status;
}

export interface IndexNowDeps {
    env?: Env;
    origin: () => string;
    getLiveSiteId: () => Promise<string | null>;
    /** The live sitemap of the site's CURRENT published snapshot, without fallback dates ('' when unpublished). */
    sitemapXml: (siteId: string, origin: string) => Promise<string>;
    submit: (args: { origin: string, key: string, urls: string[] }) => Promise<number>;
    /** Overrides INDEXNOW_BEFORE_TIMEOUT_MS (tests). */
    beforeTimeoutMs?: number;
}

function defaultDeps(): IndexNowDeps {
    const configStore = nodeRequire('../stores/configStore');
    const cmsStore = nodeRequire('../stores/cmsStore');
    const { configuredOrigin } = nodeRequire('../core/seo/publicOrigin');
    return {
        origin: configuredOrigin,
        getLiveSiteId: async () => (await configStore.getConfigFresh('cms_live_site_id')) || null,
        sitemapXml: async (siteId, origin) => {
            const snapshot = await cmsStore.getPublishedSnapshot(siteId, { fresh: true });
            if (!snapshot) return '';
            const { liveSitemapXml } = nodeRequire('./liveSitemap.mts');
            return liveSitemapXml({ siteId, snapshot, origin, lastmod: null });
        },
        submit: (args) => submitUrls(args),
    };
}

async function announce(siteId: string, beforeXml: string, key: string, origin: string, deps: IndexNowDeps): Promise<void> {
    const urls = changedUrls(beforeXml, await deps.sitemapXml(siteId, origin), maxUrls());
    if (!urls.length) return;
    const status = await deps.submit({ origin, key, urls });
    if (status >= 200 && status < 300) log.info(`[IndexNow] ${urls.length} address(es) of ${new URL(origin).host} sent (HTTP ${status})`);
    else log.warn(`[IndexNow] the endpoint answered HTTP ${status} for ${urls.length} address(es)`);
}

const TIMED_OUT = Symbol('timed out');

/** `work`, or TIMED_OUT once `ms` has passed (0 = no limit). `work` itself is never cancelled. */
async function withinTime<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
    if (ms <= 0) return work;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), ms);
    });
    try {
        return await Promise.race([work, timeout]);
    } finally {
        clearTimeout(timer);
    }
}

/** The live sitemap before the publish, or null when there is nothing to compare (not live, slow, failed). */
function sitemapBefore(siteId: string, origin: string, deps: IndexNowDeps): Promise<string | null> {
    return readBefore((async () => (await deps.getLiveSiteId() === siteId ? deps.sitemapXml(siteId, origin) : null))(), deps);
}

/** `work` under the before-time-out; null when it is slow or fails (logged). */
async function readBefore(work: Promise<string | null>, deps: IndexNowDeps): Promise<string | null> {
    // A failure after the time-out must not surface as an unhandled rejection.
    work.catch(() => undefined);
    try {
        const out = await withinTime(work, deps.beforeTimeoutMs ?? beforeTimeoutMs());
        if (out !== TIMED_OUT) return out;
        log.warn('[IndexNow] the sitemap before publishing took too long, nothing will be sent for this publish');
    } catch (e) {
        log.warn(`[IndexNow] could not read the sitemap before publishing, nothing will be sent: ${(e as Error).message}`);
    }
    return null;
}

/**
 * Run `publish` for `siteId`; when IndexNow is on and this is the live site,
 * announce what the publish added or changed afterwards, without waiting.
 * The publish result (or its error) is returned exactly as `publish` gave it.
 * The sitemap before the publish is read under a time-out
 * (INDEXNOW_BEFORE_TIMEOUT_MS), so IndexNow never holds up a publish for long.
 */
export async function publishWithIndexNow<T>(siteId: string, publish: () => Promise<T>, given?: IndexNowDeps): Promise<T> {
    // Off (no key, no injected deps): just publish, without loading the stores IndexNow reads.
    if (!given && !indexNowKey()) return publish();
    const deps = given ?? defaultDeps();
    const key = indexNowKey(deps.env);
    const origin = key ? String(deps.origin() || '') : '';
    const beforeXml = key && origin ? await sitemapBefore(siteId, origin, deps) : null;
    const result = await publish();
    if (beforeXml !== null && key) {
        announce(siteId, beforeXml, key, origin, deps)
            .catch((e: unknown) => log.warn(`[IndexNow] announcing the publish failed: ${(e as Error).message}`));
    }
    return result;
}

/**
 * Switch the live site to `siteId` (`doSwitch`); when IndexNow is on, announce
 * afterwards, without waiting, what the switch changed: the sitemap of the
 * site that was live (none: empty) against the sitemap of the new one. The
 * new site is already published when it goes live (cmsShared
 * ensurePublishedSnapshot runs before the switch). Going offline (null) or
 * re-selecting the live site sends nothing.
 */
export async function switchLiveWithIndexNow<T>(siteId: string | null, doSwitch: () => Promise<T>, given?: IndexNowDeps): Promise<T> {
    if (!given && !indexNowKey()) return doSwitch();
    const deps = given ?? defaultDeps();
    const key = indexNowKey(deps.env);
    const origin = key ? String(deps.origin() || '') : '';
    let beforeXml: string | null = null;
    if (key && origin && siteId) {
        beforeXml = await readBefore((async () => {
            const previous = await deps.getLiveSiteId();
            if (previous === siteId) return null;
            return previous ? deps.sitemapXml(previous, origin) : '';
        })(), deps);
    }
    const result = await doSwitch();
    if (beforeXml !== null && key && siteId) {
        announce(siteId, beforeXml, key, origin, deps)
            .catch((e: unknown) => log.warn(`[IndexNow] announcing the new live site failed: ${(e as Error).message}`));
    }
    return result;
}

/**
 * `store` with its publishSite going through publishWithIndexNow. The admin
 * publish route calls publishWithIndexNow itself; the CMS MCP cms_publish gets
 * its store through this (routes/mcpCms.js mcpCmsStore), and the background
 * heal of a live site without a snapshot (routes/cmsPublicSite.js) publishes
 * through publishWithIndexNow too. Making a site live is a switch, not a
 * publish of the live site: cmsShared.setLiveSiteId announces it through
 * switchLiveWithIndexNow.
 */
export function withIndexNow<S extends { publishSite: (siteId: string) => Promise<unknown> }>(
    store: S, deps?: IndexNowDeps,
): S {
    return { ...store, publishSite: (siteId: string) => publishWithIndexNow(siteId, () => store.publishSite(siteId), deps) };
}
