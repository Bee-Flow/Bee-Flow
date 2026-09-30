// @typecheck
/**
 * Per-replica fan-out of co-editing updates to the open project streams.
 *
 * ── The model ───────────────────────────────────────────────────────────────
 *
 * Postgres (stores/collabDocStore.js) is the ordered log; this hub is only a
 * cache and a router in front of it. One entry per document that has at least
 * one open stream on THIS replica:
 *
 *   entry = { head, subscribers, cache: seq → {u, by}, pumping }
 *
 * Each subscriber carries its own cursor (the last seq it was sent). `pump`
 * brings every subscriber up to `head`, in order, one merged frame per
 * subscriber per round:
 *
 *   - a write on this replica hands its plaintext to `localAppend`, so the
 *     same-replica case costs no database read at all;
 *   - a write on another replica rings the doorbell (`doc.moved {docId, seq}`
 *     on the project event bus: ids and a number, never content), and the
 *     entry reads the missing rows ONCE for all its subscribers;
 *   - a subscriber too far behind (more than `backlogMax` updates, or behind
 *     what compaction kept) gets `doc.resync` and runs the state-vector sync
 *     again: cheaper than streaming a backlog, and definitely correct.
 *
 * Applying Yjs updates is idempotent and commutative, so a frame delivered
 * twice (the sync response overlapping the stream, a resync) costs nothing,
 * while a frame never delivered is repaired by the next sync. That is why a
 * cursor plus a doorbell is enough.
 *
 * ── Backpressure ────────────────────────────────────────────────────────────
 *
 * A subscriber's `send` answers false when its socket buffer is full. The
 * subscriber is paused (skipped by `pump`) until `resume` — the stream's
 * 'drain' — so one slow reader never delays the others. The stream itself
 * ends a reader that buffers past its cap (core/http/cursorStream.js).
 *
 * ── Without Redis ───────────────────────────────────────────────────────────
 *
 * The bus is in-process then, so a write on another replica rings nothing
 * here. Each entry polls its document's head as a backstop: every 1.5 s when
 * the bus is not distributed, every 15 s when it is (a dropped publish).
 */

'use strict';

const Y = require('yjs');
const { toB64 } = require('./wire');

const DEFAULT_BACKLOG_MAX = 200;
const DEFAULT_CACHE_MAX = 256;

/**
 * Why a document closed, in the words the editor acts on
 * (agent-hub/src/editor/collab/provider.ts):
 *
 *   detached      live editing ended but the item is there: the editor goes
 *                 back to single-writer saves. The item left the project,
 *                 co-editing was switched off (`disabled`) or is not available
 *                 on this server (`unavailable`); the server's own reason
 *                 rides along as `cause`.
 *   deleted       the item is gone.
 *   role_changed  sync again.
 *   anything else (`not_found`): the editor checks with a sync; a 403/404
 *                 there ends the session, anything else reopens the stream.
 *
 * Every `doc.closed` frame is built here, so the server never sends a reason
 * the editor would misread (a switch-off read as "access revoked").
 */
const FALL_BACK_REASONS = new Set(['detached', 'disabled', 'unavailable']);

/** @param {string} docId @param {string} reason */
function closedPayload(docId, reason) {
    if (!FALL_BACK_REASONS.has(reason) || reason === 'detached') return { docId, reason };
    return { docId, reason: 'detached', cause: reason };
}

/**
 * @typedef {{ cursor: number, paused: boolean, gone: boolean,
 *   send: (kind: string, payload: object) => boolean, userId?: string|null }} Subscriber
 * @typedef {{ id: string, projectId: string, orgId?: string|null, keyScope?: string, updateSeq: number }} HubDoc
 * @typedef {{ seq: number, u: Uint8Array, by: string }} CachedUpdate
 * @typedef {{ doc: HubDoc, head: number, subs: Set<Subscriber>, cache: Map<number, CachedUpdate>,
 *   pumping: boolean, again: boolean, unsubscribe: (() => void)|null, timer: any, closed: boolean }} Entry
 */

/**
 * @param {{
 *   listUpdates: (docId: string, afterSeq: number, limit: number) => Promise<Array<{ seq: number, body: Buffer|null, userId: string|null, origin: string, agentId: string|null }>>,
 *   readHead: (docId: string) => Promise<{ updateSeq: number }|null>,
 *   openRows: (doc: HubDoc, rows: Array<{ seq: number, body: Buffer|null }>) => Promise<Uint8Array[]>,
 *   subscribeProject?: (projectId: string, handler: (ev: any) => void) => () => void,
 *   isDistributed?: () => boolean,
 *   log?: { warn: Function, info?: Function },
 *   backlogMax?: number, cacheMax?: number,
 *   pollMs?: (distributed: boolean) => number,
 *   setTimer?: (fn: () => void, ms: number) => any, clearTimer?: (t: any) => void,
 * }} deps
 */
function makeDocHub(deps) {
    const log = deps.log || require('../../telemetry/log');
    const backlogMax = deps.backlogMax || DEFAULT_BACKLOG_MAX;
    const cacheMax = deps.cacheMax || DEFAULT_CACHE_MAX;
    const subscribeProject = deps.subscribeProject || ((projectId, handler) => require('../projectEventBus').subscribeProject(projectId, handler));
    const isDistributed = deps.isDistributed || (() => require('../projectEventBus').isDistributed());
    const pollMs = deps.pollMs || ((distributed) => (distributed ? 15_000 : 1_500));
    const setTimer = deps.setTimer || ((fn, ms) => { const t = setTimeout(fn, ms); if (t.unref) t.unref(); return t; });
    const clearTimer = deps.clearTimer || ((t) => clearTimeout(t));

    /** @type {Map<string, Entry>} */
    const entries = new Map();

    /** Who wrote a row, as the stream reports it: a user id, or `ai:<agent>` for the AI. */
    const authorOf = (/** @type {{ userId: string|null, origin: string, agentId: string|null }} */ r) =>
        (r.origin === 'ai' ? `ai:${r.agentId || 'assistant'}` : (r.userId || r.origin));

    /** @param {Subscriber} s @param {string} kind @param {object} payload */
    function sendTo(s, kind, payload) {
        if (s.gone) return;
        let ok = true;
        try { ok = s.send(kind, payload) !== false; } catch (_) { ok = false; }
        if (!ok) s.paused = true;
    }

    /** @param {Entry} entry @param {Subscriber} s @param {string} reason */
    function resync(entry, s, reason) {
        sendTo(s, 'doc.resync', { docId: entry.doc.id, reason });
        s.cursor = Math.max(s.cursor, entry.head);
    }

    /** Read rows after `afterSeq` into the cache. Answers the lowest seq read, or null for none. @param {Entry} entry @param {number} afterSeq */
    async function fill(entry, afterSeq) {
        const rows = await deps.listUpdates(entry.doc.id, afterSeq, backlogMax);
        if (!rows.length) return null;
        const missing = rows.filter((r) => !entry.cache.has(r.seq));
        if (missing.length) {
            const plain = await deps.openRows(entry.doc, missing);
            missing.forEach((r, i) => entry.cache.set(r.seq, { seq: r.seq, u: plain[i], by: authorOf(r) }));
        }
        const last = rows[rows.length - 1].seq;
        if (last > entry.head) entry.head = last;
        return rows[0].seq;
    }

    /**
     * Send one subscriber everything the cache holds after its cursor, as one
     * merged frame. Answers true when something was sent.
     * @param {Entry} entry @param {Subscriber} s
     */
    function deliver(entry, s) {
        const run = [];
        for (let seq = s.cursor + 1; entry.cache.has(seq); seq += 1) run.push(/** @type {CachedUpdate} */ (entry.cache.get(seq)));
        if (!run.length) return false;
        const from = s.cursor;
        const last = run[run.length - 1].seq;
        const u = run.length === 1 ? run[0].u : Y.mergeUpdates(run.map((r) => r.u));
        const by = [...new Set(run.map((r) => r.by))];
        s.cursor = last;
        sendTo(s, 'doc.update', { docId: entry.doc.id, from, seq: last, u: toB64(u), by });
        return true;
    }

    /** Forget cached updates every subscriber has, and cap the rest. @param {Entry} entry */
    function evict(entry) {
        let floor = entry.head;
        for (const s of entry.subs) if (!s.gone && s.cursor < floor) floor = s.cursor;
        for (const seq of entry.cache.keys()) if (seq <= floor) entry.cache.delete(seq);
        while (entry.cache.size > cacheMax) {
            const lowest = Math.min(...entry.cache.keys());
            entry.cache.delete(lowest);
        }
    }

    /**
     * Bring every subscriber up to `head`. Serialised per entry: a second
     * call while one runs only asks it to go round again, so frames can never
     * overtake each other.
     * @param {Entry} entry
     */
    async function pump(entry) {
        if (entry.pumping) { entry.again = true; return; }
        entry.pumping = true;
        try {
            for (let round = 0; round < 1000; round += 1) {
                entry.again = false;
                const need = [...entry.subs].filter((s) => !s.gone && !s.paused && s.cursor < entry.head);
                if (!need.length) { if (entry.again) continue; break; }
                let progressed = false;
                for (const s of need) {
                    if (entry.head - s.cursor > backlogMax) { resync(entry, s, 'backlog'); progressed = true; }
                }
                const behind = need.filter((s) => s.cursor < entry.head);
                if (behind.length) {
                    const lowest = Math.min(...behind.map((s) => s.cursor));
                    if (!entry.cache.has(lowest + 1)) {
                        const first = await fill(entry, lowest);
                        // Compaction deleted what these readers still needed.
                        for (const s of behind) {
                            if (s.cursor < entry.head && (first === null || first > s.cursor + 1) && !entry.cache.has(s.cursor + 1)) {
                                resync(entry, s, 'behind_retention');
                                progressed = true;
                            }
                        }
                    }
                    for (const s of behind) if (!s.gone && !s.paused && deliver(entry, s)) progressed = true;
                }
                if (!progressed && !entry.again) break;
            }
        } catch (err) {
            log.warn(`[DocHub] delivery for ${entry.doc.id} failed: ${/** @type {Error} */ (err).message}`);
        } finally {
            entry.pumping = false;
            evict(entry);
        }
    }

    /** @param {Entry} entry */
    function schedulePoll(entry) {
        if (entry.closed) return;
        entry.timer = setTimer(async () => {
            entry.timer = null;
            if (entry.closed) return;
            try {
                const head = await deps.readHead(entry.doc.id);
                if (!head) { close(entry.doc.id, 'deleted'); return; }
                if (head.updateSeq > entry.head) {
                    entry.head = head.updateSeq;
                    await pump(entry);
                }
            } catch (err) {
                log.warn(`[DocHub] head check for ${entry.doc.id} failed: ${/** @type {Error} */ (err).message}`);
            }
            schedulePoll(entry);
        }, pollMs(safeDistributed()));
    }

    function safeDistributed() {
        try { return !!isDistributed(); } catch (_) { return false; }
    }

    /** @param {Entry} entry @param {any} ev */
    function onBusEvent(entry, ev) {
        if (!ev || ev.docId !== entry.doc.id || entry.closed) return;
        if (ev.kind === 'doc.moved') {
            const seq = Number(ev.seq) || 0;
            if (seq > entry.head) { entry.head = seq; pump(entry); }
        } else if (ev.kind === 'doc.awareness') {
            for (const s of entry.subs) if (!s.paused) sendTo(s, 'doc.awareness', { docId: entry.doc.id, u: ev.u, ...(ev.left ? { left: ev.left } : {}) });
        } else if (ev.kind === 'doc.awareness.query') {
            for (const s of entry.subs) if (!s.paused) sendTo(s, 'doc.awareness.query', { docId: entry.doc.id });
        } else if (ev.kind === 'doc.closed') {
            close(entry.doc.id, typeof ev.reason === 'string' ? ev.reason : 'deleted');
        }
    }

    /**
     * Attach a stream to a document. `sub.cursor` is the last seq the client
     * holds (from its sync); anything after it is delivered, in order.
     *
     * @param {HubDoc} doc a fresh row (its updateSeq is the head)
     * @param {{ cursor: number, send: (kind: string, payload: object) => boolean, userId?: string|null }} input
     * @returns {{ subscriber: Subscriber, leave: () => void }}
     */
    function join(doc, input) {
        let entry = entries.get(doc.id);
        if (!entry) {
            entry = {
                doc, head: doc.updateSeq, subs: new Set(), cache: new Map(),
                pumping: false, again: false, unsubscribe: null, timer: null, closed: false,
            };
            entries.set(doc.id, entry);
            const e = entry;
            try {
                e.unsubscribe = subscribeProject(doc.projectId, (ev) => onBusEvent(e, ev));
            } catch (err) {
                log.warn(`[DocHub] bus subscribe for ${doc.id} failed: ${/** @type {Error} */ (err).message}`);
            }
            schedulePoll(e);
        } else if (doc.updateSeq > entry.head) {
            entry.head = doc.updateSeq;
        }
        /** @type {Subscriber} */
        const s = { cursor: Math.max(0, Math.floor(input.cursor || 0)), paused: false, gone: false, send: input.send, userId: input.userId || null };
        entry.subs.add(s);
        // A cursor past the head is a client holding another incarnation of
        // this document (deleted and re-created): only a sync can fix that.
        if (s.cursor > entry.head) {
            sendTo(s, 'doc.resync', { docId: doc.id, reason: 'backlog' });
            s.cursor = entry.head;
        }
        const e = entry;
        pump(e);
        return { subscriber: s, leave: () => leave(e, s) };
    }

    /** @param {Entry} entry @param {Subscriber} s */
    function leave(entry, s) {
        s.gone = true;
        entry.subs.delete(s);
        if (entry.subs.size === 0) dispose(entry);
    }

    /** @param {Entry} entry */
    function dispose(entry) {
        entry.closed = true;
        if (entries.get(entry.doc.id) === entry) entries.delete(entry.doc.id);
        if (entry.timer) { clearTimer(entry.timer); entry.timer = null; }
        try { if (entry.unsubscribe) entry.unsubscribe(); } catch (_) { /* already gone */ }
        entry.unsubscribe = null;
        entry.cache.clear();
    }

    /**
     * A write on this replica: its plaintext goes straight to the local
     * subscribers.
     * @param {string} docId @param {{ seq: number, u: Uint8Array, by: string }} update
     */
    function localAppend(docId, update) {
        const entry = entries.get(docId);
        if (!entry) return;
        entry.cache.set(update.seq, { seq: update.seq, u: update.u, by: update.by });
        if (update.seq > entry.head) entry.head = update.seq;
        pump(entry);
    }

    /** The doorbell, for callers outside the bus. @param {string} docId @param {number} seq */
    function wake(docId, seq) {
        const entry = entries.get(docId);
        if (!entry) return;
        if (seq > entry.head) entry.head = seq;
        pump(entry);
    }

    /** A paused subscriber's socket drained. @param {string} docId @param {Subscriber} s */
    function resume(docId, s) {
        const entry = entries.get(docId);
        if (!entry || s.gone) return;
        s.paused = false;
        pump(entry);
    }

    /** Tell every local subscriber the document is gone, and forget it. @param {string} docId @param {string} reason */
    function close(docId, reason) {
        const entry = entries.get(docId);
        if (!entry) return;
        for (const s of entry.subs) { sendTo(s, 'doc.closed', closedPayload(docId, reason)); s.gone = true; }
        entry.subs.clear();
        dispose(entry);
    }

    /** Test and shutdown seam. */
    function _reset() {
        for (const entry of [...entries.values()]) dispose(entry);
    }

    return {
        join, localAppend, wake, resume, close, pump,
        /** @param {string} docId */
        subscriberCount: (docId) => entries.get(docId)?.subs.size || 0,
        activeDocs: () => [...entries.keys()],
        _reset,
    };
}

module.exports = { makeDocHub, closedPayload, DEFAULT_BACKLOG_MAX };
