import { describe, expect, it } from 'vitest';
import { cardFromTrigger, cronFromWords, toggleDay, triggerFromChoice, withFrequency, wordsFromCron } from './startChoice';
import { describeCron } from '../flow/scheduleBuilderUtils';

describe('cardFromTrigger', () => {
    it('maps the stored trigger kinds onto the six start cards', () => {
        expect(cardFromTrigger(null)).toBe('manual');
        expect(cardFromTrigger({ kind: 'schedule' })).toBe('schedule');
        expect(cardFromTrigger({ kind: 'form' })).toBe('form');
        expect(cardFromTrigger({ kind: 'app_event', appEvent: { provider: 'nextcloud', event: 'file.new' } })).toBe('file');
        expect(cardFromTrigger({ kind: 'app_event', appEvent: { provider: 'gmail', event: 'mail.new' } })).toBe('email');
        expect(cardFromTrigger({ kind: 'app_event', appEvent: { provider: 'nextcloud', event: 'share.received' } })).toBe('app');
    });

    it('has no card for a webhook or agent start', () => {
        expect(cardFromTrigger({ kind: 'webhook' })).toBeNull();
        expect(cardFromTrigger({ kind: 'agent_call' })).toBeNull();
    });
});

describe('triggerFromChoice', () => {
    const base = { id: 't1', type: 'trigger', kind: 'manual', label: 'Manual' };
    const input = { cron: '0 7 * * 1,2,3,4,5', tz: 'Europe/Amsterdam', skipHolidays: true };

    it('writes a schedule with skipHolidays and renames a generated label', () => {
        const next = triggerFromChoice(base, { ...input, card: 'schedule' });
        expect(next).toMatchObject({ id: 't1', kind: 'schedule', label: 'Schedule', appEvent: null, form: null });
        expect(next.schedule).toEqual({ cron: '0 7 * * 1,2,3,4,5', tz: 'Europe/Amsterdam', skipHolidays: true });
    });

    it('keeps a label the user typed', () => {
        expect(triggerFromChoice({ ...base, label: 'Monday run' }, { ...input, card: 'schedule' }).label).toBe('Monday run');
    });

    it('maps "new file" to the Nextcloud file.new app event', () => {
        const next = triggerFromChoice(base, { ...input, card: 'file' });
        expect(next.kind).toBe('app_event');
        expect(next.appEvent).toEqual({ provider: 'nextcloud', event: 'file.new', filter: null });
        expect(next.schedule).toBeNull();
    });

    it('picks the first mail provider the user has for "e-mail received"', () => {
        const next = triggerFromChoice(base, { ...input, card: 'email', providers: [{ id: 'nextcloud', events: ['file.new'] }, { id: 'msgraph', events: ['mail.new'] }] });
        expect(next.appEvent).toMatchObject({ provider: 'msgraph', event: 'mail.new' });
    });

    it('gives a new form start the default declaration, and keeps an existing one', () => {
        const fresh = triggerFromChoice(base, { ...input, card: 'form', defaultForm: () => ({ title: 'F' }) });
        expect(fresh.form).toEqual({ title: 'F' });
        const kept = triggerFromChoice({ ...base, kind: 'form', form: { title: 'Mine' } }, { ...input, card: 'form', defaultForm: () => ({ title: 'F' }) });
        expect(kept.form).toEqual({ title: 'Mine' });
    });
});

describe('schedule in words', () => {
    it('reads a weekday cron and writes it back unchanged', () => {
        const w = wordsFromCron('0 7 * * 1,2,3,4,5');
        expect(w).toMatchObject({ freq: 'weekday', hour: 7, minute: 0 });
        expect(cronFromWords(w)).toBe('0 7 * * 1,2,3,4,5');
    });

    it('keeps a cron it cannot put in words as custom', () => {
        const w = wordsFromCron('*/15 * * * *');
        expect(w.freq).toBe('custom');
        expect(cronFromWords(w)).toBe('*/15 * * * *');
    });

    it('lets the day buttons steer the frequency', () => {
        let w = wordsFromCron('30 8 * * 1,2,3,4,5');
        w = toggleDay(w, 6);
        expect(w.freq).toBe('week');
        expect(w.cron).toBe('30 8 * * 1,2,3,4,5,6');
        w = toggleDay(w, 0);
        expect(w.freq).toBe('day');
        expect(w.cron).toBe('30 8 * * *');
    });

    it('switches to monthly on the chosen day', () => {
        const w = withFrequency({ ...wordsFromCron('0 9 * * *'), dayOfMonth: 15 }, 'month');
        expect(w.cron).toBe('0 9 15 * *');
    });
});

describe('describeCron', () => {
    it('says "every weekday" with the time zone', () => {
        expect(describeCron('0 7 * * 1,2,3,4,5', { tz: 'Europe/Amsterdam' })).toBe('Every weekday at 07:00 · Europe/Amsterdam');
    });

    it('keeps the plain English sentence for existing callers', () => {
        expect(describeCron('30 8 * * 1,3')).toBe('Weekly on Mon, Wed at 08:30');
        expect(describeCron('0 9 * * *')).toBe('Every day at 09:00');
    });

    it('translates through t with the sentence parameters', () => {
        const t = (key: string, fallback: string, params?: Record<string, unknown>) => `${key}|${fallback}|${JSON.stringify(params || {})}`;
        expect(describeCron('0 7 * * *', { t })).toBe('automations.schedule.every_day_at|Every day at {time}|{"time":"07:00"}');
    });
});
