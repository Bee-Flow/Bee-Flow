/**
 * Which language a visitor of the bare homepage gets.
 *
 * `/` serves the site's default language. A visitor whose browser asks for
 * another language the site offers is sent to that language's homepage
 * (`/nl`) with a 302, so a Dutch visitor no longer lands on English copy.
 * Only `/`: every other address already names its language, and links to it
 * mean that language.
 *
 * A choice the visitor made on the site wins over the browser. The language
 * switcher goes through `?locale=`, which routes/publicRender.js consolidates
 * onto the path URL; that redirect also sets the cookie below, and with the
 * cookie present `/` is served as asked. Without it a visitor who picked
 * English would be sent back to `/nl` on the next visit to `/`.
 *
 * Crawlers send no Accept-Language, so they keep seeing `/` in the default
 * language; the hreflang links point them at the other versions.
 */

/** Holds the language a visitor picked on the public site. Not a secret, not personal data. */
export const SITE_LOCALE_COOKIE = 'bf_site_locale';

const YEAR_SECONDS = 365 * 24 * 3600;

interface Weighted { tag: string; q: number; order: number }

function parseWeights(header: string): Weighted[] {
    return header.split(',').map((part, order) => {
        const [rawTag = '', ...params] = part.trim().split(';');
        const qParam = params.map(p => p.trim()).find(p => p.toLowerCase().startsWith('q='));
        const q = qParam === undefined ? 1 : Number.parseFloat(qParam.slice(2));
        return { tag: rawTag.trim().toLowerCase().split('-')[0] ?? '', q: Number.isFinite(q) ? q : 0, order };
    });
}

/**
 * The site locale the browser prefers most, or null when it names none of them.
 * Ordered by q, then by position in the header (the spec's tie-break).
 */
export function preferredLocale(acceptLanguage: string | undefined | null, locales: readonly string[]): string | null {
    if (!acceptLanguage) return null;
    const offered = new Set(locales.map(l => l.toLowerCase()));
    const best = parseWeights(acceptLanguage)
        .filter(w => w.q > 0 && w.tag && w.tag !== '*' && offered.has(w.tag))
        .sort((a, b) => b.q - a.q || a.order - b.order)[0];
    return best ? best.tag : null;
}

function cookieValue(cookieHeader: string | undefined | null, name: string): string | null {
    for (const part of String(cookieHeader || '').split(';')) {
        const eq = part.indexOf('=');
        if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
    }
    return null;
}

export interface HomeLocaleRequest {
    path: string;
    query: URLSearchParams;
    acceptLanguage: string | undefined | null;
    cookieHeader: string | undefined | null;
    locales: readonly string[];
    defaultLocale: string;
}

/** Where a visitor of `/` should go instead, or null to serve `/` as it is. */
export function homeLocaleRedirect(req: HomeLocaleRequest): string | null {
    if (req.path !== '/' || req.locales.length < 2) return null;
    if (req.query.has('locale')) return null;
    if (cookieValue(req.cookieHeader, SITE_LOCALE_COOKIE) === req.defaultLocale) return null;
    const chosen = cookieValue(req.cookieHeader, SITE_LOCALE_COOKIE);
    const wanted = chosen && req.locales.includes(chosen) ? chosen : preferredLocale(req.acceptLanguage, req.locales);
    if (!wanted || wanted === req.defaultLocale) return null;
    const qs = req.query.toString();
    return qs ? `/${wanted}?${qs}` : `/${wanted}`;
}

/** The Set-Cookie value that records a language picked on the site, or null for an unknown one. */
export function siteLocaleCookie(locale: string, locales: readonly string[]): string | null {
    if (!locales.includes(locale)) return null;
    return `${SITE_LOCALE_COOKIE}=${locale}; Path=/; Max-Age=${YEAR_SECONDS}; SameSite=Lax`;
}
