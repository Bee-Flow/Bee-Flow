'use strict';

/**
 * How many code-step isolates may run at once, in this process and per org.
 *
 * Each run is a whole V8 isolate: up to `memoryMb` of heap (and isolated-vm
 * says a determined script can use two or three times that), plus a thread.
 * They run IN the API process, so without a cap one tenant starting fifty
 * runs at once, by a webhook storm or on purpose, takes memory and CPU from
 * every other tenant on the pod. A run that finds no free slot waits in a
 * FIFO queue; one that waits too long fails with a plain "busy" error rather
 * than piling up without end.
 *
 *   const release = await acquireSlot({ key: orgId });
 *   try { ... } finally { release(); }
 *
 * `key` is the fairness unit (the org). A key already at its own cap waits
 * even when the process has free slots, so one org can never hold them all.
 */

const MAX_TOTAL = Math.max(1, Number(process.env.CODE_STEP_MAX_CONCURRENCY) || 4);
const MAX_PER_KEY = Math.max(1, Math.min(MAX_TOTAL, Number(process.env.CODE_STEP_MAX_CONCURRENCY_PER_ORG) || 2));
const MAX_WAIT_MS = 20_000;

function createSlots({ maxTotal = MAX_TOTAL, maxPerKey = MAX_PER_KEY, maxWaitMs = MAX_WAIT_MS } = {}) {
    let running = 0;
    const perKey = new Map();
    const queue = [];

    const canStart = (key) => running < maxTotal && (perKey.get(key) || 0) < maxPerKey;

    function start(key) {
        running += 1;
        perKey.set(key, (perKey.get(key) || 0) + 1);
        let released = false;
        return () => {
            if (released) return;
            released = true;
            running -= 1;
            const left = (perKey.get(key) || 1) - 1;
            if (left > 0) perKey.set(key, left); else perKey.delete(key);
            drain();
        };
    }

    // First waiter whose key has room goes next; a waiter blocked only by
    // its own key's cap does not hold up another org behind it.
    function drain() {
        for (let i = 0; i < queue.length && running < maxTotal; ) {
            const w = queue[i];
            if (canStart(w.key)) {
                queue.splice(i, 1);
                clearTimeout(w.timer);
                w.resolve(start(w.key));
            } else {
                i += 1;
            }
        }
    }

    function acquireSlot({ key = '_' } = {}) {
        const k = key == null ? '_' : String(key);
        // drain() starts every waiter that CAN start, so whoever is still
        // queued is blocked by its own org's cap. A free slot plus room for
        // this org therefore means nobody ahead of it could have used it.
        if (canStart(k)) return Promise.resolve(start(k));
        return new Promise((resolve, reject) => {
            const w = { key: k, resolve, timer: null };
            w.timer = setTimeout(() => {
                const at = queue.indexOf(w);
                if (at >= 0) queue.splice(at, 1);
                reject(new Error('Code steps are busy on this server right now. Try again in a moment.'));
            }, maxWaitMs);
            queue.push(w);
        });
    }

    const stats = () => ({ running, waiting: queue.length, perKey: Object.fromEntries(perKey) });
    return { acquireSlot, stats };
}

const shared = createSlots();

module.exports = { acquireSlot: shared.acquireSlot, stats: shared.stats, createSlots, MAX_TOTAL, MAX_PER_KEY };
