/**
 * The `schedule` trigger: run an action at set times.
 *
 *   { id, kind: 'schedule', actionId, schedule: { cron, tz } }         five-field cron in a time zone
 *   { id, kind: 'schedule', actionId, schedule: { everyMinutes } }     every N minutes from the publish
 *
 * `cron` is the five-field form the automation scheduler reads (core/scheduling/cron.js): minute,
 * hour, day of month, month, day of week, each `*`, a number, a range, a list or a step. `tz` is an
 * IANA time zone and is required with a cron: "08:00" means nothing without one. A cron that names
 * no moment in the coming year (31 February) is refused.
 *
 * The text is read character by character and then by the cron parser; nothing here matches a
 * pattern against it.
 *
 * The operator's shortest interval (STUDIO_APP_TRIGGER_MIN_INTERVAL_SECONDS, triggerLimits.mts) is
 * not part of the definition's validity: a schedule that asks for more is valid everywhere and
 * simply fires no more often than the install allows (triggerFire.mts).
 */

import { createRequire } from 'node:module';
import type { Finding, KindValidateCtx, Obj, Push, TriggerKind } from '../triggerKinds.mts';

const nodeRequire = createRequire(import.meta.url);
type Cron = { parseCron: (cron: string) => Record<string, Set<number>>; nextRunAt: (cron: string, tz: string, fromTs: number) => string | null };
const cron = (): Cron => nodeRequire('../../../core/scheduling/cron') as Cron;

export const MAX_CRON_LEN = 100;
export const MAX_TZ_LEN = 64;
/** One year in minutes: the longest interval. */
export const MAX_EVERY_MINUTES = 525_600;

const CRON_CHARS = '0123456789*,-/ ';
const isObject = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

export type Schedule = { cron: string; tz: string } | { everyMinutes: number };

/** True for a time zone this runtime knows. */
export function isTimeZone(tz: unknown): tz is string {
    if (typeof tz !== 'string' || !tz || tz.length > MAX_TZ_LEN) return false;
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
        return true;
    } catch {
        return false;
    }
}

/** Why `text` is not a usable cron, or null. Single spaces between exactly five fields. */
export function cronProblem(text: unknown): string | null {
    if (typeof text !== 'string' || !text) return 'cron must be text like "0 8 * * 1-5"';
    if (text.length > MAX_CRON_LEN) return `cron is at most ${MAX_CRON_LEN} characters`;
    for (const ch of text) if (!CRON_CHARS.includes(ch)) return 'cron holds only digits, *, commas, dashes, slashes and spaces';
    const fields = text.split(' ');
    if (fields.length !== 5 || fields.some((f) => !f)) return 'cron has five fields separated by one space: minute hour day-of-month month day-of-week';
    let parsed: Record<string, Set<number>>;
    try {
        parsed = cron().parseCron(text);
    } catch (e) {
        return (e as Error).message || 'cron could not be read';
    }
    for (const [name, values] of Object.entries(parsed)) if (!values.size) return `the ${name} field of the cron names no valid value`;
    return null;
}

/** The schedule in canonical form, or the reason it is not one. */
export function readSchedule(raw: unknown): { ok: true; schedule: Schedule } | { ok: false; problem: string } {
    if (!isObject(raw)) return { ok: false, problem: 'schedule is { cron, tz } or { everyMinutes }' };
    const hasCron = raw.cron !== undefined && raw.cron !== null;
    const hasEvery = raw.everyMinutes !== undefined && raw.everyMinutes !== null;
    if (hasCron === hasEvery) return { ok: false, problem: 'schedule has either cron (with tz) or everyMinutes, not both and not neither' };
    if (hasEvery) {
        const n = raw.everyMinutes;
        if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > MAX_EVERY_MINUTES) return { ok: false, problem: `everyMinutes is a whole number from 1 to ${MAX_EVERY_MINUTES}` };
        return { ok: true, schedule: { everyMinutes: n } };
    }
    const text = typeof raw.cron === 'string' ? raw.cron.trim().split(' ').filter(Boolean).join(' ') : raw.cron;
    const problem = cronProblem(text);
    if (problem) return { ok: false, problem };
    if (!isTimeZone(raw.tz)) return { ok: false, problem: 'a cron needs tz, an IANA time zone such as "Europe/Amsterdam"' };
    if (cron().nextRunAt(text as string, raw.tz, Date.UTC(2024, 0, 1)) === null) return { ok: false, problem: 'this cron names no moment in a whole year' };
    return { ok: true, schedule: { cron: text as string, tz: raw.tz } };
}

function canon(raw: Obj, at: string, push: Push): Obj | null {
    const read = readSchedule(raw.schedule);
    if (!read.ok) {
        push('triggers.schedule_invalid', `${at}.schedule`, `${read.problem} — the trigger was removed.`);
        return null;
    }
    return { schedule: read.schedule };
}

function validate(trigger: Obj, at: string, ctx: KindValidateCtx): void {
    const read = readSchedule(trigger.schedule);
    if (read.ok) return;
    const finding: Finding = {
        code: 'triggers.schedule_invalid', severity: 'error', path: `${at}.schedule`, message: `Trigger schedule: ${read.problem}.`,
        hint: 'Use { cron: "0 8 * * 1-5", tz: "Europe/Amsterdam" } (minute hour day-of-month month day-of-week) or { everyMinutes: 60 }.',
    };
    ctx.pushE(finding);
}

/** The next moment after `afterMs`, in epoch ms; null when the stored schedule cannot be read. */
function nextFireAt(config: Obj, afterMs: number): number | null {
    const read = readSchedule(config.schedule);
    if (!read.ok) return null;
    if ('everyMinutes' in read.schedule) return afterMs + read.schedule.everyMinutes * 60_000;
    const iso = cron().nextRunAt(read.schedule.cron, read.schedule.tz, afterMs);
    return iso ? Date.parse(iso) : null;
}

const schedule: TriggerKind = {
    kind: 'schedule',
    since: 3,
    fields: ['schedule'],
    canon,
    validate,
    config: (trigger) => ({ schedule: trigger.schedule }),
    nextFireAt,
    refusedKinds: [],
    shape: '{ id, kind: "schedule", actionId, schedule: { cron, tz } | { everyMinutes }, enabled? }',
    description: 'schedule runs the action at set times: schedule.cron is five fields (minute hour day-of-month month day-of-week, '
        + 'for example "0 8 * * 1-5" for weekdays at 08:00) read in schedule.tz, an IANA time zone that is required with a cron; '
        + `or schedule.everyMinutes (1 to ${MAX_EVERY_MINUTES}) for a fixed interval counted from the publish.`,
};

export default schedule;
