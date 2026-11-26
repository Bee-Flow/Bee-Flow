/**
 * The request behind `nextcloud_mail_search`.
 *
 * A search WITH a query reads the Mail app's message cache with
 * `GET /api/messages?mailboxId&filter` (MessagesController::index, what the
 * Mail UI's own search box calls), not `POST /api/mailboxes/{id}/sync`. A sync
 * takes a lock on the mailbox, and a second sync of the same mailbox while the
 * first runs fails with MailboxLockedException (409 "already being synced"):
 * an assistant that fired three searches at once got two of them back as 409.
 * The cache read takes no lock, so searches no longer block each other. Both
 * routes parse the query with the same FilterStringParser (from:, to:,
 * subject:, body:, is:, ...); toMailFilter turns the model's query into it.
 *
 * A call WITHOUT a query (the newest messages: the mail trigger poller and the
 * pattern scan) keeps the sync: it fetches from IMAP first, where the cache
 * only knows what Mail's background job last fetched.
 *
 * Left over (nextcloud/mail lib/Service/Search/MailSearch.php, SyncService):
 *   - the mailbox is locked by a sync that is running (the background job, the
 *     Mail UI, another call): 409. Retried a few times after a short wait.
 *   - the mailbox was never cached (MailboxNotCachedException, 400 on the cache
 *     read): the full sync (`init: true`) caches it and answers the query.
 */

import { setTimeout as sleep } from 'node:timers/promises';
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const { api, baseHeaders } = nodeRequire('./nextcloudMailShapes') as {
    api: (baseUrl: string, path: string) => string,
    baseHeaders: Record<string, string>,
};

type NcResponse = { ok: boolean, status: number, text: () => Promise<string> };
type NcFetch = (url: string, options?: Record<string, unknown>) => Promise<NcResponse>;

/** A response whose body was read once and can be read again. */
export type ReadResponse = { ok: boolean, status: number, text: () => Promise<string>, body: unknown };

export type MailSearchArgs = { mailboxId: number | string, query?: string, limit: number };

/** Waits before the 2nd, 3rd and 4th try of a request that met a locked mailbox. */
export const LOCK_RETRY_DELAYS_MS: readonly number[] = [500, 1500, 3000];

const NOT_CACHED = 'MailboxNotCachedException';

async function readOnce(res: NcResponse): Promise<ReadResponse> {
    const raw = await res.text().catch(() => '');
    let body: unknown = raw;
    try { body = JSON.parse(raw); } catch { /* not JSON: keep the text */ }
    return { ok: res.ok, status: res.status, text: async () => raw, body };
}

/** Runs `request` again after each delay while the mailbox answers 409 (locked). */
async function retryWhileLocked(
    request: () => Promise<NcResponse>,
    delays: readonly number[],
    wait: (ms: number) => Promise<unknown>,
): Promise<ReadResponse> {
    let res = await readOnce(await request());
    for (const ms of delays) {
        if (res.status !== 409) break;
        await wait(ms);
        res = await readOnce(await request());
    }
    return res;
}

function isNotCached(res: ReadResponse): boolean {
    if (res.status !== 400 || !res.body || typeof res.body !== 'object') return false;
    const data = (res.body as { data?: { type?: unknown } }).data;
    return typeof data?.type === 'string' && data.type.endsWith(NOT_CACHED);
}

/** The keys Mail's FilterStringParser reads; any other word is free text. */
const FILTER_KEYS = new Set(['from', 'to', 'cc', 'bcc', 'subject', 'body', 'is', 'not', 'tags', 'start', 'end', 'match', 'mentions', 'flags']);
/** Gmail-style spellings a model writes, in Mail's own words. */
const ALIASES: Record<string, string> = { 'has:attachment': 'flags:attachments', 'has:attachments': 'flags:attachments' };

/** Words of a query; a "quoted phrase" (also after `key:`) stays one word, without its quotes. */
function splitQuery(query: string): string[] {
    const words: string[] = [];
    let word = '';
    let quoted = false;
    for (const ch of query) {
        if (ch === '"') { quoted = !quoted; continue; }
        if (!quoted && (ch === ' ' || ch === '\t' || ch === '\n')) {
            if (word) words.push(word);
            word = '';
            continue;
        }
        word += ch;
    }
    if (word) words.push(word);
    return words;
}

/**
 * A query in Mail's filter syntax. Mail splits the filter on spaces, ignores
 * every word without a `key:` and URL-decodes each value: free text sent as is
 * filtered nothing and answered the newest mail. Free text becomes what the
 * Mail UI's search box sends (SearchMessages.vue): the phrase in subject, from
 * or to (`match:anyof`); next to explicit operators it narrows the subject.
 */
export function toMailFilter(query: string | undefined): string {
    const terms: string[] = [];
    const free: string[] = [];
    let explicitText = false;
    let hasMatch = false;
    for (const word of splitQuery(query ?? '')) {
        const alias = ALIASES[word.toLowerCase()];
        if (alias) { terms.push(alias); continue; }
        const colon = word.indexOf(':');
        const key = colon > 0 ? word.slice(0, colon).toLowerCase() : '';
        if (!FILTER_KEYS.has(key)) { free.push(word); continue; }
        const value = word.slice(colon + 1);
        if (!value) continue;
        terms.push(`${key}:${encodeURIComponent(value)}`);
        if (['from', 'to', 'cc', 'bcc', 'subject', 'body'].includes(key)) explicitText = true;
        if (key === 'match') hasMatch = true;
    }
    if (free.length) {
        const phrase = encodeURIComponent(free.join(' '));
        if (explicitText) terms.push(`subject:${phrase}`);
        else terms.push(`subject:${phrase}`, `from:${phrase}`, `to:${phrase}`);
        if (!hasMatch) terms.push(explicitText ? 'match:allof' : 'match:anyof');
    }
    return terms.join(' ');
}

/** The messages of a successful answer: an array from the cache read, `newMessages` from a sync. */
export function messagesOf(body: unknown): unknown[] {
    if (Array.isArray(body)) return body;
    const b = (body && typeof body === 'object' ? body : {}) as { newMessages?: unknown, messages?: unknown };
    if (Array.isArray(b.newMessages)) return b.newMessages;
    if (Array.isArray(b.messages)) return b.messages;
    return [];
}

/**
 * Searches one mailbox. Answers the last response, its body already read
 * (`body`, and `text()` again for the shared error mapping). Throws what the
 * fetch throws (a time-out is the caller's to word).
 */
export async function fetchMailSearch(
    args: MailSearchArgs,
    ctx: { baseUrl: string, fetch: NcFetch },
    opts: { delays?: readonly number[], wait?: (ms: number) => Promise<unknown> } = {},
): Promise<ReadResponse> {
    const delays = opts.delays ?? LOCK_RETRY_DELAYS_MS;
    const wait = opts.wait ?? sleep;
    const filter = toMailFilter(args.query);
    const syncBody: Record<string, unknown> = { ids: [], lastMessageTimestamp: null, init: true, sortOrder: 'newest' };
    if (filter) syncBody.query = filter;
    const fullSync = () => ctx.fetch(api(ctx.baseUrl, `/mailboxes/${encodeURIComponent(String(args.mailboxId))}/sync`), {
        method: 'POST',
        headers: { ...baseHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(syncBody),
    });
    if (!filter) return retryWhileLocked(fullSync, delays, wait);

    const params = new URLSearchParams({ mailboxId: String(args.mailboxId), limit: String(args.limit), view: 'singleton', filter });
    const cacheRead = () => ctx.fetch(api(ctx.baseUrl, `/messages?${params}`), { headers: baseHeaders });
    const res = await retryWhileLocked(cacheRead, delays, wait);
    if (!isNotCached(res)) return res;
    return retryWhileLocked(fullSync, delays, wait);
}
