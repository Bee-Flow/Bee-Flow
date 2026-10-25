// @typecheck
/**
 * Bookkeeping for dlpRunner's per-conversation token maps: last access, which
 * maps are newer than their database copy, and idle / LRU eviction. The maps
 * themselves stay in dlpRunner; they are handed in here.
 *
 * An entry is evicted ONLY when the database already holds its map, so the next
 * use re-runs the hydrate and gets the same tokens back:
 *   - a conversation is "dirty" from a merge until a write-through that covers
 *     it succeeds (write pending or in flight, failed, or no row to write to,
 *     e.g. an ephemeral scope). Dirty entries are never evicted.
 *   - an id whose hydration is in flight is never evicted either.
 * Both limits are env knobs read at call time; 0 switches that limit off.
 */

const log = require('../../telemetry/log');
const { bestEffort } = require('../../utils/bestEffort');

const SWEEP_MIN_GAP_MS = 30 * 1000;
const SWEEP_TIMER_MS = 5 * 60 * 1000;

/**
 * @param {string} name
 * @param {number} dflt
 */
function envInt(name, dflt) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return dflt;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : dflt;
}
const idleMs = () => envInt('DLP_TOKENMAP_IDLE_MS', 2 * 60 * 60 * 1000);
const maxConversations = () => envInt('DLP_TOKENMAP_MAX_CONVERSATIONS', 2000);

// Lazily emit an operator-facing guardrail event for token-map persistence /
// eviction problems. Lazy-required so the common (no-error) path never pulls in
// the store — that keeps the persistence unit tests (which mock `../../db`)
// clean, and never lets telemetry break the chat path.
/**
 * @param {string} action_taken
 */
function emitTokenMapEvent(conversationId, action_taken, extra = {}) {
    try {
        const store = require('../../stores/guardrailEventStore');
        store.logGuardrailEvent({
            conversation_id: conversationId,
            violation_type: 'pii_tokenmap',
            action_taken,
            source: 'pii',
            violation_categories: extra.reason ? String(extra.reason).slice(0, 200) : null,
        }).catch((e) => bestEffort('core/dlp/tokenMapEviction:emitTokenMapEvent', e));
    } catch (err) { bestEffort('core/dlp/tokenMapEviction:emitTokenMapEvent#2', err); /* never let telemetry break the chat path */ }
}

/**
 * @param {{
 *   conversationTokenMaps: Map<string, Map<string, string>>,
 *   hydrated: Set<string>,
 *   notebookBound: Set<string>,
 *   persistWarned: Set<string>,
 *   hydrationInFlight: () => Map<string, Promise<void>>,
 * }} state
 */
function createTokenMapEviction(state) {
    /** @type {Map<string, number>} conversationId → epoch ms of last use, oldest first */
    const lastAccess = new Map();
    /** @type {Map<string, number>} conversationId → merge counter while unpersisted */
    const dirty = new Map();
    let lastSweepAt = 0;
    /** @type {NodeJS.Timeout | null} */
    let timer = null;

    /**
     * @param {string} id
     */
    const evictable = (id) => !dirty.has(id) && !state.hydrationInFlight().has(id);

    /**
     * @param {string} id
     */
    function forget(id) {
        state.conversationTokenMaps.delete(id);
        state.hydrated.delete(id);
        state.notebookBound.delete(id);
        state.persistWarned.delete(id);
        lastAccess.delete(id);
        dirty.delete(id);
    }

    /**
     * Evict idle conversations, then the least recently used beyond the count
     * cap. Returns how many were evicted. Safe to call at any time.
     * @param {number} [now]
     */
    function sweepIdle(now = Date.now()) {
        lastSweepAt = now;
        const idle = idleMs();
        const max = maxConversations();
        if (idle === 0 && max === 0) return 0;
        let evicted = 0;
        if (idle > 0) {
            for (const [id, at] of [...lastAccess]) {
                if (now - at <= idle) break; // oldest first: the rest are newer
                if (evictable(id)) { forget(id); evicted++; }
            }
        }
        if (max > 0 && lastAccess.size > max) {
            for (const id of [...lastAccess.keys()]) {
                if (lastAccess.size <= max) break;
                if (evictable(id)) { forget(id); evicted++; }
            }
        }
        if (evicted > 0) log.debug(`[DlpRunner] evicted ${evicted} idle token map(s); ${lastAccess.size} held`);
        return evicted;
    }

    /**
     * @param {string} id
     */
    function touch(id) {
        if (!id) return;
        const now = Date.now();
        lastAccess.delete(id); // re-insert: iteration order stays least-recently-used first
        lastAccess.set(id, now);
        if (now - lastSweepAt >= SWEEP_MIN_GAP_MS) sweepIdle(now);
        if (!timer) {
            timer = setInterval(() => sweepIdle(), SWEEP_TIMER_MS);
            if (typeof timer.unref === 'function') timer.unref();
        }
    }

    /**
     * A merge made the in-process map newer than the database copy.
     * @param {string} id
     */
    function markDirty(id) { dirty.set(id, (dirty.get(id) || 0) + 1); }

    /**
     * Snapshot the dirty version before a write; call the returned function
     * once the write landed. It cleans the entry unless a newer merge arrived.
     * @param {string} id
     */
    function beginWrite(id) {
        const v = dirty.get(id);
        return () => { if (dirty.get(id) === v) dirty.delete(id); };
    }

    return { touch, sweepIdle, markDirty, beginWrite, forget };
}

module.exports = { createTokenMapEviction, emitTokenMapEvent };
