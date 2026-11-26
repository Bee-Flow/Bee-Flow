/**
 * Phase B of the automatic meeting imports (Teams, Google Meet): the jobs
 * that are due, run as a pool instead of one after the other.
 *
 * An import is a download, an ffmpeg pass and a transcription that can sit at
 * the engine for hours on a long meeting. A scheduler tick that waits for its
 * jobs skips every tick until they are done: no meeting is discovered and no
 * colleague's short meeting is imported in the meantime. So a tick only tops
 * the pool up and returns; the imports run on.
 *
 * Env: MEETING_IMPORT_AUTO_MAX_CONCURRENT, the imports one queue runs at once
 * in this process (default 3, 0 = unlimited).
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const log = nodeRequire('../../telemetry/log') as Record<'info' | 'warn' | 'error', (...args: unknown[]) => void>;
const { envInt } = nodeRequire('../../utils/envNumber.mts') as typeof import('../../utils/envNumber.mts');

/** How many automatic imports one queue runs at once in this process; 0 = unlimited. */
export function autoImportConcurrency(): number {
    return envInt('MEETING_IMPORT_AUTO_MAX_CONCURRENT', 3, { min: 0 });
}

export interface DueJobPoolOptions<Job> {
    store: { claimDueJobs: (limit: number) => Promise<Job[]> };
    label: string;
    describe: (job: Job) => string;
    processClaimedJob: (job: Job) => Promise<unknown>;
    /** Failure codes that are an expected outcome: logged without alarm. */
    quietCodes: Set<string>;
    /** Read on every fill; 0 means no limit. */
    maxConcurrent: () => number;
}

/**
 * `fill()` claims due jobs (FOR UPDATE SKIP LOCKED, so every pod may run this)
 * until `maxConcurrent()` are running here, and returns without waiting for
 * them. A job's failure is logged and never touches the rest. `idle()`
 * resolves when nothing runs.
 */
export function makeDueJobPool<Job>({ store, label, describe, processClaimedJob, quietCodes, maxConcurrent }: DueJobPoolOptions<Job>) {
    const running = new Set<Promise<void>>();

    async function runClaimed(job: Job): Promise<void> {
        try {
            await processClaimedJob(job);
        } catch (e) {
            const err = e as Error & { code?: string };
            const code = err?.code || 'failed';
            const line = `[${label}] job ${describe(job)}: ${code}: ${err?.message}`;
            if (quietCodes.has(code)) log.info(line); // expected outcome, no alarm
            else log.warn(line);
        }
    }

    /** Start due jobs in the free slots; resolves to how many it started. */
    async function fill(): Promise<number> {
        let started = 0;
        for (;;) {
            const max = maxConcurrent();
            if (max > 0 && running.size >= max) return started;
            // ONE claim per job, right before it runs. A batch claim puts the
            // same 10-minute lease on every job at once; a job that then waits
            // for a free slot loses its lease, another replica claims and
            // ingests it, and this pod ingests it AGAIN from its stale claim.
            let jobs: Job[];
            try {
                jobs = await store.claimDueJobs(1);
            } catch (e) {
                log.error(`[${label}] claim failed:`, (e as Error).message);
                return started;
            }
            const job = jobs[0];
            if (!job) return started;
            const run: Promise<void> = runClaimed(job).finally(() => { running.delete(run); });
            running.add(run);
            started += 1;
        }
    }

    async function idle(): Promise<void> {
        while (running.size > 0) await Promise.all([...running]);
    }

    return { fill, idle, size: () => running.size };
}

/**
 * The `processDue` of one automatic import queue. The scheduler calls it with
 * `wait: false` and gets its tick back at once; without it the call resolves
 * when the imports it started (and any still running) are done.
 * `store` is a getter: the queues swap their store in tests.
 */
export function makeAutoImportQueue<Job>(
    opts: Omit<DueJobPoolOptions<Job>, 'store' | 'maxConcurrent'> & { store: () => DueJobPoolOptions<Job>['store'] },
) {
    const pool = makeDueJobPool<Job>({
        ...opts,
        store: { claimDueJobs: (limit) => opts.store().claimDueJobs(limit) },
        maxConcurrent: autoImportConcurrency,
    });
    async function processDue({ wait = true }: { wait?: boolean } = {}): Promise<void> {
        await pool.fill();
        if (wait) await pool.idle();
    }
    return { processDue, pool };
}

/**
 * Did a person ask for this meeting while this run was going? The manual
 * import routes mark the row (`markRequestedByUser`) when a click finds the
 * poller's run in flight and follows it. That person is watching this run, so
 * its failure is final and keeps its code, like a run they started themselves.
 * A row that was the user's own request before the run began says nothing
 * about anyone watching now.
 * @param job the row as this run claimed it
 */
export async function requestedDuringRun(
    store: { getJob: (id: string) => Promise<{ requestedByUser?: boolean } | null> },
    job: { id: string; requestedByUser?: boolean },
): Promise<boolean> {
    if (job.requestedByUser) return false;
    try {
        return !!(await store.getJob(job.id))?.requestedByUser;
    } catch (e) {
        log.warn('[MeetingImport] could not re-read the job after a failed ingest:', (e as Error).message);
        return false;
    }
}
