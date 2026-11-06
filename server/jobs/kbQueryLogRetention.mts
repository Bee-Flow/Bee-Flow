/**
 * KB query log retention: delete log rows whose `expires_at` has passed.
 *
 * `expires_at` is the row's creation time plus the retention term of its knowledge base at the
 * time of writing (a shorter term later recomputes it, see the store's recomputeExpiry). Hourly,
 * in batches, so a large backlog never holds one long transaction.
 *
 * Not gated on the licence: reading and deleting must keep working after a licence lapses, or
 * the retention promise would break exactly when nobody is paying attention.
 *
 * MULTI-POD SAFE: one pass at a time across replicas, under a session advisory lock keyed by
 * name (jobs/lib/namedLock). Kill switch: KB_QUERY_LOG_RETENTION_DISABLED=1.
 *
 * Started from boot (boot/startupJobs.js):
 *   require('../jobs/kbQueryLogRetention.mts').start();
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

export const LOCK_NAME = 'beeflow:job:kbQueryLogRetention';
export const BATCH_SIZE = 1000;
/** A pass deletes at most this many batches, so one pass cannot run for ever. */
export const MAX_BATCHES = 200;
const INTERVAL_MS = 60 * 60 * 1000;
const BOOT_DELAY_MS = 120 * 1000;

export interface RetentionDeps {
    pool: unknown;
    withNamedLock: (pool: unknown, name: string, fn: () => Promise<number>) => Promise<{ ran: boolean; value?: number }>;
    deleteExpired: (limit: number) => Promise<number>;
    log: { info: (m: string) => void; warn: (m: string, ...rest: unknown[]) => void };
    env: NodeJS.ProcessEnv;
}

function defaultDeps(): RetentionDeps {
    return {
        pool: nodeRequire('../db.js').pool,
        withNamedLock: nodeRequire('./lib/namedLock.js').withNamedLock,
        deleteExpired: (limit) => nodeRequire('../stores/kb/queryLog/index.mts').deleteExpired(limit),
        log: nodeRequire('../telemetry/log.js'),
        env: process.env,
    };
}

let deps: RetentionDeps | null = null;
let running = false;
const d = (): RetentionDeps => deps ?? (deps = defaultDeps());

/** Test hook: replace dependencies; no argument restores the real ones. */
export function _setDeps(next?: Partial<RetentionDeps> | null): void {
    deps = next ? { ...defaultDeps(), ...next } : null;
    running = false;
}

/**
 * One pass. Resolves to the number of rows deleted, or null when the kill switch is on, another
 * replica holds the lock, or the pass failed (logged, never thrown).
 */
export async function runOnce(): Promise<number | null> {
    if (running) return null;
    const dep = d();
    if (String(dep.env.KB_QUERY_LOG_RETENTION_DISABLED || '') === '1') return null;
    running = true;
    try {
        const out = await dep.withNamedLock(dep.pool, LOCK_NAME, async () => {
            let total = 0;
            for (let i = 0; i < MAX_BATCHES; i++) {
                const n = await dep.deleteExpired(BATCH_SIZE);
                total += n;
                if (n < BATCH_SIZE) break;
            }
            return total;
        });
        if (!out.ran) return null;
        const deleted = Number(out.value) || 0;
        if (deleted) dep.log.info(`[kbQueryLogRetention] deleted ${deleted} expired KB query log row(s)`);
        return deleted;
    } catch (err) {
        dep.log.warn('[kbQueryLogRetention] pass failed:', (err as Error).message);
        return null;
    } finally {
        running = false;
    }
}

const { periodicJob } = nodeRequire('./lib/periodicTimer.js');
const timer = periodicJob({
    bootDelayMs: BOOT_DELAY_MS, intervalMs: INTERVAL_MS, run: () => runOnce(),
    onStart: () => d().log.info(`[kbQueryLogRetention] Started: every ${INTERVAL_MS / 3_600_000} h`),
});

export const start: () => void = timer.start;
export const stop: () => void = timer.stop;
