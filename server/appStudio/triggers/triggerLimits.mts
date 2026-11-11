/**
 * The operator's knobs of server triggers (env, read per call; 0 = unlimited unless said otherwise).
 *
 *   STUDIO_APP_TRIGGER_MIN_INTERVAL_SECONDS  60       the shortest time between two fires of one trigger
 *   STUDIO_APP_TRIGGER_RUNS_PER_APP          5        trigger runs of one app going at the same time
 *   STUDIO_APP_TRIGGER_FIRES_PER_HOUR        120      trigger runs one app may start in an hour
 *   STUDIO_APP_TRIGGER_MAX_FAILURES          5        failed runs in a row after which a trigger is paused (0 = never)
 *   STUDIO_APP_TRIGGER_BACKOFF_MS            300000   the wait after a first failed run; doubles per failure in a row (0 = none)
 *   STUDIO_APP_TRIGGER_BACKOFF_MAX_MS        21600000 the longest such wait (0 = no ceiling)
 *   STUDIO_APP_TRIGGER_BATCH                 50       triggers one pass of the job fires
 *
 * A fire that a limit holds back is skipped, not queued: the trigger keeps its next time.
 */

export const TRIGGER_ENV = Object.freeze({
    minIntervalSeconds: { env: 'STUDIO_APP_TRIGGER_MIN_INTERVAL_SECONDS', fallback: 60 },
    runsPerApp: { env: 'STUDIO_APP_TRIGGER_RUNS_PER_APP', fallback: 5 },
    firesPerHour: { env: 'STUDIO_APP_TRIGGER_FIRES_PER_HOUR', fallback: 120 },
    maxFailures: { env: 'STUDIO_APP_TRIGGER_MAX_FAILURES', fallback: 5 },
    backoffMs: { env: 'STUDIO_APP_TRIGGER_BACKOFF_MS', fallback: 300_000 },
    backoffMaxMs: { env: 'STUDIO_APP_TRIGGER_BACKOFF_MAX_MS', fallback: 21_600_000 },
    batch: { env: 'STUDIO_APP_TRIGGER_BATCH', fallback: 50 },
});

export type TriggerLimits = { -readonly [K in keyof typeof TRIGGER_ENV]: number };

function intFromEnv(env: Record<string, string | undefined>, name: string, fallback: number): number {
    const raw = env[name];
    if (raw === undefined || String(raw).trim() === '') return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

export function triggerLimits(env: Record<string, string | undefined> = process.env): TriggerLimits {
    const out = {} as TriggerLimits;
    for (const [key, { env: name, fallback }] of Object.entries(TRIGGER_ENV)) out[key as keyof TriggerLimits] = intFromEnv(env, name, fallback);
    return out;
}

/** `name=value` of a knob, for messages. */
export function triggerLimitLabel(limits: TriggerLimits, key: keyof TriggerLimits): string {
    return `${TRIGGER_ENV[key].env}=${limits[key]}`;
}

/** The wait after `failures` failed runs in a row: the base, doubled per further failure, up to the ceiling. */
export function backoffMs(failures: number, limits: TriggerLimits): number {
    if (failures < 1 || !limits.backoffMs) return 0;
    const wait = limits.backoffMs * 2 ** Math.min(failures - 1, 20);
    return limits.backoffMaxMs ? Math.min(wait, limits.backoffMaxMs) : wait;
}

/** `next` moved to no sooner than the operator's shortest interval after the fire at `firedAt`. */
export function withMinInterval(next: number | null, firedAt: number, limits: TriggerLimits): number | null {
    if (next === null || !limits.minIntervalSeconds) return next;
    return Math.max(next, firedAt + limits.minIntervalSeconds * 1000);
}
