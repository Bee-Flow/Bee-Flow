import { dataErrorFromResponse, makeDataError } from './dataErrors';
import { API_BASE, authFetch } from '../../../../../utils/helpers';

/**
 * App Studio runtime — the read coalescer.
 *
 * A screen binds one component to one query, and the runtime spent one HTTP
 * request per binding: a 19-tile dashboard cost 19 requests of a 60-per-minute
 * budget the viewer's own clicks draw from too, which is why clicking around
 * produced "Too many requests" on whichever component happened to ask last.
 * This module collects the reads that start within the same few milliseconds
 * and sends them as one POST to /data/batch.
 *
 * react-query is untouched: every binding keeps its own query, key, staleTime,
 * interval and invalidation. Only the TRANSPORT underneath is shared.
 *
 * ── THE RULE THAT MAKES THIS SAFE ───────────────────────────────────
 *
 * A batch-level failure is NEVER data.
 *
 * It has to be spelled out because the single-request path deliberately fails
 * soft: `fetchBinding` turns a 404 into `[]`, so a screen bound to a table that
 * does not exist shows an empty grid instead of an error. Two other things in
 * this codebase answer 404 by design — publicAppTransport (fail-closed: any
 * suffix the anonymous router does not serve) and the demo transport (no
 * fixture) — and an older server answers 404 for a route it has never heard of.
 * Had this module reused that fail-soft rule at the batch level, the first
 * deploy where the client ran ahead of the server, and EVERY public page on a
 * server without the public batch route, would have rendered blank. Not broken:
 * blank. No error, no retry, just an app with nothing in it.
 *
 * So a batch-level answer is sorted into exactly three outcomes:
 *
 *   • 200 with `{ results: [...] }` — the only shape that yields data, and only
 *     for the ids actually present in it.
 *   • 404 / 405 / 501, or a 200 that is not that shape — "this transport cannot
 *     batch". Batching is switched off for the app and every waiting read is
 *     handed back as NOT_BATCHED, which the caller answers with the ordinary
 *     one-request-per-binding path it has always used.
 *   • anything else (429, 5xx, a network failure) — a real failure, propagated
 *     to every waiting read so react-query sees it. A 429 keeps its Retry-After
 *     and is retried; a 500 is shown rather than hidden behind N retries.
 */

/** Handed back when a read must be made the old way. Never confusable with data. */
export const NOT_BATCHED = Symbol('app-data:not-batched');

/**
 * How many reads may travel together.
 *
 * The server caps a batch at 25; staying well under that leaves room for the
 * one screen that grows past today's largest, and keeps a single failed batch
 * from taking a whole dashboard down with it.
 */
export const MAX_BATCH_READS = 12;

/**
 * Under the server's 64KB body cap, with room for the envelope. A filter that
 * carries a long list of ids is the realistic way to approach it.
 */
const MAX_BATCH_BYTES = 48 * 1024;

/**
 * The coalescing window. Long enough for one screen's bindings — they mount in
 * the same commit — and short enough to be invisible next to a round trip.
 */
const WINDOW_MS = 8;

/** appId → { supported, queue: Map<id, entry>, timer } */
const apps = new Map();
const supportListeners = new Set();

function stateFor(appId) {
    let st = apps.get(appId);
    if (!st) {
        st = { supported: true, queue: new Map(), timer: null };
        apps.set(appId, st);
    }
    return st;
}

/**
 * Whether reads for this app are still being batched.
 *
 * Optimistic before the first answer: the endpoint has shipped, and the cost of
 * being wrong is one wasted request per app per session. AppDataScope reads
 * this to size its polling interval — a downgraded app is back to one request
 * per binding and must be spaced out accordingly.
 */
export function isBatchingAvailable(appId) {
    const st = apps.get(appId);
    return st ? st.supported : true;
}

/** Subscribe to the flag above (useSyncExternalStore-shaped). */
export function subscribeBatchAvailability(listener) {
    supportListeners.add(listener);
    return () => supportListeners.delete(listener);
}

function disableBatching(appId, why) {
    const st = stateFor(appId);
    if (!st.supported) return;
    st.supported = false;
    // Worth one line in the console: on a self-host this is the difference
    // between "the server is older than the app shell" and a mystery.
    console.info(`[AppData] batching off for ${appId} — ${why}. Falling back to one request per binding.`);
    for (const listener of supportListeners) {
        try { listener(); } catch { /* a listener must not break the fetch path */ }
    }
}

/** How many requests a round of N bindings costs — the polling interval needs it. */
export function requestsForBindings(appId, count) {
    if (!count) return 0;
    return isBatchingAvailable(appId) ? Math.ceil(count / MAX_BATCH_READS) : count;
}

/**
 * Split the queue into batches that respect BOTH caps.
 *
 * A read too large to share a batch with anything is sent alone rather than
 * dropped; if it is too large even for that, the server's own 413 answers it,
 * and that is a real error worth seeing.
 */
function chunk(entries) {
    const out = [];
    let current = [];
    let bytes = 2;
    for (const entry of entries) {
        const size = entry.bytes;
        if (current.length && (current.length >= MAX_BATCH_READS || bytes + size > MAX_BATCH_BYTES)) {
            out.push(current);
            current = [];
            bytes = 2;
        }
        current.push(entry);
        bytes += size + 1;
    }
    if (current.length) out.push(current);
    return out;
}

function settleAll(entries, settle) {
    for (const entry of entries) {
        for (const waiter of entry.waiters) settle(waiter);
    }
}

async function send(appId, entries) {
    const url = `${API_BASE}/api/studio-apps/${encodeURIComponent(appId)}/data/batch`;
    let res;
    try {
        res = await authFetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reads: entries.map((e) => e.read) }),
        });
    } catch (err) {
        // A network failure is a network failure on either path — surfacing it
        // is right, and downgrading would only turn one failed request into N.
        settleAll(entries, (w) => w.reject(err));
        return;
    }

    // The route is not there: an older server, a proxy, or a fail-closed
    // transport (public page, demo) refusing a suffix it does not serve.
    if (res.status === 404 || res.status === 405 || res.status === 501) {
        disableBatching(appId, `the server answered ${res.status} for /data/batch`);
        settleAll(entries, (w) => w.resolve(NOT_BATCHED));
        return;
    }

    let body = null;
    try { body = await res.json(); } catch { body = null; }

    if (!res.ok) {
        // 429 above all: it carries Retry-After and means "wait", not "fail".
        const err = dataErrorFromResponse(res, body, 'Could not load data');
        settleAll(entries, (w) => w.reject(err));
        return;
    }

    if (!Array.isArray(body?.results)) {
        // A 200 that is not a batch answer — an SPA shell served by a rewrite
        // rule, a proxy's own page, a transport that swallowed the call. It is
        // not data and must never be treated as such.
        disableBatching(appId, 'the response was not a batch result');
        settleAll(entries, (w) => w.resolve(NOT_BATCHED));
        return;
    }

    const byId = new Map();
    for (const r of body.results) {
        if (r && typeof r.id === 'string') byId.set(r.id, r);
    }
    for (const entry of entries) {
        const result = byId.get(entry.read.id);
        for (const waiter of entry.waiters) {
            // A read the server did not answer for is NOT an empty read. It goes
            // back through the single-request path, where a real 404 can degrade
            // to an empty list on its own terms.
            if (!result) waiter.resolve(NOT_BATCHED);
            else waiter.resolve({ result, appVersion: body.appVersion });
        }
    }
}

function flush(appId) {
    const st = stateFor(appId);
    st.timer = null;
    const entries = [...st.queue.values()];
    st.queue.clear();
    if (!entries.length) return;
    for (const batch of chunk(entries)) send(appId, batch);
}

/**
 * Queue one read.
 *
 * Resolves with `{ result, appVersion }` — where `result` is the server's
 * per-read `{ ok, data }` or `{ ok:false, status, error }` — or with
 * NOT_BATCHED when the caller should make the request itself. Rejects only on a
 * real transport failure.
 *
 * Two bindings with the same id inside one window share a single read: the id
 * IS the binding's cache key, so they are by definition the same query.
 */
export function queueRead(appId, read) {
    const st = stateFor(appId);
    if (!st.supported || !appId || !read || typeof read.id !== 'string') {
        return Promise.resolve(NOT_BATCHED);
    }
    return new Promise((resolve, reject) => {
        let entry = st.queue.get(read.id);
        if (!entry) {
            let bytes = 0;
            try { bytes = JSON.stringify(read).length; } catch { bytes = MAX_BATCH_BYTES; }
            entry = { read, bytes, waiters: [] };
            st.queue.set(read.id, entry);
        }
        entry.waiters.push({ resolve, reject });
        if (st.timer === null) st.timer = setTimeout(() => flush(appId), WINDOW_MS);
    });
}

/**
 * Unwrap one per-read result.
 *
 * `notFoundValue` is what a 404 means for THIS binding — `[]` for a list, null
 * for a single record or a dataset. The caller passes it because the caller is
 * the single-request path, and the two must degrade identically or a table
 * would look empty on one road and broken on the other.
 *
 * Every other refusal throws, carrying the status the server assigned it, so
 * the retry rule and the connector banner behave exactly as before.
 */
export function unwrapReadResult(result, notFoundValue) {
    if (result.ok) return result.data;
    if (result.status === 404) return notFoundValue;
    throw makeDataError({ status: result.status, message: result.error, code: result.code, provider: result.provider });
}

/** Tests only — the module state is process-wide by design. */
export function __resetBatchClient() {
    for (const st of apps.values()) {
        if (st.timer !== null) clearTimeout(st.timer);
    }
    apps.clear();
    supportListeners.clear();
}
