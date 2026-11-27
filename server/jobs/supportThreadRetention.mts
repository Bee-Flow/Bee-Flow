/**
 * Company-inbox retention: once a day, delete the tickets of Bee Flow's own company inbox that
 * belong to no customer (the website contact form) when their last message is older than
 * SUPPORT_THREAD_RETENTION_DAYS days. Which tickets, and what goes with them:
 * stores/supportStore/retention.mts. Tenant Support-studio mailboxes are never touched.
 *
 * Off by default: SUPPORT_THREAD_RETENTION_DAYS unset or 0 keeps every ticket (a self-hosted
 * instance decides its own term). beeflow.nl sets 365, the term its privacy statement promises.
 *
 * Each pass that deleted something writes ONE row to support_audit_log (action
 * 'retention_purge') with the count and the term, never who the tickets were from.
 *
 * MULTI-POD SAFE: one pass at a time across replicas, under a session advisory lock keyed by
 * name (core/scheduling/namedLock). Batches of BATCH_SIZE, each in its own transaction.
 *
 * Started from boot (boot/startupJobs.js startSupportAndSyncJobs):
 *   require('../jobs/supportThreadRetention.mts').start();
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

export const LOCK_NAME = 'beeflow:job:supportThreadRetention';
export const ENV_NAME = 'SUPPORT_THREAD_RETENTION_DAYS';
export const BATCH_SIZE = 500;
/** A pass deletes at most this many batches, so one pass cannot run for ever; the next day goes on. */
export const MAX_BATCHES = 200;
const INTERVAL_MS = 24 * 60 * 60 * 1000;
const BOOT_DELAY_MS = 5 * 60 * 1000;

export interface RetentionDeps {
    pool: unknown;
    withNamedLock: (pool: unknown, name: string, fn: () => Promise<number>) => Promise<{ ran: boolean; value?: number }>;
    purge: (opts: { olderThanDays: number; limit: number }) => Promise<number>;
    recordAudit: (event: { actorKind: string; action: string; payload: Record<string, unknown> }) => Promise<unknown>;
    retentionDays: () => number;
    log: { info: (m: string) => void; warn: (m: string, ...rest: unknown[]) => void };
}

function defaultDeps(): RetentionDeps {
    return {
        pool: nodeRequire('../db.js').pool,
        withNamedLock: nodeRequire('../core/scheduling/namedLock.js').withNamedLock,
        purge: (opts) => nodeRequire('../stores/supportStore/retention.mts').purgeExpiredCompanyThreads(opts),
        recordAudit: (event) => nodeRequire('../stores/supportStore/audit.js').recordAuditEvent(event),
        retentionDays: () => nodeRequire('../utils/envNumber.mts').envInt(ENV_NAME, 0, { min: 0 }),
        log: nodeRequire('../telemetry/log.js'),
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

async function purgeAll(dep: RetentionDeps, days: number): Promise<number> {
    let total = 0;
    for (let i = 0; i < MAX_BATCHES; i++) {
        const n = await dep.purge({ olderThanDays: days, limit: BATCH_SIZE });
        total += n;
        if (n < BATCH_SIZE) break;
    }
    return total;
}

/**
 * One pass. Resolves to the number of threads deleted, or null when retention is off, another
 * replica holds the lock, or the pass failed (logged, never thrown).
 */
export async function runOnce(): Promise<number | null> {
    if (running) return null;
    const dep = d();
    const days = dep.retentionDays();
    if (!(days > 0)) return null;
    running = true;
    try {
        const out = await dep.withNamedLock(dep.pool, LOCK_NAME, () => purgeAll(dep, days));
        if (!out.ran) return null;
        const deleted = Number(out.value) || 0;
        if (deleted) {
            await dep.recordAudit({ actorKind: 'system', action: 'retention_purge', payload: { threads: deleted, retentionDays: days } });
            dep.log.info(`[supportThreadRetention] deleted ${deleted} company-inbox ticket(s) older than ${days} days`);
        }
        return deleted;
    } catch (err) {
        dep.log.warn('[supportThreadRetention] pass failed:', (err as Error).message);
        return null;
    } finally {
        running = false;
    }
}

const { periodicJob } = nodeRequire('./lib/periodicTimer.js');
const timer = periodicJob({
    bootDelayMs: BOOT_DELAY_MS, intervalMs: INTERVAL_MS, run: () => runOnce(),
    onStart: () => d().log.info('[supportThreadRetention] Started: daily'),
});

export const start: () => void = timer.start;
export const stop: () => void = timer.stop;
