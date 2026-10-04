/**
 * `definition.runPolicy` — how an automation behaves when it runs (Studio →
 * Automations handoff 5, Settings › Advanced):
 *
 *   {
 *     retry:          { max: 0..5, then: 'stop_notify' | 'continue' },
 *     maxDurationMin: 1..60,
 *     concurrency:    'serial' | 'parallel',
 *     retentionDays:  7..365,
 *   }
 *
 * Every key is optional; a missing one means the platform default:
 *
 *   retry.max       the default retry count for a step WITHOUT its own
 *                   `retry` (a step's own setting always wins). Default 0.
 *   retry.then      after the last attempt fails: 'stop_notify' ends the run
 *                   as failed and notifies (today's behaviour); 'continue'
 *                   records the step as a handled error and carries on down
 *                   its normal path. Branching steps (If/Switch/Guard) always
 *                   stop: there is no single "normal path" out of them.
 *   maxDurationMin  the run's time budget, WORK time only — waiting on a
 *                   Wait step, an approval or a form page does not count
 *                   (the runner already extends its deadline for those).
 *   concurrency     'serial' (default): one live run at a time, as before.
 *                   'parallel': a live run that finds the automation busy runs
 *                   alongside instead of waiting or being skipped.
 *   retentionDays   run history for THIS automation is deleted after
 *                   min(platform retention, retentionDays) days
 *                   (jobs/runRetention.js).
 *
 * Two functions: `sanitizeRunPolicy` for the save path (strict — a value out
 * of range is an error the author sees, never silently clamped), and
 * `resolveRunPolicy` for the runner (lenient — whatever is stored, the runner
 * gets a complete, in-range policy).
 *
 * Pure.
 */

'use strict';

const RETRY_MAX = 5;
const RETRY_THEN = Object.freeze(['stop_notify', 'continue']);
const DURATION_MIN = 1;
const DURATION_MAX = 60;
const CONCURRENCY = Object.freeze(['serial', 'parallel']);
const RETENTION_MIN = 7;
const RETENTION_MAX = 365;

const DEFAULT_RUN_POLICY = Object.freeze({
    retry: Object.freeze({ max: 0, then: 'stop_notify' }),
    maxDurationMin: null,
    concurrency: 'serial',
    retentionDays: null,
});

const isInt = (v) => typeof v === 'number' && Number.isInteger(v);
const issue = (path, message) => ({ code: 'run_policy.invalid', severity: 'error', path: `runPolicy.${path}`, message });

/**
 * Validate and clean a runPolicy for storage.
 *
 * Unknown keys are dropped (a client that sends a field the server does not
 * know gets it removed, not stored to be misread later); every known key must
 * be the right type and in range, or it is an error naming the field.
 * `undefined` / `null` → `{ value: undefined }`: no policy, nothing stored.
 *
 * @returns {{ value: object|undefined, errors: Array<object> }}
 */
function sanitizeRunPolicy(raw) {
    if (raw === undefined || raw === null) return { value: undefined, errors: [] };
    if (typeof raw !== 'object' || Array.isArray(raw)) {
        return { value: undefined, errors: [issue('', 'runPolicy is an object: retry, maxDurationMin, concurrency, retentionDays.')] };
    }
    const errors = [];
    const value = {};

    if (raw.retry !== undefined && raw.retry !== null) {
        const r = raw.retry;
        if (typeof r !== 'object' || Array.isArray(r)) {
            errors.push(issue('retry', 'retry is an object: { max, then }.'));
        } else {
            const retry = {};
            if (r.max !== undefined) {
                if (!isInt(r.max) || r.max < 0 || r.max > RETRY_MAX) errors.push(issue('retry.max', `retry.max is a whole number from 0 to ${RETRY_MAX}.`));
                else retry.max = r.max;
            }
            if (r.then !== undefined) {
                if (!RETRY_THEN.includes(r.then)) errors.push(issue('retry.then', `retry.then is one of: ${RETRY_THEN.join(', ')}.`));
                else retry.then = r.then;
            }
            if (Object.keys(retry).length) value.retry = retry;
        }
    }
    if (raw.maxDurationMin !== undefined && raw.maxDurationMin !== null) {
        const m = raw.maxDurationMin;
        if (!isInt(m) || m < DURATION_MIN || m > DURATION_MAX) errors.push(issue('maxDurationMin', `maxDurationMin is a whole number of minutes from ${DURATION_MIN} to ${DURATION_MAX}.`));
        else value.maxDurationMin = m;
    }
    if (raw.concurrency !== undefined && raw.concurrency !== null) {
        if (!CONCURRENCY.includes(raw.concurrency)) errors.push(issue('concurrency', `concurrency is one of: ${CONCURRENCY.join(', ')}.`));
        else value.concurrency = raw.concurrency;
    }
    if (raw.retentionDays !== undefined && raw.retentionDays !== null) {
        const d = raw.retentionDays;
        if (!isInt(d) || d < RETENTION_MIN || d > RETENTION_MAX) errors.push(issue('retentionDays', `retentionDays is a whole number of days from ${RETENTION_MIN} to ${RETENTION_MAX}.`));
        else value.retentionDays = d;
    }
    return { value: errors.length ? undefined : value, errors };
}

/**
 * A definition with its runPolicy sanitised in place of the one it carried.
 * Returns `{ definition, errors }`; the definition is a shallow copy only when
 * something changed.
 */
function withSanitizedRunPolicy(definition) {
    if (!definition || typeof definition !== 'object' || definition.runPolicy === undefined) {
        return { definition, errors: [] };
    }
    const { value, errors } = sanitizeRunPolicy(definition.runPolicy);
    if (errors.length) return { definition, errors };
    const next = { ...definition };
    if (value === undefined) delete next.runPolicy;
    else next.runPolicy = value;
    return { definition: next, errors: [] };
}

/** The complete policy a run follows. Never throws; bad stored values fall back to defaults. */
function resolveRunPolicy(definition) {
    const raw = definition && typeof definition === 'object' ? definition.runPolicy : null;
    const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const r = src.retry && typeof src.retry === 'object' ? src.retry : {};
    const max = isInt(r.max) ? Math.min(Math.max(r.max, 0), RETRY_MAX) : DEFAULT_RUN_POLICY.retry.max;
    const then = RETRY_THEN.includes(r.then) ? r.then : DEFAULT_RUN_POLICY.retry.then;
    const dur = isInt(src.maxDurationMin) ? Math.min(Math.max(src.maxDurationMin, DURATION_MIN), DURATION_MAX) : null;
    const days = isInt(src.retentionDays) ? Math.min(Math.max(src.retentionDays, RETENTION_MIN), RETENTION_MAX) : null;
    return {
        retry: { max, then },
        maxDurationMin: dur,
        concurrency: CONCURRENCY.includes(src.concurrency) ? src.concurrency : DEFAULT_RUN_POLICY.concurrency,
        retentionDays: days,
    };
}

/** The retry a step gets: its own when it has one, else the automation's default (or null). */
function stepRetryFor(step, policy) {
    if (step && step.retry) return step.retry;
    const max = policy?.retry?.max || 0;
    return max > 0 ? { max } : null;
}

/** The run timeout in ms the automation asks for, or null for "use the row / platform default". */
function runTimeoutMsFor(policy) {
    return policy && isInt(policy.maxDurationMin) ? policy.maxDurationMin * 60_000 : null;
}

module.exports = {
    DEFAULT_RUN_POLICY,
    RETRY_MAX, RETRY_THEN, DURATION_MIN, DURATION_MAX, CONCURRENCY, RETENTION_MIN, RETENTION_MAX,
    sanitizeRunPolicy,
    withSanitizedRunPolicy,
    resolveRunPolicy,
    stepRetryFor,
    runTimeoutMsFor,
};
