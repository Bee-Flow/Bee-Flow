/**
 * The cron dialect a phone may edit.
 *
 * The builder — the web's, and the flow editor's schedule trigger here — writes
 * any 5-field expression server/automation/cron.js accepts. The automation
 * screen's quick picker offers five shapes and nothing else, because a cron
 * field one tap from a live automation is a way to break it by accident. Anything
 * outside these five round-trips untouched and is shown read-only — see
 * SchedulePicker.tsx.
 */

export type SimpleScheduleKind = 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'monthly';

export interface SimpleSchedule {
    kind: SimpleScheduleKind;
    /** 0–59. The only field `hourly` uses. */
    minute: number;
    /** 0–23. Unused by `hourly`. */
    hour: number;
    /** 0 (Sunday) – 6. `weekly` only. */
    weekday: number;
    /** 1–28. `monthly` only, capped so February always has the day. */
    day: number;
}

export const DEFAULT_SIMPLE_SCHEDULE: SimpleSchedule = {
    kind: 'daily',
    minute: 0,
    hour: 9,
    weekday: 1,
    day: 1,
};

export const WEEKDAY_NAMES = [
    'Sunday',
    'Monday',
    'Tuesday',
    'Wednesday',
    'Thursday',
    'Friday',
    'Saturday',
] as const;

export function cronFromSimple(s: SimpleSchedule): string {
    const m = clamp(s.minute, 0, 59);
    const h = clamp(s.hour, 0, 23);
    switch (s.kind) {
        case 'hourly':
            return `${m} * * * *`;
        case 'daily':
            return `${m} ${h} * * *`;
        case 'weekdays':
            return `${m} ${h} * * 1-5`;
        case 'weekly':
            return `${m} ${h} * * ${clamp(s.weekday, 0, 6)}`;
        case 'monthly':
            return `${m} ${h} ${clamp(s.day, 1, 28)} * *`;
    }
}

/**
 * Recognise one of our own five shapes. Returns null for anything else —
 * including expressions that are perfectly valid but that the picker cannot
 * represent, which is precisely when it must refuse to touch them.
 */
export function simpleFromCron(cron: string | null | undefined): SimpleSchedule | null {
    if (!cron) return null;
    const parts = cron.trim().split(/\s+/);
    if (parts.length !== 5) return null;
    const [min, hour, dom, month, dow] = parts as [string, string, string, string, string];
    if (month !== '*') return null;

    const m = numeric(min);
    if (m === null) return null;

    if (hour === '*' && dom === '*' && dow === '*') {
        return { ...DEFAULT_SIMPLE_SCHEDULE, kind: 'hourly', minute: m };
    }
    const h = numeric(hour);
    if (h === null) return null;
    return dayShape(m, h, dom, dow);
}

/** The day fields of a timed shape: every day, weekdays, one weekday or one date. */
function dayShape(m: number, h: number, dom: string, dow: string): SimpleSchedule | null {
    if (dom === '*' && dow === '*') {
        return { ...DEFAULT_SIMPLE_SCHEDULE, kind: 'daily', minute: m, hour: h };
    }
    if (dom === '*' && dow === '1-5') {
        return { ...DEFAULT_SIMPLE_SCHEDULE, kind: 'weekdays', minute: m, hour: h };
    }
    if (dom === '*') {
        const d = numeric(dow);
        // 7 is Sunday too — cron.js folds it, so the picker must as well.
        if (d === null || d > 7) return null;
        return { ...DEFAULT_SIMPLE_SCHEDULE, kind: 'weekly', minute: m, hour: h, weekday: d === 7 ? 0 : d };
    }
    if (dow === '*') {
        const day = numeric(dom);
        if (day === null || day < 1 || day > 28) return null;
        return { ...DEFAULT_SIMPLE_SCHEDULE, kind: 'monthly', minute: m, hour: h, day };
    }
    return null;
}

/** Human text for any cron. Falls back to the expression itself, verbatim. */
export function describeCron(cron: string | null | undefined, tz?: string | null): string {
    if (!cron) return 'On a schedule that has not been set';
    const simple = simpleFromCron(cron);
    const zone = tz ? ` (${tz})` : '';
    if (!simple) return `On a custom schedule: ${cron}${zone}`;
    const at = `${pad(simple.hour)}:${pad(simple.minute)}`;
    switch (simple.kind) {
        case 'hourly':
            return `Every hour at :${pad(simple.minute)}${zone}`;
        case 'daily':
            return `Every day at ${at}${zone}`;
        case 'weekdays':
            return `Every weekday at ${at}${zone}`;
        case 'weekly':
            return `Every ${WEEKDAY_NAMES[simple.weekday] ?? 'week'} at ${at}${zone}`;
        case 'monthly':
            return `Day ${simple.day} of each month at ${at}${zone}`;
    }
}

export function pad(n: number): string {
    return String(n).padStart(2, '0');
}

function clamp(n: number, lo: number, hi: number): number {
    return Math.min(hi, Math.max(lo, Math.round(n)));
}

function numeric(field: string): number | null {
    if (!/^\d+$/.test(field)) return null;
    return parseInt(field, 10);
}
