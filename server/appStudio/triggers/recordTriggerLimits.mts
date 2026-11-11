/**
 * The operator's knobs of record triggers (env, read per call; 0 = unlimited). The limits of
 * every trigger (triggerLimits.mts: runs per app, fires per hour, failures, the batch) hold too.
 *
 *   STUDIO_APP_RECORD_TRIGGER_MAX_DEPTH        3        the longest chain of trigger runs that start each other through record changes
 *   STUDIO_APP_RECORD_TRIGGER_WRITER_BURST     30       runs one writer may start in one app per minute
 *   STUDIO_APP_RECORD_TRIGGER_MAX_PENDING      1000     changes of one app that may wait for their run; a change beyond it is dropped
 *   STUDIO_APP_RECORD_TRIGGER_EVENT_TTL_MS     86400000 a change that waited this long for its run is dropped
 *   STUDIO_APP_RECORD_TRIGGER_RETENTION_MS     86400000 how long a delivered or skipped change is kept (its row values included, for a fired one)
 *   STUDIO_APP_RECORD_TRIGGER_ARMED_REFRESH_MS 10000    how long a replica trusts its list of armed record triggers before reading it again
 *                                                       (the replica that published refreshes at once); never under 1000
 */

export const RECORD_TRIGGER_ENV = Object.freeze({
    maxDepth: { env: 'STUDIO_APP_RECORD_TRIGGER_MAX_DEPTH', fallback: 3 },
    writerBurst: { env: 'STUDIO_APP_RECORD_TRIGGER_WRITER_BURST', fallback: 30 },
    maxPending: { env: 'STUDIO_APP_RECORD_TRIGGER_MAX_PENDING', fallback: 1000 },
    eventTtlMs: { env: 'STUDIO_APP_RECORD_TRIGGER_EVENT_TTL_MS', fallback: 86_400_000 },
    retentionMs: { env: 'STUDIO_APP_RECORD_TRIGGER_RETENTION_MS', fallback: 86_400_000 },
    armedRefreshMs: { env: 'STUDIO_APP_RECORD_TRIGGER_ARMED_REFRESH_MS', fallback: 10_000 },
});

export type RecordTriggerLimits = { -readonly [K in keyof typeof RECORD_TRIGGER_ENV]: number };

export function recordTriggerLimits(env: Record<string, string | undefined> = process.env): RecordTriggerLimits {
    const out = {} as RecordTriggerLimits;
    for (const [key, { env: name, fallback }] of Object.entries(RECORD_TRIGGER_ENV)) {
        const raw = env[name];
        const n = raw === undefined || String(raw).trim() === '' ? NaN : Number(raw);
        out[key as keyof RecordTriggerLimits] = Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
    }
    out.armedRefreshMs = Math.max(1000, out.armedRefreshMs);
    return out;
}

/** `name=value` of a knob, for messages. */
export function recordLimitLabel(limits: RecordTriggerLimits, key: keyof RecordTriggerLimits): string {
    return `${RECORD_TRIGGER_ENV[key].env}=${limits[key]}`;
}
