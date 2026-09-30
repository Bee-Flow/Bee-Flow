/**
 * The visual schedule builder's cron helpers — a port of the web builder's
 * flow/scheduleBuilderUtils.js, pinned by labels.lockstep.test.ts.
 *
 * Same 5-field grammar as server/automation/cron.js. Only strings the server
 * accepts are generated; anything that is not a preset is held in 'custom'
 * mode and round-trips unchanged.
 */

import type { Translate } from './types';

/** Cron day number → the web's short English name, Monday first. */
const DAY_NAMES: readonly (readonly [number, string])[] = [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [0, 'Sun']];

/** The weekday chips, as the web lists them: `{ id, label }`, Monday first. */
export const WEEKDAYS: readonly { id: number; label: string }[] = Object.freeze(DAY_NAMES.map(([id, label]) => ({ id, label })));

/** A weekday chip's name in the viewer's language (`mobile.flow.weekday.<id>`). */
export function weekdayLabel(id: number, t: Translate | null = null): string {
    const english = WEEKDAYS.find((w) => w.id === id)?.label ?? String(id);
    return t ? t(`mobile.flow.weekday.${id}`, english) : english;
}

/** The curated fallback list, for a runtime without `Intl.supportedValuesOf`. */
const FALLBACK_TIMEZONES = [
    'UTC',
    'Europe/Amsterdam', 'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Madrid',
    'Europe/Rome', 'Europe/Warsaw', 'Europe/Athens', 'Europe/Istanbul',
    'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
    'America/Sao_Paulo',
    'Asia/Tokyo', 'Asia/Shanghai', 'Asia/Singapore', 'Asia/Kolkata', 'Asia/Dubai',
    'Australia/Sydney',
];

/** Every IANA zone the engine knows, or the curated list. */
export function timezoneOptions(): string[] {
    try {
        const supported = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
        if (typeof supported === 'function') {
            const list = supported('timeZone');
            if (Array.isArray(list) && list.length > 20) return list;
        }
    } catch {
        // fall through to the curated list
    }
    return FALLBACK_TIMEZONES.slice();
}

export const SCHEDULE_MODES = ['minute', 'hourly', 'daily', 'weekly', 'monthly', 'custom'] as const;

export type SchedulePreset =
    | { mode: 'minute'; everyN: number }
    | { mode: 'hourly'; minute: number }
    | { mode: 'daily'; hour: number; minute: number }
    | { mode: 'weekly'; hour: number; minute: number; days: number[] }
    | { mode: 'monthly'; hour: number; minute: number; day: number }
    | { mode: 'custom'; cron: string };

const defaultPreset = (): SchedulePreset => ({ mode: 'daily', hour: 9, minute: 0 });
const DIGITS = /^\d+$/;
const int = (v: string) => parseInt(v, 10);

/** `*` / `*\/N` in the minute field with every other field `*`. */
function minutePreset(m: string): SchedulePreset | null {
    if (m === '*') return { mode: 'minute', everyN: 1 };
    const step = m.match(/^\*\/(\d+)$/);
    const n = step ? int(step[1] as string) : 0;
    return n >= 1 && n <= 59 ? { mode: 'minute', everyN: n } : null;
}

type CronFields = [string, string, string, string, string];

/** The presets that need a fixed minute and hour. */
function timedPreset([m, h, dom, mon, dow]: CronFields): SchedulePreset | null {
    if (mon !== '*' || !DIGITS.test(m) || !DIGITS.test(h)) return null;
    const mm = int(m);
    const hh = int(h);
    if (dom === '*' && dow === '*' && mm <= 59 && hh <= 23) return { mode: 'daily', hour: hh, minute: mm };
    if (dom === '*' && /^[0-7](,[0-7])*$/.test(dow)) {
        const days = dow.split(',').map((d) => (int(d) === 7 ? 0 : int(d)));
        return { mode: 'weekly', hour: hh, minute: mm, days };
    }
    if (dow === '*' && DIGITS.test(dom) && int(dom) >= 1 && int(dom) <= 31) {
        return { mode: 'monthly', hour: hh, minute: mm, day: int(dom) };
    }
    return null;
}

/** A cron string as one of the presets, or 'custom' when it is not one. */
export function presetFromCron(cron: unknown): SchedulePreset {
    if (typeof cron !== 'string') return defaultPreset();
    const trimmed = cron.trim();
    if (!trimmed) return defaultPreset();
    const parts = trimmed.split(/\s+/);
    if (parts.length !== 5) return { mode: 'custom', cron: trimmed };
    const fields = parts as CronFields;
    const [m, h, dom, mon, dow] = fields;
    const everyHour = mon === '*' && dom === '*' && dow === '*' && h === '*';
    if (everyHour) {
        const minute = minutePreset(m);
        if (minute) return minute;
        if (DIGITS.test(m) && int(m) <= 59) return { mode: 'hourly', minute: int(m) };
    }
    return timedPreset(fields) || { mode: 'custom', cron: trimmed };
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(n)));
}

type LoosePreset = { mode?: string } & Record<string, unknown>;

function weeklyDays(days: unknown): number[] {
    if (!Array.isArray(days) || !days.length) return [1];
    return Array.from(new Set(days.map((d) => clampInt(d, 0, 6, 1)))).sort((a, b) => a - b);
}

/** A preset back to a 5-field cron string, with safe defaults for a half-filled form. */
export function cronFromPreset(preset: LoosePreset | null | undefined): string {
    if (!preset || typeof preset !== 'object') return '0 9 * * *';
    const m = clampInt(preset.minute, 0, 59, 0);
    const h = clampInt(preset.hour, 0, 23, 9);
    switch (preset.mode) {
        case 'minute': {
            const n = clampInt(preset.everyN, 1, 59, 1);
            return n === 1 ? '* * * * *' : `*/${n} * * * *`;
        }
        case 'hourly':
            return `${m} * * * *`;
        case 'daily':
            return `${m} ${h} * * *`;
        case 'weekly':
            return `${m} ${h} * * ${weeklyDays(preset.days).join(',')}`;
        case 'monthly':
            return `${m} ${h} ${clampInt(preset.day, 1, 31, 1)} * *`;
        case 'custom':
            return typeof preset.cron === 'string' && preset.cron.trim() ? preset.cron.trim() : '0 9 * * *';
        default:
            return '0 9 * * *';
    }
}

const pad2 = (n: number) => (String(n).length < 2 ? `0${n}` : String(n));

/** A short description for instant feedback; the server preview is authoritative. */
export function describeCron(cron: unknown): string {
    const p = presetFromCron(cron);
    switch (p.mode) {
        case 'minute':
            return p.everyN === 1 ? 'Every minute' : `Every ${p.everyN} minutes`;
        case 'hourly':
            return p.minute === 0 ? 'Every hour, on the hour' : `Every hour at :${pad2(p.minute)}`;
        case 'daily':
            return `Every day at ${pad2(p.hour)}:${pad2(p.minute)}`;
        case 'weekly': {
            const labels = p.days.map((d) => WEEKDAYS.find((w) => w.id === d)?.label || d).join(', ');
            return `Weekly on ${labels} at ${pad2(p.hour)}:${pad2(p.minute)}`;
        }
        case 'monthly':
            return `Monthly on day ${p.day} at ${pad2(p.hour)}:${pad2(p.minute)}`;
        default:
            return 'Custom schedule';
    }
}
