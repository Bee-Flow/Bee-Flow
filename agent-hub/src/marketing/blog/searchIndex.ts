/**
 * Client side of the site search: the published index (/search-index.json,
 * built by the server from the published snapshot only) and a local filter.
 * A query never leaves the browser.
 */

export interface SearchEntry {
    k: 'page' | 'post' | 'integration';
    t: string;
    d: string;
    u: string;
    g: string[];
}

interface SearchIndexPayload {
    locale: string;
    entries: SearchEntry[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

function isEntry(v: unknown): v is SearchEntry {
    return isRecord(v)
        && (v.k === 'page' || v.k === 'post' || v.k === 'integration')
        && typeof v.t === 'string' && typeof v.d === 'string' && typeof v.u === 'string'
        && Array.isArray(v.g) && v.g.every((g) => typeof g === 'string');
}

/** Only same-site paths become links; anything else in a tampered index is dropped. */
function isSafePath(u: string): boolean {
    return u.startsWith('/') && !u.startsWith('//');
}

export function parseSearchIndex(raw: unknown): SearchIndexPayload {
    const entries = isRecord(raw) && Array.isArray(raw.entries) ? raw.entries.filter(isEntry).filter((e) => isSafePath(e.u)) : [];
    return { locale: isRecord(raw) && typeof raw.locale === 'string' ? raw.locale : '', entries };
}

/** URL of the index for the locale a page is served in. */
export function searchIndexUrl(locale: string, defaultLocale: string): string {
    return `${locale !== defaultLocale ? `/${locale}` : ''}/search-index.json`;
}

export async function loadSearchIndex(url: string): Promise<SearchEntry[]> {
    const res = await fetch(url, { credentials: 'omit' });
    if (!res.ok) throw new Error(`search index ${res.status}`);
    return parseSearchIndex(await res.json()).entries;
}

/** Every word must appear in the title, description or a tag; title hits rank first. */
export function searchEntries(entries: SearchEntry[], query: string, kinds: ReadonlyArray<SearchEntry['k']>, limit = 8): SearchEntry[] {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6);
    if (!words.length) return [];
    const scored: Array<{ e: SearchEntry; score: number }> = [];
    for (const e of entries) {
        if (!kinds.includes(e.k)) continue;
        const title = e.t.toLowerCase();
        const hay = `${title} ${e.d.toLowerCase()} ${e.g.join(' ').toLowerCase()}`;
        if (!words.every((w) => hay.includes(w))) continue;
        scored.push({ e, score: words.filter((w) => title.includes(w)).length });
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, limit).map((s) => s.e);
}
