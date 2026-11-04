import { jsonOrThrow } from './jsonOrThrow';
import { API_BASE, authFetch } from '../utils/helpers';

/** The server's largest page (`GET /api/transcriptions` caps `limit` at 100). */
const LIST_PAGE_SIZE = 100;

/**
 * The most pages one walk reads (2000 notes). The library re-runs the walk
 * while a note is processing, so an instance-wide list (a super admin's) must
 * not turn every poll into an unbounded run of sequential requests.
 */
const MAX_LIST_PAGES = 20;

async function listTranscriptionsPage(limit: number, offset: number) {
    const res = await authFetch(`${API_BASE}/api/transcriptions?limit=${limit}&offset=${offset}`);
    const data = await jsonOrThrow(res);
    return Array.isArray(data.transcriptions) ? data.transcriptions : [];
}

/**
 * The notes the caller may read, newest first.
 *
 * Without `limit` this is EVERY readable note: the server answers in pages
 * (50 by default, at most 100), and the library searches, filters on tag and
 * owner, sorts and picks notes for a report in the browser over what this
 * returns. One page made every note past the newest 50 unreachable there,
 * while the tag chips (server-side) still counted them. So it walks the pages
 * until a short one, at most MAX_LIST_PAGES of them. A note created mid-walk
 * shifts the offsets by one, which the id check absorbs; a page that adds
 * nothing new ends the walk.
 *
 * With `limit` it is just the newest `limit` notes, one request.
 */
export async function listTranscriptions({ limit }: { limit?: number } = {}) {
    if (limit !== undefined) return listTranscriptionsPage(Math.min(Math.max(1, limit), LIST_PAGE_SIZE), 0);
    const all: Awaited<ReturnType<typeof listTranscriptionsPage>> = [];
    const seen = new Set<string>();
    for (let page = 0, offset = 0; page < MAX_LIST_PAGES; page++, offset += LIST_PAGE_SIZE) {
        const rows = await listTranscriptionsPage(LIST_PAGE_SIZE, offset);
        const fresh = rows.filter((n: { id?: string }) => !n.id || !seen.has(n.id));
        for (const n of fresh) { if (n.id) seen.add(n.id); all.push(n); }
        if (rows.length < LIST_PAGE_SIZE || fresh.length === 0) break;
    }
    return all;
}
