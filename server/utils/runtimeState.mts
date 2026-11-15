/**
 * runtimeState.mts: what this process knows about its own lifecycle.
 *
 * The listener opens before the store schemas and the migration ladders have
 * run (boot/storeSchemas.js says why a slow schema must not stall boot), and
 * it stays open for a while after SIGTERM. So "the process answers" and "the
 * process can serve" are two different things, and this module holds the
 * second one:
 *
 *   beginBoot()                the listener is up and the boot work starts
 *   trackBootStep(name, work)  one piece of that work; ready waits until it settles
 *   beginShutdown()            SIGTERM / SIGINT arrived; never ready again
 *   readiness()                { ready: true } or { ready: false, reason }
 *
 * Writers: boot/lifecycle.js (beginBoot, beginShutdown), boot/startupTasks.js
 * and boot/startupOneShots.js (the steps). Reader: routes/ready.js. It lives
 * in utils/ because a route may not require boot/ (layering.test.js).
 *
 * A step that fails still settles: ready means "the boot work has finished",
 * not "all of it succeeded". Whoever runs the step logs the failure; the step's
 * name stays in bootFailures(). A step that never settles stops holding ready
 * back after BOOT_READY_TIMEOUT_MS (default 5 minutes), with one error line
 * that names it: a hung migration must not keep a rollout waiting for good.
 */

import { createRequire } from 'node:module';

import { envInt } from './envNumber.mts';

const nodeRequire = createRequire(import.meta.url);
const log = nodeRequire('../telemetry/log') as { error: (msg: string) => void };

export const BOOT_READY_TIMEOUT_ENV = 'BOOT_READY_TIMEOUT_MS';
export const DEFAULT_BOOT_READY_TIMEOUT_MS = 5 * 60_000;

export type NotReadyReason = 'starting' | 'shutting_down';

export interface Readiness {
    ready: boolean;
    /** Why not, when `ready` is false. */
    reason?: NotReadyReason;
}

interface BootStep {
    status: 'pending' | 'done' | 'failed';
}

let bootStartedAt: number | null = null;
let shuttingDown = false;
let overdueLogged = false;
const steps = new Map<string, BootStep>();

function stepsWith(status: BootStep['status']): string[] {
    return [...steps].filter(([, step]) => step.status === status).map(([name]) => name);
}

/** The listener is up and the boot work starts now. The first call counts: it starts the clock of the time limit. */
export function beginBoot(now: number = Date.now()): void {
    if (bootStartedAt === null) bootStartedAt = now;
}

/**
 * One piece of boot work that ready waits for. `work` resolving is "done", rejecting is
 * "failed"; both let ready through. Register it in the same tick as beginBoot(), before
 * the first request can arrive: a step that is added later cannot take back a ready
 * answer already given.
 */
export function trackBootStep(name: string, work: PromiseLike<unknown>): void {
    // Its own object, so that the outcome of an earlier step of the same name cannot overwrite this one.
    const step: BootStep = { status: 'pending' };
    steps.set(name, step);
    Promise.resolve(work).then(
        () => { step.status = 'done'; },
        () => { step.status = 'failed'; },
    );
}

/** The names of the boot steps that ended in a failure. */
export function bootFailures(): string[] {
    return stepsWith('failed');
}

/** SIGTERM / SIGINT arrived: this process takes no new work and readiness() says so until it exits. */
export function beginShutdown(): void {
    shuttingDown = true;
}

/** Can this process take traffic, as far as its own lifecycle goes? The database is the caller's question. */
export function readiness(now: number = Date.now()): Readiness {
    if (shuttingDown) return { ready: false, reason: 'shutting_down' };
    if (bootStartedAt === null) return { ready: false, reason: 'starting' };
    const pending = stepsWith('pending');
    if (pending.length === 0) return { ready: true };
    const limitMs = envInt(BOOT_READY_TIMEOUT_ENV, DEFAULT_BOOT_READY_TIMEOUT_MS, { min: 1000 });
    if (now - bootStartedAt < limitMs) return { ready: false, reason: 'starting' };
    if (!overdueLogged) {
        overdueLogged = true;
        log.error(`[Boot] not finished ${Math.round(limitMs / 1000)} s after start: ${pending.join(', ')}. `
            + `Reporting ready anyway (${BOOT_READY_TIMEOUT_ENV}); look at the log lines of these steps.`);
    }
    return { ready: true };
}

/** Test-only: back to a process that has not started booting. */
export function _resetForTests(): void {
    bootStartedAt = null;
    shuttingDown = false;
    overdueLogged = false;
    steps.clear();
}
