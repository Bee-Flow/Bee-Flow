// @typecheck
/**
 * The two halves of a "scan what is due, work it off" job, shared by
 * jobs/datatableNcSync.js and jobs/studioAppConnectorSync.js.
 *
 *   runWorkerPool(items, 3, async (item) => ...)
 *     A pool of at most `concurrency` workers pulling from one shared cursor:
 *     bounded parallelism without letting a fast item wait on a slow one.
 *
 *   const tick = createLockedTick({ pool, lockKey, job, label, run });
 *     One pass of a periodic job under a session advisory lock on a NUMBERED
 *     key (`pg_try_advisory_lock($1)`), so only one replica scans per tick,
 *     plus an in-process in-flight guard so a slow upstream cannot stack
 *     ticks. `run()` resolving `false` (or throwing) marks the pass as an
 *     error in the `recordJobRun` series; a pass another replica owns records
 *     nothing. Jobs locked by NAME use ./namedLock.js instead.
 */

'use strict';

const metrics = require('../../telemetry/metrics');
const log = require('../../telemetry/log');

/**
 * @template T
 * @param {T[]} items
 * @param {number} concurrency
 * @param {(item: T) => Promise<void>} worker
 * @returns {Promise<void>}
 */
async function runWorkerPool(items, concurrency, worker) {
    let cursor = 0;
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        for (;;) {
            const i = cursor++;
            if (i >= items.length) return;
            await worker(items[i]);
        }
    });
    await Promise.all(workers);
}

/**
 * @param {{
 *   pool: { connect: () => Promise<{ query: (sql: string, params?: any[]) => Promise<{ rows: any[] }>, release: () => void }> },
 *   lockKey: number,
 *   job: string,
 *   label: string,
 *   run: () => Promise<boolean|void>,
 * }} opts
 * @returns {() => Promise<void>}
 */
function createLockedTick({ pool, lockKey, job, label, run }) {
    let inFlight = false;
    return async function lockedTick() {
        if (inFlight) return;
        inFlight = true;
        /** @type {any} */
        let client = null;
        let acquired = false;
        const t0 = Date.now();
        let ok = true;
        try {
            client = await pool.connect();
            const lockRes = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [lockKey]);
            acquired = !!lockRes.rows[0]?.locked;
            if (!acquired) return; // another replica owns this tick
            if ((await run()) === false) ok = false;
        } catch (e) {
            ok = false;
            log.warn(`[${label}] tick error:`, /** @type {any} */ (e).message);
        } finally {
            if (client) {
                try { if (acquired) await client.query('SELECT pg_advisory_unlock($1)', [lockKey]); } catch (_) { /* best-effort */ }
                client.release();
            }
            if (acquired) metrics.recordJobRun({ job, status: ok ? 'ok' : 'error', durationMs: Date.now() - t0 });
            inFlight = false;
        }
    };
}

module.exports = { runWorkerPool, createLockedTick };
