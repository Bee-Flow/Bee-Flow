'use strict';
const log = require('../../telemetry/log');

/**
 * Run-scoped PII token vault.
 *
 * Automations used to mint a fresh token namespace per STEP. Two consequences,
 * both live bugs:
 *   1. `guardToolOutput` dropped its token map, so a tokenized tool result
 *      entered `runState` as a literal `[person_1]` that NOTHING could restore
 *      — it travelled through every downstream node into emails and documents.
 *   2. Even where a map existed, `[person_1]` in step 2 and `[person_1]` in
 *      step 5 could be different people, and a token already sitting in
 *      `runState` was invisible to the next step's guard (a placeholder is not
 *      PII, so it is never detected and never restored).
 *
 * One vault per run fixes both. Every mint is seeded from it, so `tokenizeText`
 * reuses the placeholder a value already has (its alias folding makes
 * "Tom"/"Tom Smit" land on the same token too), and every restore point has the
 * complete map — an unrestorable token can no longer exist.
 *
 * Sharing: the vault lives on `ctx`, and container steps shallow-copy ctx
 * (`{...ctx}` in execParallel / execLoop / execCallLayer / execCallBlock), so
 * every branch, iteration and sub-layer holds the SAME object reference. No
 * threading needed.
 *
 * Persistence: written through to `automation_runs.pii_token_map` so an
 * approval pause, a retry, or a partial replay picks the run up in another
 * process with its placeholders intact.
 */

// Mirrors dlpRunner's per-conversation ceiling. A runaway loop must not be able
// to grow an unbounded map in memory (and in a JSONB column).
const MAX_TOKENS_PER_RUN = 5000;

// Write-through debounce. A step that tokenizes 40 leaves must not produce 40
// UPDATEs; the run's terminal flush is awaited, so this timer only exists to
// keep the DB copy fresh for a crash mid-run.
const PERSIST_DEBOUNCE_MS = 250;

/**
 * @param {object}  opts
 * @param {string}  opts.runId
 * @param {object}  [opts.seed]     prior map (resume / retry / calling chat)
 * @param {function} [opts.persist] async (runId, map) => void; injected for tests
 * @param {function} [opts.onEvict] called with the evicted count (audit marker)
 */
function createTokenVault({ runId = null, seed = null, persist = null, onEvict = null } = {}) {
    /** @type {Record<string,string>} token → real value */
    const map = {};
    let dirty = false;
    let evicted = 0;
    // Serialises the mint critical section. Detection (slow, network) happens
    // OUTSIDE this; only tokenizeText + merge are held, so parallel branches
    // still scan concurrently but can never mint the same label for two
    // different values.
    let queue = Promise.resolve();
    let persistTimer = null;

    if (seed && typeof seed === 'object') {
        for (const [k, v] of Object.entries(seed)) {
            if (typeof k === 'string' && typeof v === 'string') map[k] = v;
        }
    }

    function _capacity() {
        const over = Object.keys(map).length - MAX_TOKENS_PER_RUN;
        if (over <= 0) return;
        // Front-eviction (insertion order): the OLDEST tokens go first, which
        // are the ones least likely to still be in flight. They do become
        // unrestorable, so this is audited rather than silent.
        const keys = Object.keys(map).slice(0, over);
        for (const k of keys) delete map[k];
        evicted += keys.length;
        log.warn(`[TokenVault] run=${runId} evicted ${keys.length} token(s) at the ${MAX_TOKENS_PER_RUN} ceiling — those placeholders can no longer be restored`);
        if (onEvict) { try { onEvict(keys.length); } catch (_) { /* audit must never break a run */ } }
    }

    function merge(tokenMap) {
        if (!tokenMap) return;
        const entries = tokenMap instanceof Map ? [...tokenMap.entries()] : Object.entries(tokenMap);
        let added = 0;
        for (const [k, v] of entries) {
            if (typeof k !== 'string' || typeof v !== 'string') continue;
            if (map[k] === v) continue;
            map[k] = v;
            added++;
        }
        if (!added) return;
        dirty = true;
        _capacity();
        _schedulePersist();
    }

    function _schedulePersist() {
        if (persistTimer || !runId || !persist) return;
        persistTimer = setTimeout(() => {
            persistTimer = null;
            flush().catch(() => { /* flush already logs */ });
        }, PERSIST_DEBOUNCE_MS);
        // Never hold the process open for a token map — the terminal flush is
        // awaited by the runner.
        if (persistTimer.unref) persistTimer.unref();
    }

    /**
     * Run `fn(currentMap)` under the mint lock and absorb the token map it
     * returns. `fn` may be sync or async, but keep it SHORT — anything slow
     * (a GLiNER call) belongs outside.
     *
     * @param {(seedMap: Record<string,string>) => any} fn
     * @returns whatever fn returned
     */
    function mint(fn) {
        const result = queue.then(async () => {
            const r = await fn(map);
            if (r && r.tokenMap) merge(r.tokenMap);
            return r;
        });
        // Keep the chain alive even if this mint threw, so one bad leaf can't
        // deadlock every later mint in the run.
        queue = result.then(() => undefined, () => undefined);
        return result;
    }

    async function flush() {
        if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
        if (!dirty || !runId || !persist) return false;
        // Clear BEFORE awaiting: a concurrent merge during the write must
        // re-mark dirty rather than be swallowed by this flush's completion.
        dirty = false;
        try {
            await persist(runId, { ...map });
            return true;
        } catch (e) {
            dirty = true;
            log.warn(`[TokenVault] run=${runId} could not persist the token map: ${e.message}`);
            return false;
        }
    }

    return {
        runId,
        all: () => map,
        snapshot: () => ({ ...map }),
        merge,
        mint,
        flush,
        get size() { return Object.keys(map).length; },
        get dirty() { return dirty; },
        get evicted() { return evicted; },
    };
}

/** Default persister — kept out of createTokenVault so tests can inject. */
function defaultPersist(runId, map) {
    const automationStore = require('../../stores/automationStore');
    if (typeof automationStore.saveRunTokenMap !== 'function') return Promise.resolve(false);
    return automationStore.saveRunTokenMap(runId, map);
}

module.exports = { createTokenVault, defaultPersist, MAX_TOKENS_PER_RUN };
