import { logger } from './utils/logger';
import { parseCmsPath, type CmsPath } from './utils/cmsPublicRouting';

/**
 * The CMS payload the server already inlined into this document, or null.
 *
 * routes/publicRender.js renders the marketing page server-side and embeds the
 * exact payload `/api/cms/site` would have returned. Reading it here is what
 * lets the first React render have real content: without it RootPathGate
 * mounted with `cms === null`, painted a full-viewport #06090F rectangle over
 * the server's own HTML, and then went to the network for content it had
 * already been handed. Lighthouse measured the result as a black first
 * filmstrip frame, FCP 1.9s and CLS 0.437.
 *
 * Returns null on anything unexpected — a missing tag (the un-rendered shell
 * from nginx's @shell fallback), malformed JSON, or a payload for a different
 * locale than this visitor resolves to. Every one of those falls back to the
 * fetch path, which is exactly the old behaviour.
 */
export function readInlinedCms(expectedLocale: string) {
    try {
        const el = document.getElementById('__BEEFLOW_CMS__');
        if (!el) return null;
        const data = JSON.parse(el.textContent || 'null');
        if (!data || data.enabled !== true || !data.content) return null;
        // The server rendered for the PATH's locale. A visitor whose stored or
        // browser language differs resolves to something else, and showing the
        // server's language first would swap the page under them a moment
        // later. Let those fall through to the fetch instead.
        if (expectedLocale && data.locale && data.locale !== expectedLocale) return null;
        return data;
    } catch {
        return null;
    }
}

/**
 * The locale a public URL asks for: its path prefix (`/nl/...`), else the
 * legacy `?locale=` (honoured only for the instant before the server's 301
 * onto the path), else '' = the site's default language, which is what the
 * server renders for an unprefixed path.
 *
 * The browser language and the stored `beeflow_locale` choice are NOT read
 * here: they made a Dutch browser on the English /blog/<post> fetch and paint
 * the Dutch page over the English one the server had sent. Only the bare `/`
 * follows the browser, and the server decides that (core/seo/homeLocale.mts).
 */
export function resolveInitialLocale(): string {
    try {
        const parsed = parseCmsPath(window.location.pathname);
        if (parsed?.locale) return parsed.locale.toLowerCase();
        const param = new URLSearchParams(window.location.search).get('locale');
        return param ? param.toLowerCase().split('-')[0] : '';
    } catch (err) {
        logger.debug('ignore', err);
        return '';
    }
}

/** Blog URLs ask /api/cms/site for the blog payload; ?tag= and ?page= ride along. */
export function blogQuery(parsed: CmsPath, params: URLSearchParams) {
    if (!parsed.blog) return '';
    const out = new URLSearchParams({ blog: parsed.blog.view });
    if ('postSlug' in parsed.blog && parsed.blog.postSlug) out.set('post', parsed.blog.postSlug);
    if (params.get('tag')) out.set('tag', params.get('tag') as string);
    if (params.get('page')) out.set('page', params.get('page') as string);
    return `&${out.toString()}`;
}
