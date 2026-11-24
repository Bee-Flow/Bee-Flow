// The one confirmation before a new task exists (./coworkConfirmModel.ts): "Which day?" when the sentence did not
// say when, what each answer schedules, the time, and who it sends to.
import { describe, expect, it } from 'vitest';
import { dayWords, needsDay, sendsToWords, timeOf, withDay, withTime } from './coworkConfirmModel';
import type { CoworkPayload } from '@/api/cowork.types';

const NOW = new Date(2026, 10, 24, 10, 0); // Tuesday 24 November, 10:00 local
const t = (_key: string | undefined, fallback?: unknown, params?: unknown) => {
    let text = String(fallback);
    for (const [k, v] of Object.entries((params ?? {}) as Record<string, unknown>)) text = text.replace(`{${k}}`, String(v));
    return text;
};
const payload = (over: Partial<CoworkPayload> = {}): CoworkPayload => ({
    title: 'Meeting overview', prompt: 'Summarise my meetings', nextRunAt: NOW.toISOString(), repeatInterval: null, modelTier: 'auto', timezone: 'Europe/Amsterdam', startNow: true, ...over,
});

describe('needsDay', () => {
    it('asks when the sentence said nothing about when, or "every week" without the day', () => {
        expect(needsDay({ payload: payload(), spec: { title: 'Meeting overview' } })).toBe(true);
        expect(needsDay({ payload: payload(), spec: null })).toBe(true);
        expect(needsDay({ payload: payload({ repeatInterval: 'weekly' }), spec: { repeatInterval: 'weekly' } })).toBe(true);
    });

    it('does not ask when it said a repeat, a day or a time', () => {
        expect(needsDay({ payload: payload({ repeatInterval: 'daily' }), spec: { repeatInterval: 'daily' } })).toBe(false);
        expect(needsDay({ payload: payload({ repeatInterval: 'weekly', daysOfWeek: ['mon'] }), spec: { daysOfWeek: ['mon'] } })).toBe(false);
        expect(needsDay({ payload: payload({ startNow: undefined }), spec: { timeOfDay: '14:00' } })).toBe(false);
    });
});

describe('withDay and withTime', () => {
    it('every Monday at the chosen time: weekly on that day, its first run the next Monday', () => {
        const next = withDay(payload(), 'mon', '09:00', NOW);
        expect(next).toMatchObject({ repeatInterval: 'weekly', daysOfWeek: ['mon'], timeOfDay: '09:00' });
        expect(next.startNow).toBeUndefined();
        expect(new Date(next.nextRunAt)).toEqual(new Date(2026, 10, 30, 9, 0));
    });

    it('just once today, every day and weekdays', () => {
        const once = withDay(payload(), 'once', '16:30', NOW);
        expect(once).toMatchObject({ repeatInterval: null });
        expect(once.timeOfDay).toBeUndefined();
        expect(new Date(once.nextRunAt)).toEqual(new Date(2026, 10, 24, 16, 30));
        expect(withDay(payload(), 'day', '08:00', NOW)).toMatchObject({ repeatInterval: 'daily', timeOfDay: '08:00' });
        expect(new Date(withDay(payload(), 'weekdays', '08:00', NOW).nextRunAt)).toEqual(new Date(2026, 10, 25, 8, 0));
    });

    it('another time keeps the days', () => {
        const monday = withDay(payload(), 'mon', '09:00', NOW);
        expect(withTime(monday, '07:15', NOW)).toMatchObject({ repeatInterval: 'weekly', daysOfWeek: ['mon'], timeOfDay: '07:15' });
        expect(timeOf(withTime(monday, '07:15', NOW))).toBe('07:15');
        expect(timeOf(payload())).toBe('09:00');
    });
});

describe('dayWords and sendsToWords', () => {
    it('says the day part of When', () => {
        expect(dayWords(payload(), t, NOW)).toBe('Right away');
        expect(dayWords(withDay(payload(), 'once', '16:30', NOW), t, NOW)).toBe('Once, today');
        expect(dayWords(withDay(payload(), 'day', '08:00', NOW), t, NOW)).toBe('Every day');
    });

    it('sends to the addresses in the sentence, else only to its owner', () => {
        expect(sendsToWords({ payload: payload(), spec: null }, t)).toBe('Only you');
        expect(sendsToWords({ payload: payload({ prompt: 'Mail the list to finance@northwind.example and to sam@northwind.example.' }), spec: null }, t))
            .toBe('finance@northwind.example, sam@northwind.example');
    });
});
