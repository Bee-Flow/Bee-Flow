/**
 * "Ask this app only once per run" — a run-scoped memo for identical read calls.
 *
 * The shape this exists for: a forEach over 200 rows that looks the same thing
 * up every time. execForEachStep dispatches the body once per item, so one
 * shared lookup inside a 200-row loop is 200 identical upstream calls in a few
 * seconds. This collapses them to one.
 *
 * ── WHY RUN-SCOPED, AND NOTHING WIDER ───────────────────────────────
 * Everything here lives on the run's ctx and dies with it. No table, no Redis,
 * no cross-replica state, no new run-step status, no migration. It therefore
 * cannot cross a user, an organisation, a run or a replica BY CONSTRUCTION,
 * which is a much stronger guarantee than a key scheme that merely tries to.
 * A durable cross-run cache is a separate, opt-in, off-by-default feature with
 * its own storage and its own kill switches; this is the safe subset.
 *
 * ── WHAT IS IN THE KEY, AND WHY ─────────────────────────────────────
 * Every component below is there because leaving it out is a real leak or a
 * real wrong answer, not because it might be:
 *
 *   stepUserId / stepOrgId  the EFFECTIVE identity after connection lending
 *                           (execAi resolves it), never ctx.userId. Keying on
 *                           ctx.userId would serve one user's Gmail to another
 *                           the moment lending is enabled.
 *   connectionId / grantId  a lend revoked mid-run must stop being served.
 *   integration server      nextcloud/youtrack/n8n/afas resolve a PER-USER
 *                           host; two users' "same" call hit different servers.
 *   destination             internal vs external changes what was sent.
 *   policy action + scope   under 'tokenize' the args are run-vault
 *                           placeholders and under 'redact' they are masked —
 *                           three different payloads leave the box, so three
 *                           different answers come back.
 *   the args themselves     post-guard, post-prepareForEgress: what actually
 *                           went out, not what the author typed.
 *
 * Only the digest is kept. resolveInputs runs with allowSecrets, so the joined
 * plaintext can contain a resolved {{secrets.*}} — it is hashed and dropped,
 * never stored, logged, or returned by stats().
 */

'use strict';

const crypto = require('crypto');

const DEFAULT_TTL_MS = 300_000;          // 5 minutes
// 64, not 200. An http_request answer may be up to 1 MiB (see the per-entry
// override on store()), so the ENTRY count stopped being the binding
// constraint — 200 slots against a 16 MiB budget is a count that can never be
// reached, which is a cap that does not cap. The byte budget binds instead.
const MAX_ENTRIES = 64;
const MAX_ENTRY_BYTES = 262_144;         // mirrors payloadTruncation's per-step cap
const MAX_TOTAL_BYTES = 16 << 20;        // 16 MiB

/**
 * Deterministic JSON so two structurally-equal argument objects hash the same
 * regardless of key order. Arrays keep their order — filter order is meaningful.
 */
function stableStringify(value) {
    if (value === null || value === undefined) return 'null';
    if (typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
    const keys = Object.keys(value).sort();
    return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

/** Deep clone on every hand-back. */
function clone(v) {
    if (v === null || typeof v !== 'object') return v;
    try { return structuredClone(v); } catch { return JSON.parse(JSON.stringify(v)); }
}

function byteLen(v) {
    try { return Buffer.byteLength(JSON.stringify(v) || '', 'utf8'); } catch { return Infinity; }
}

/**
 * The IDENTITY of a call, as one canonical string — before any digest.
 *
 * Exported because the durable cross-run cache (stores/integrationCacheStore)
 * keys on the same identity but digests it differently: it needs an HMAC under
 * a server secret, since a stored plain hash of a small argument space
 * ({"email":"someone@a-company.com"}) is confirmable by anyone holding a
 * database dump. Both callers deriving from THIS function is what stops the
 * two caches from disagreeing about what "the same call" is.
 *
 * The string itself is plaintext and may contain a resolved {{secrets.*}} —
 * it is a value to digest immediately, never one to store, log or return.
 */
function memoKeyParts({
    toolName, stepUserId, stepOrgId, connectionId, grantId,
    integrationServer, destination, policyAction, policyScope, args,
}) {
    return [
        'v1', toolName || '-',
        stepUserId || '-', stepOrgId || '-',
        connectionId || '-', grantId || '-',
        integrationServer || '-',
        destination || 'external',
        policyAction || 'off', policyScope || 'external',
        stableStringify(args),
    ].join('\0');
}

/** The run-memo key for an already-built identity string. */
function memoKeyFromParts(identity) {
    return crypto.createHash('sha256').update(String(identity || '')).digest('hex');
}

/**
 * Build the run-memo key. Exported so the eligibility test and the executor
 * cannot disagree about what "the same call" means.
 */
function memoKey(parts) {
    return memoKeyFromParts(memoKeyParts(parts));
}

/**
 * One memo per run. Created in the ctx OBJECT LITERAL, never lazily: container
 * steps shallow-copy ctx (execFlow does `{...ctx, _branchIndex}`), so a lazy
 * assignment first reached inside a parallel branch would land on that branch's
 * COPY and be invisible to its siblings — the same trap ctx.allowedToolNames
 * falls into.
 */
function createToolMemo({
    ttlMs = DEFAULT_TTL_MS,
    maxEntries = MAX_ENTRIES,
    maxEntryBytes = MAX_ENTRY_BYTES,
    maxTotalBytes = MAX_TOTAL_BYTES,
    // This ctx continues a run that PAUSED — see clear() and hasSlept(). A
    // pause is at least as strong a signal as a Wait and is the one that can
    // last days: an approval sits for a week, a form page until somebody
    // answers it. Without this a 30-second Wait closed the durable tier for
    // the rest of the run while a seven-day approval reopened it, which is
    // backwards.
    startSlept = false,
    now = () => Date.now(),
} = {}) {
    const entries = new Map();    // key → { value, expires, bytes }
    let totalBytes = 0;
    let hits = 0;
    let misses = 0;
    // Answers that came from the DURABLE cross-run cache rather than this run.
    // Counted here rather than on ctx because container steps shallow-copy ctx
    // (execFlow does {...ctx, _branchIndex}), so a counter on ctx would be
    // incremented on a branch's COPY and lost. The memo is shared by reference.
    let durableHits = 0;
    // Answers the memo REFUSED to keep — too large, or the caps were full.
    // Counted because "the reuse did nothing" and "the reuse was never asked
    // for" are indistinguishable from a run summary that reports only hits: a
    // step ticked "ask only once" whose answer is 300 KB looks exactly like a
    // step nobody ticked, and the author has no way to find out which.
    let refused = 0;
    // Has this run SLEPT? See clear() — the answer gates the durable tier too.
    // A resumed segment starts already slept: the gap it is on the far side of
    // is the pause, and nothing about it is shorter than a Wait.
    let slept = startSlept === true;

    function evictOldest() {
        const first = entries.keys().next();
        if (first.done) return;
        const e = entries.get(first.value);
        totalBytes -= e ? e.bytes : 0;
        entries.delete(first.value);
    }

    function get(key) {
        const e = entries.get(key);
        if (!e) return undefined;
        if (e.expires <= now()) {
            entries.delete(key);
            totalBytes -= e.bytes;
            return undefined;
        }
        return e;
    }

    function put(key, value, ttl, entryBytes) {
        const bytes = byteLen(value);
        // An oversized answer is not memoised rather than truncated: a truncated
        // payload replayed as if whole is the BFSF-360 failure, where a
        // collection node then reports "arrayRef did not resolve to an array".
        //
        // The per-call ceiling exists because http_request's own response cap is
        // 1 MiB while this default is 256 KiB: without it, a 400 KiB catalogue
        // in a 200-row loop is silently refused two hundred times, and the
        // author sees a step that ignores its own tick.
        const limit = Number.isFinite(entryBytes) && entryBytes > 0 ? entryBytes : maxEntryBytes;
        if (!Number.isFinite(bytes) || bytes > limit) return false;
        while (entries.size >= maxEntries || totalBytes + bytes > maxTotalBytes) {
            if (entries.size === 0) return false;
            evictOldest();
        }
        entries.set(key, { value, expires: now() + (ttl || ttlMs), bytes });
        totalBytes += bytes;
        return true;
    }

    /**
     * The memoised answer for `key`, or `undefined` on a miss or once expired.
     * Always a deep CLONE — callers mutate what they are handed, and
     * scanCache's _cloneScanResult exists because one that did not corrupted
     * the shared entry.
     */
    function peek(key) {
        if (!key) return undefined;
        const e = get(key);
        if (!e) { misses++; return undefined; }
        hits++;
        return clone(e.value);
    }

    /**
     * Remember an answer. Returns false when it was refused (too large, or the
     * caps are full), so the caller can tell "not stored" from "stored".
     *
     * A FAILURE IS NEVER STORED — a thrown dispatch never gets this far, and
     * execAi screens the soft `{ error }` results that arrive as an ordinary
     * value. A transient 500 must not become the answer for the rest of the run.
     *
     * NOTE: there is deliberately no single-flight here. The shape this feature
     * exists for — a forEach over N rows — is dispatched SEQUENTIALLY by
     * execForEachStep, so a fan-out never has two identical calls in the air at
     * once and the memo alone collapses them. Concurrency only arises through
     * execParallel's branches; sharing an in-flight promise across those is a
     * later pass, not something to claim before it is written.
     */
    function store(key, value, ttl, maxBytes) {
        // No key means the call was never eligible — that is not a refusal,
        // and counting it would report reuse doing nothing on runs that never
        // asked for any.
        if (!key) return false;
        const stored = put(key, value, ttl, maxBytes);
        if (!stored) refused++;
        return stored;
    }

    /**
     * An answer served from the durable cross-run cache. Separate from `hits`
     * because they are different sentences to a person reading a finished run:
     * one says "we asked once instead of two hundred times", the other says
     * "we did not ask this app at all today".
     */
    function recordDurableHit() { durableHits++; }

    /**
     * Drop everything. Called after a Wait: "once per run" is not a time bound,
     * and a run that slept an hour must not answer from before the sleep.
     */
    function clear() {
        entries.clear();
        totalBytes = 0;
        // Emptying the entries is only half of it. Without this flag the next
        // look-up falls THROUGH to the durable cross-run cache and is served
        // the very answer the clear was meant to discard — its TTL is up to an
        // hour, and a Wait is usually far shorter than that, so the stale
        // answer would outlive the sleep that was supposed to invalidate it.
        slept = true;
    }

    /**
     * True once the run has slept, or once it is the continuation of a run that
     * PAUSED. execAi refuses the durable cache after this for the whole rest of
     * the run: a Wait is the author saying "let the other system catch up", and
     * there is no reading of that under which an answer fetched before the
     * sleep is still what they asked for. An approval or a form pause says the
     * same thing more strongly — it waits on a person, so it can last days.
     */
    function hasSlept() { return slept; }

    /** Counters for the run summary. Never any keys, never any values. */
    function stats() {
        return { hits, misses, durableHits, refused, entries: entries.size, bytes: totalBytes };
    }

    return { peek, store, clear, stats, recordDurableHit, hasSlept, _entries: entries };
}

module.exports = {
    createToolMemo, memoKey, memoKeyParts, memoKeyFromParts, stableStringify,
    DEFAULT_TTL_MS, MAX_ENTRY_BYTES, MAX_ENTRIES, MAX_TOTAL_BYTES,
};
