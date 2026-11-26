// The model can suggest clock fields. Only the owner-confirmed settings API writes them.
import { z } from 'zod';
import { nextRunAt } from '../core/scheduling/cron.js';

const days = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
const repeat = z.enum(['daily', 'weekdays', 'weekly']);
const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const weekdays = z.array(z.enum(days)).min(1).max(7);
const edits = z.object({ repeatInterval: repeat.optional(), timeOfDay: time.optional(), daysOfWeek: weekdays.optional() }).strict();

export interface ClockFields {
    repeatInterval?: string | null;
    timeOfDay?: string | null;
    daysOfWeek?: unknown;
    timezone?: string | null;
    triggerKind?: string | null;
}

/** A clock proposal is complete only if the user's changes plus the existing clock supply every required field. */
export function proposeClock(item: ClockFields, suggestion: unknown, now = Date.now()) {
    const parsed = edits.safeParse(suggestion);
    if (item.triggerKind && item.triggerKind !== 'schedule') return null;
    if (!parsed.success || !Object.keys(parsed.data).length) return null;
    return mergeClock(item, parsed.data, now);
}

function mergeClock(item: ClockFields, patch: z.infer<typeof edits>, now: number) {
    const cadence = repeat.safeParse(patch.repeatInterval ?? item.repeatInterval);
    const at = time.safeParse(patch.timeOfDay ?? item.timeOfDay);
    if (!cadence.success || !at.success) return null;
    if (patch.daysOfWeek && cadence.data !== 'weekly') return null;
    const selected = weekdays.safeParse(patch.daysOfWeek ?? item.daysOfWeek);
    if (cadence.data === 'weekly' && !selected.success) return null;
    const daysOfWeek = selected.success && cadence.data === 'weekly' ? [...new Set(selected.data)] : null;
    return nextClock(cadence.data, at.data, daysOfWeek, item.timezone || 'Europe/Amsterdam', now);
}

function nextClock(interval: z.infer<typeof repeat>, at: string, daysOfWeek: z.infer<typeof weekdays> | null, zone: string, now: number) {
    const [hour, minute] = at.split(':').map(Number);
    const dayField = daysOfWeek ? daysOfWeek.map(d => days.indexOf(d)).join(',') : interval === 'weekdays' ? '1-5' : '*';
    const next = nextRunAt(`${minute} ${hour} * * ${dayField}`, zone, now);
    return next ? { repeatInterval: interval, daysOfWeek, timeOfDay: at, timezone: zone, nextRunAt: next } : null;
}
