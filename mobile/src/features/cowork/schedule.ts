/**
 * Cowork scheduling maths — ported from the web's
 * `agent-hub/src/components/cowork/coworkSchedule.js`.
 *
 * Ported rather than reinvented because both clients and the SERVER have to
 * agree on what "every week" means: `advanceByRepeat` mirrors
 * aiTaskStore.advanceNextRun, and a phone that computed the next occurrence
 * differently would create schedules that fire at the wrong time and blame the
 * server. The function bodies below are the web's, unchanged.
 *
 * One deliberate omission: the web's `custom` preset ("Pick a moment…"), which
 * needs date and time inputs. The phone does not ship a date picker for this —
 * the presets plus a composed time cover the cases, and editing the exact
 * moment is the detail screen's job. Adding a native picker dependency to
 * create a schedule you can already create four other ways is not a trade
 * worth making.
 */

export interface WhenPreset {
    id: string;
    label: string;
    hint: string | null;
}

/** The web's list minus `custom` — see the note above. */
export const WHEN_PRESETS: WhenPreset[] = [
    { id: 'now', label: 'Run now', hint: 'Starts the moment you send it' },
    { id: 'in_1h', label: 'In an hour', hint: null },
    { id: 'tonight', label: 'Tonight', hint: '18:00' },
    { id: 'tomorrow', label: 'Tomorrow morning', hint: '09:00' },
    { id: 'next_week', label: 'Next Monday', hint: '09:00' },
];

/**
 * The full server VALID_REPEAT_INTERVALS set, in order. It has to be complete:
 * the API, the `set_cowork` tool and the AI composer can all produce `hourly`
 * or `yearly`, and a value missing from this list has no matching option, so a
 * picker silently rewrites the schedule to "Once" the moment anything is saved.
 */
export const COWORK_REPEAT_OPTIONS: { value: string; label: string }[] = [
    { value: '', label: 'Once' },
    { value: 'hourly', label: 'Every hour' },
    { value: 'daily', label: 'Every day' },
    { value: 'weekdays', label: 'Every weekday' },
    { value: 'weekly', label: 'Every week' },
    { value: 'biweekly', label: 'Every 2 weeks' },
    { value: 'monthly', label: 'Every month' },
    { value: 'quarterly', label: 'Every quarter' },
    { value: 'yearly', label: 'Every year' },
];

export function repeatLabel(value: string | null | undefined): string {
    const opt = COWORK_REPEAT_OPTIONS.find((o) => o.value === (value || ''));
    return opt ? opt.label : String(value);
}

function atLocalTime(base: Date, hour: number, minute: number): Date {
    const d = new Date(base);
    d.setHours(hour, minute, 0, 0);
    return d;
}

/**
 * Resolve a preset (+ optional custom date/time) to a concrete Date.
 * Returns null when 'custom' is picked but the inputs aren't filled in yet.
 */
export function resolveWhen(
    presetId: string,
    { now = new Date() }: { now?: Date } = {},
): Date | null {
    switch (presetId) {
        case 'now':
            return new Date(now);
        case 'in_1h':
            return new Date(now.getTime() + 60 * 60 * 1000);
        case 'tonight': {
            const tonight = atLocalTime(now, 18, 0);
            // Already past 18:00 → the user means tomorrow evening.
            if (tonight <= now) tonight.setDate(tonight.getDate() + 1);
            return tonight;
        }
        case 'tomorrow': {
            const d = atLocalTime(now, 9, 0);
            d.setDate(d.getDate() + 1);
            return d;
        }
        case 'next_week': {
            const d = atLocalTime(now, 9, 0);
            // 1 = Monday. Always lands on the *coming* Monday, never today.
            const delta = ((1 - d.getDay()) + 7) % 7 || 7;
            d.setDate(d.getDate() + delta);
            return d;
        }
        default:
            return null;
    }
}

/**
 * Next occurrence after `from` for a repeat interval. Mirrors the server's
 * aiTaskStore.advanceNextRun. Returns null for a non-repeating interval.
 */
export function advanceByRepeat(from: Date | string, interval: string | null): Date | null {
    const d = new Date(from);
    if (Number.isNaN(d.getTime())) return null;
    switch (interval) {
        case 'hourly': d.setHours(d.getHours() + 1); break;
        case 'daily': d.setDate(d.getDate() + 1); break;
        case 'weekdays':
            do { d.setDate(d.getDate() + 1); }
            while (d.getDay() === 0 || d.getDay() === 6);
            break;
        case 'weekly': d.setDate(d.getDate() + 7); break;
        case 'biweekly': d.setDate(d.getDate() + 14); break;
        case 'monthly': d.setMonth(d.getMonth() + 1); break;
        case 'quarterly': d.setMonth(d.getMonth() + 3); break;
        case 'yearly': d.setFullYear(d.getFullYear() + 1); break;
        default: return null;
    }
    return d;
}

const DOW_TOKENS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

/**
 * First moment matching an AI-composed schedule: a wall-clock time, optionally
 * restricted to certain weekdays.
 *
 * "Every morning" has to become an actual instant before it can be stored, and
 * the obvious reading is the next one that hasn't happened yet — asking for a
 * daily 08:00 job at 09:00 should start tomorrow, not fire immediately and
 * again in the morning. Computed in browser-local time, like the rest of this
 * module: that is the timezone the user is picking in.
 *
 * Returns null when there is no time to anchor to — the caller then falls back
 * to the normal "now" path.
 */
export function nextOccurrence(
    timeOfDay: string | null | undefined,
    daysOfWeek: string[] | null = null,
    { now = new Date() }: { now?: Date } = {},
): Date | null {
    if (typeof timeOfDay !== 'string' || !/^([01]\d|2[0-3]):([0-5]\d)$/.test(timeOfDay)) return null;
    const [hh = 0, mm = 0] = timeOfDay.split(':').map(Number);

    const allowed = Array.isArray(daysOfWeek) && daysOfWeek.length > 0
        ? new Set(daysOfWeek.map(d => String(d).toLowerCase().slice(0, 3)))
        : null;

    const candidate = new Date(now);
    candidate.setHours(hh, mm, 0, 0);
    // Look at today first, then the next seven days — enough to find any
    // weekday in the set, and to roll past a time that has already gone.
    for (let i = 0; i <= 7; i += 1) {
        const d = new Date(candidate);
        d.setDate(d.getDate() + i);
        if (d <= now) continue;
        if (allowed && !allowed.has(DOW_TOKENS[d.getDay()] as string)) continue;
        return d;
    }
    return null;
}


/** "Today at 14:30" / "Tomorrow at 09:00" / "12 Sep at 09:00". */
export function describeMoment(
    value: Date | string | null | undefined,
    { now = new Date() }: { now?: Date } = {},
): string {
    if (!value) return '—';
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) return '—';
    const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    if (d.toDateString() === now.toDateString()) return `Today at ${time}`;
    if (d.toDateString() === tomorrow.toDateString()) return `Tomorrow at ${time}`;
    return `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} at ${time}`;
}

/**
 * The one-line summary on the confirm sheet: "Now", "Now, then every week",
 * "Tomorrow at 09:00, every day". This sentence is the whole safety mechanism —
 * it is what the person reads before agreeing that something will run without
 * them, so it must describe the schedule that is about to be created rather
 * than the one they picked from.
 */
export function describeSchedule(
    {
        presetId,
        runAt,
        repeatInterval,
    }: { presetId: string; runAt: Date | string | null; repeatInterval: string | null },
    { now = new Date() }: { now?: Date } = {},
): string {
    const repeat = repeatInterval ? `, ${repeatLabel(repeatInterval).toLowerCase()}` : '';
    if (presetId === 'now') {
        return `Now${repeatInterval ? `, then ${repeatLabel(repeatInterval).toLowerCase()}` : ''}`;
    }
    if (!runAt) return 'Pick a moment';
    return `${describeMoment(runAt, { now })}${repeat}`;
}

export interface CoworkPayload {
    title: string;
    prompt: string;
    nextRunAt: string;
    repeatInterval: string | null;
    modelTier: string;
    timezone: string;
    daysOfWeek?: string[];
    timeOfDay?: string;
    agentId?: string;
    startNow?: true;
}

/**
 * Turn the composer state into the POST /api/cowork body.
 * Returns null when the schedule is not resolvable.
 *
 * "Run now" on a repeating item schedules the NEXT occurrence and asks the
 * server to fire the first run immediately (`startNow`), so the person gets a
 * result straight away without the series drifting an interval late.
 */
export function buildCoworkPayload(
    {
        title,
        prompt,
        presetId,
        repeatInterval,
        modelTier,
        agentId,
        daysOfWeek = null,
        timeOfDay = null,
        runAt = null,
    }: {
        title: string;
        prompt: string;
        presetId: string;
        repeatInterval?: string | null;
        modelTier?: string | null;
        agentId?: string | null;
        daysOfWeek?: string[] | null;
        timeOfDay?: string | null;
        /**
         * A concrete first-run moment that bypasses the presets — how a
         * composed "every morning at 08:00" becomes the next 08:00 that has
         * not happened yet (via nextOccurrence). The web reaches the same
         * point through its custom date/time inputs; the phone has no date
         * picker, so the composed moment arrives here directly.
         */
        runAt?: Date | null;
    },
    { now = new Date(), timezone }: { now?: Date; timezone?: string } = {},
): CoworkPayload | null {
    const resolved = runAt ?? resolveWhen(presetId, { now });
    if (!resolved) return null;
    const startNow = presetId === 'now';
    const nextRun = startNow && repeatInterval ? advanceByRepeat(resolved, repeatInterval) : resolved;
    if (!nextRun) return null;
    const days = Array.isArray(daysOfWeek) && daysOfWeek.length > 0 ? daysOfWeek : null;
    return {
        title: String(title || '').trim(),
        prompt: String(prompt || '').trim(),
        nextRunAt: nextRun.toISOString(),
        repeatInterval: repeatInterval || null,
        modelTier: modelTier || 'auto',
        timezone:
            timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        ...(days ? { daysOfWeek: days } : {}),
        ...(timeOfDay ? { timeOfDay } : {}),
        ...(agentId ? { agentId } : {}),
        ...(startNow ? { startNow: true as const } : {}),
    };
}

/**
 * Derive a title from the brief the person typed. Cowork deliberately has no
 * separate "name" field — making one required is the main reason the old
 * prompt-task editor felt like paperwork. The first line IS the name.
 */
export function titleFromBrief(text: string, { maxLength = 60 }: { maxLength?: number } = {}): string {
    const firstLine =
        String(text || '')
            .trim()
            .split('\n')
            .map((l) => l.trim())
            .find(Boolean) || '';
    // Strip leading markdown/list noise so "- Send the weekly digest" reads well.
    const cleaned = firstLine.replace(/^[-*#>\s]+/, '').trim();
    if (!cleaned) return 'Untitled cowork';
    if (cleaned.length <= maxLength) return cleaned;
    const cut = cleaned.slice(0, maxLength);
    const lastSpace = cut.lastIndexOf(' ');
    return `${(lastSpace > 20 ? cut.slice(0, lastSpace) : cut).trim()}…`;
}
