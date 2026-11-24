// The one confirmation before a new task exists (./coworkConfirmModel.ts): "Which day?" when the sentence did not
// say when, what each answer schedules, the time, who it sends to, and how the owner's own choices outlive a new
// reading of the sentence and end up in what Start sends.
import { describe, expect, it } from 'vitest';
import { dayChoiceOf,
    appsNamedIn, confirmView, dayWords, isAddress, needsDay, recipientsIn, schedulePartOf, startPayload, timeOf, withDay, withRecipient, withTime, withoutRecipient,
} from './coworkConfirmModel';
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

describe('dayWords', () => {
    it('says the day part of When', () => {
        expect(dayWords(payload(), t, NOW)).toBe('Right away');
        expect(dayWords(withDay(payload(), 'once', '16:30', NOW), t, NOW)).toBe('Once, today');
        expect(dayWords(withDay(payload(), 'day', '08:00', NOW), t, NOW)).toBe('Every day');
    });
});

describe('who it sends to', () => {
    it('"me and sam@…" is both: the owner stays, with every address in the sentence, once each', () => {
        expect(recipientsIn('Send it to me and sam@example.com.')).toEqual({ me: true, others: ['sam@example.com'] });
        expect(recipientsIn('Mail the list to finance@northwind.example, and to Sam@northwind.example; cc (finance@northwind.example)'))
            .toEqual({ me: true, others: ['finance@northwind.example', 'Sam@northwind.example'] });
        expect(recipientsIn('Summarise my meetings')).toEqual({ me: true, others: [] });
    });

    it('knows an address by plain string checks', () => {
        for (const ok of ['sam@example.com', ' sam.de.vries@mail.example.nl ']) expect(isAddress(ok), ok).toBe(true);
        for (const bad of ['', 'sam', 'sam@', '@example.com', 'sam@example', 'sam@@example.com', 'sam @example.com', 'sam@example..com', 'sam@example.com.']) expect(isAddress(bad), bad).toBe(false);
    });

    it('adds an address once and takes one off; something that is no address changes nothing', () => {
        const to = recipientsIn('send it to me and sam@example.com');
        expect(withRecipient(to, ' jo@example.com ').others).toEqual(['sam@example.com', 'jo@example.com']);
        expect(withRecipient(to, 'SAM@example.com')).toBe(to);
        expect(withRecipient(to, 'jo')).toBe(to);
        expect(withoutRecipient(to, 'sam@example.com')).toEqual({ me: true, others: [] });
    });
});

describe('confirmView and startPayload', () => {
    const apps = [{ id: 'fireflies', label: 'Fireflies.ai' }, { id: 'gmail', label: 'Gmail' }];
    const weekly = payload({ title: 'Weekly meeting summary', prompt: 'Summarise last week’s meetings and mail the summary.', repeatInterval: 'weekly', daysOfWeek: ['mon'], timeOfDay: '09:00', startNow: undefined });
    const sentence = 'Every Monday at 09:00, summarise last week’s Fireflies meetings and send it to me and sam@example.com';

    it('shows what the sentence says: its name, only the apps it names, me and the address, and "show me first" on', () => {
        const view = confirmView({ payload: weekly, spec: null }, {}, sentence, apps);
        expect(view).toMatchObject({ title: 'Weekly meeting summary', apps: ['fireflies'], recipients: { me: true, others: ['sam@example.com'] }, sendsToOthers: true, showFirst: true });
        expect(startPayload(view, true)).toMatchObject({
            title: 'Weekly meeting summary', enabledApps: ['fireflies'], repeatInterval: 'weekly', daysOfWeek: ['mon'],
            setup: { steps: true, sendsTo: ['me', 'sam@example.com'], askFirst: true },
        });
    });

    it('a sentence that names no app and nobody else: Cowork picks the apps, and there is nothing to show first', () => {
        const view = confirmView({ payload: payload(), spec: null }, {}, 'Summarise my meetings', apps);
        expect(view).toMatchObject({ apps: null, sendsToOthers: false, showFirst: false });
        const sent = startPayload(view, false) as CoworkPayload;
        expect(sent.enabledApps).toBeUndefined();
        expect(sent.setup).toEqual({ steps: false, sendsTo: ['me'] });
    });

    it('without fixed steps nothing can be shown first, so the start does not ask for it', () => {
        const view = confirmView({ payload: payload(), spec: null }, {}, 'Summarise my meetings and send it to sam@example.com', apps);
        expect(view).toMatchObject({ sendsToOthers: true, showFirst: true });
        expect((startPayload(view, true) as CoworkPayload).setup).toMatchObject({ steps: true, askFirst: true });
        expect((startPayload(view, false) as CoworkPayload).setup).toEqual({ steps: false, sendsTo: expect.arrayContaining(['sam@example.com']) });
    });

    it('what the owner changed by hand wins, and survives a new reading of the sentence', () => {
        const mine = { title: 'Monday digest', apps: [] as string[], recipients: { me: false, others: ['jo@example.com'] }, showFirst: false, schedule: schedulePartOf(withDay(weekly, 'fri', '16:00', NOW)) };
        const reread = { payload: { ...weekly, title: 'Meeting summary for Sam', prompt: 'Summarise the Gmail threads for sam@example.com' }, spec: null };
        const view = confirmView(reread, mine, `${sentence} and from Gmail`, apps);
        expect(view).toMatchObject({ title: 'Monday digest', apps: [], recipients: { me: false, others: ['jo@example.com'] }, showFirst: false });
        expect(startPayload(view, true)).toMatchObject({
            title: 'Monday digest', prompt: 'Summarise the Gmail threads for sam@example.com', enabledApps: [], daysOfWeek: ['fri'], timeOfDay: '16:00',
            setup: { steps: true, sendsTo: ['jo@example.com'], askFirst: false },
        });
        // A row they did not touch follows the new reading.
        expect(confirmView(reread, { title: 'Monday digest' }, `${sentence} and from Gmail`, apps)).toMatchObject({ title: 'Monday digest', apps: ['fireflies', 'gmail'], recipients: { me: true, others: ['sam@example.com'] } });
    });

    it('an emptied name falls back to the one Cowork gave it', () => {
        const view = confirmView({ payload: weekly, spec: null }, { title: '  ' }, sentence, apps);
        expect(startPayload(view, true).title).toBe('Weekly meeting summary');
    });
});

describe('appsNamedIn', () => {
    const apps = [
        { id: 'fireflies', label: 'Fireflies.ai' },
        { id: 'google_calendar', label: 'Google Calendar' },
        { id: 'gmail', label: 'Gmail' },
    ];
    it('names only the apps the sentence names, never the rest of the workspace', () => {
        const named = appsNamedIn('Every Monday, summarise last week’s Fireflies meetings and send them to me', apps);
        expect(named.map((a) => a.id)).toEqual(['fireflies']);
    });
    it('names nothing when the sentence names no app', () => {
        expect(appsNamedIn('per meeting de belangrijkste punten samenvatten', apps)).toEqual([]);
    });
    it('matches a name of more than one word, in any case', () => {
        expect(appsNamedIn('put it in my GOOGLE CALENDAR', apps).map((a) => a.id)).toEqual(['google_calendar']);
    });
});

describe('dayChoiceOf', () => {
    const base = { title: 'T', prompt: 'P', nextRunAt: '2026-11-30T08:00:00.000Z' } as Parameters<typeof dayChoiceOf>[0];
    it('names the choice a schedule stands for, so Change starts the day picker at what the card understood', () => {
        expect(dayChoiceOf({ ...base, repeatInterval: 'weekly', daysOfWeek: ['mon'] })).toBe('mon');
        expect(dayChoiceOf({ ...base, repeatInterval: 'weekdays', daysOfWeek: ['mon', 'tue', 'wed', 'thu', 'fri'] })).toBe('weekdays');
        expect(dayChoiceOf({ ...base, repeatInterval: 'daily' })).toBe('day');
        expect(dayChoiceOf({ ...base, repeatInterval: null })).toBe('once');
        expect(dayChoiceOf({ ...base, repeatInterval: 'weekly', daysOfWeek: ['mon', 'thu'] })).toBe('');
        expect(dayChoiceOf({ ...base, repeatInterval: 'monthly' })).toBe('');
    });
});
