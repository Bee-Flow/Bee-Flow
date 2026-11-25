/**
 * The daily clean-up of "it notices what you repeat" (./habitSignals.mts): what is older than eight weeks goes for
 * everyone, and everything of a person goes once that person is no longer on or their organisation no longer allows it
 * (core/entitlements/coworkPolicy.mts `habitsAllowed`). Without this, rows of someone who stopped chatting, or of an
 * organisation that switched it off, would stay. `start()` is called from boot (boot/startupJobs.js): requiring this
 * module starts nothing. Never throws.
 */

import { createRequire } from 'node:module';
import { KEEP_WEEKS, WEEK_MS, habitsOn } from './habitSignals.mts';

const nodeRequire = createRequire(import.meta.url);
const log = nodeRequire('../../../telemetry/log.js') as { warn: (m: string) => void };

const SWEEP_MS = 24 * 60 * 60 * 1000;

export interface SweepDeps {
    enabled: (userId: string) => Promise<boolean>;
    store: {
        pruneAll: (before: Date) => Promise<void>;
        users: () => Promise<string[]>;
        forget: (userId: string) => Promise<void>;
    };
}

const defaults = (): SweepDeps => ({
    enabled: habitsOn,
    store: (nodeRequire('../../../stores/coworkHabits.mts') as typeof import('../../../stores/coworkHabits.mts')).coworkHabits(),
});

/** One sweep; answers how many people's notes were forgotten. */
export async function sweepHabits(now: Date = new Date(), deps: SweepDeps = defaults()): Promise<number> {
    let forgotten = 0;
    try {
        await deps.store.pruneAll(new Date(now.getTime() - KEEP_WEEKS * WEEK_MS));
        for (const userId of await deps.store.users()) {
            try {
                if (await deps.enabled(userId)) continue;
                await deps.store.forget(userId);
                forgotten += 1;
            } catch (e) {
                log.warn(`[Cowork] the habit notes of one person were not swept: ${(e as Error).message}`);
            }
        }
    } catch (e) {
        log.warn(`[Cowork] the habit sweep did not run: ${(e as Error).message}`);
    }
    return forgotten;
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Sweep once soon after boot, then daily. Answers false when already started. */
export function start(): boolean {
    if (timer) return false;
    setTimeout(() => { void sweepHabits(); }, 60_000).unref?.();
    timer = setInterval(() => { void sweepHabits(); }, SWEEP_MS);
    timer.unref?.();
    return true;
}

/** Stop (shutdown, tests). */
export function stop(): void {
    if (timer) clearInterval(timer);
    timer = null;
}
