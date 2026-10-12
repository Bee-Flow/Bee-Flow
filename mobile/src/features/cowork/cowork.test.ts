/**
 * Cowork on the phone.
 *
 * Two things are pinned here. The scheduling maths, because the phone, the web
 * and the SERVER all have to agree on what "every week" means — a client that
 * computed the next occurrence differently would create schedules that fire at
 * the wrong time and look like a server bug. And the notification routing,
 * because that is the defect that made Cowork invisible.
 */

import { _reset, setCatalogue } from '@/core/i18n';
import { targetForNotification, translateWebLink } from '@/features/notifications/model/route';

import { proposalFrom } from './model/proposal';
import {
    advanceByRepeat,
    buildCoworkPayload,
    describeMoment,
    describeSchedule,
    nextOccurrence,
    resolveWhen,
    titleFromBrief,
} from './model/schedule';

// A Wednesday, 14:30 local.
const NOW = new Date('2026-09-02T14:30:00');

describe('resolveWhen', () => {
    it('"tonight" after 18:00 means tomorrow evening', () => {
        // The case that fires immediately if you get it wrong.
        const late = new Date('2026-09-02T19:00:00');
        const d = resolveWhen('tonight', { now: late });
        expect(d?.getDate()).toBe(3);
        expect(d?.getHours()).toBe(18);
    });

    it('"next Monday" is never today, even on a Monday', () => {
        const monday = new Date('2026-09-07T09:30:00');
        const d = resolveWhen('next_week', { now: monday });
        expect(d?.getDay()).toBe(1);
        expect(d?.getDate()).toBe(14);
    });

    it('has no custom preset — the phone ships no date picker', () => {
        expect(resolveWhen('custom', { now: NOW })).toBeNull();
    });
});

describe('advanceByRepeat', () => {
    it('skips the weekend for weekdays', () => {
        const friday = new Date('2026-09-04T09:00:00');
        expect(advanceByRepeat(friday, 'weekdays')?.getDay()).toBe(1);
    });

    it('returns null for a non-repeating interval', () => {
        expect(advanceByRepeat(NOW, null)).toBeNull();
        expect(advanceByRepeat(NOW, '')).toBeNull();
    });
});

describe('nextOccurrence', () => {
    it('a daily 08:00 asked for at 14:30 starts tomorrow, not immediately', () => {
        const d = nextOccurrence('08:00', null, { now: NOW });
        expect(d?.getDate()).toBe(3);
    });

    it('honours a weekday restriction', () => {
        const d = nextOccurrence('09:00', ['mon'], { now: NOW });
        expect(d?.getDay()).toBe(1);
    });

    it('refuses a time it cannot anchor to', () => {
        expect(nextOccurrence('nonsense', null, { now: NOW })).toBeNull();
        expect(nextOccurrence(null, null, { now: NOW })).toBeNull();
    });
});

describe('buildCoworkPayload', () => {
    it('always carries nextRunAt, which the server 400s without', () => {
        const body = buildCoworkPayload(
            { title: 'Weekly digest', prompt: 'Summarise the week', presetId: 'tomorrow' },
            { now: NOW, timezone: 'Europe/Amsterdam' },
        );
        expect(body?.nextRunAt).toBeTruthy();
        expect(body?.timezone).toBe('Europe/Amsterdam');
    });

    it('"run now" on a repeat schedules the NEXT one and asks to fire immediately', () => {
        // Otherwise the series runs an interval late for ever.
        const body = buildCoworkPayload(
            { title: 'x', prompt: 'y', presetId: 'now', repeatInterval: 'weekly' },
            { now: NOW },
        );
        expect(body?.startNow).toBe(true);
        expect(new Date(String(body?.nextRunAt)).getDate()).toBe(9);
    });
});

describe('describeMoment — the confirm sheet’s "when", in the app language', () => {
    afterEach(() => _reset());

    it('says today and tomorrow as the web does, and dates the rest', () => {
        expect(describeMoment(new Date('2026-09-02T09:15:00'), { now: NOW })).toMatch(/^Today at 09:15/);
        expect(describeMoment(new Date('2026-09-03T09:00:00'), { now: NOW })).toMatch(/^Tomorrow at 09:00/);
        expect(describeMoment(new Date('2026-09-12T09:00:00'), { now: NOW })).toMatch(/^Sep 12 at 09:00/);
        expect(describeMoment(null, { now: NOW })).toBe('—');
    });

    it('is one translated sentence, so a Dutch schedule does not read "Tomorrow at 09:00"', () => {
        setCatalogue('nl', { 'mobile.time.tomorrow_at': 'Morgen om {time}' });
        expect(describeMoment(new Date('2026-09-03T09:00:00'), { now: NOW })).toBe('Morgen om 09:00');
        expect(
            describeSchedule({ presetId: 'tomorrow_9', runAt: new Date('2026-09-03T09:00:00'), repeatInterval: null }, { now: NOW }),
        ).toBe('Morgen om 09:00');
    });
});

describe('titleFromBrief', () => {
    it('uses the first line, stripped of list noise', () => {
        expect(titleFromBrief('- Send the weekly digest\nand cc me')).toBe('Send the weekly digest');
    });

    it('never returns an empty name', () => {
        expect(titleFromBrief('   ')).toBe('Untitled cowork');
    });
});

describe('routing a Cowork notification', () => {
    it('opens the cowork item, not the tasks list', () => {
        // THE BUG. /tasks reads /api/ai-tasks and /api/reminders — a different
        // store — so this notification opened a screen that could not contain
        // the thing it was about.
        expect(translateWebLink('/app/cowork/abc123')?.href).toBe('/cowork/abc123');
    });

    it('falls back to the Cowork hub when the link names no item', () => {
        expect(translateWebLink('/app/cowork')?.href).toBe('/cowork');
    });

    it('sends an older ai_task to its Cowork item: the task moved there under the same id', () => {
        expect(
            targetForNotification({ category: 'ai_task', task_id: 't1' } as never).href,
        ).toBe('/cowork/t1');
    });

    it('sends a cowork result to its own item when there is no link', () => {
        expect(
            targetForNotification({ category: 'cowork', task_id: 'c1' } as never).href,
        ).toBe('/cowork/c1');
    });
});

describe('proposalFrom — the brief-to-schedule derivation', () => {

    it('turns a composed morning schedule into the next occurrence, not now', () => {
        const p = proposalFrom('stuur elke maandag een samenvatting', {
            title: 'Weekly summary',
            prompt: 'Summarise the week and send it',
            repeatInterval: 'weekly',
            daysOfWeek: ['mon'],
            timeOfDay: '09:00',
        });
        expect(p.payload).not.toBeNull();
        expect(new Date(String(p.payload?.nextRunAt)).getDay()).toBe(1);
        expect(p.payload?.repeatInterval).toBe('weekly');
        // The confirm sheet's sentence names a moment, never just "Now".
        expect(p.scheduleSentence).not.toBe('Now');
    });

    it('falls back to the user\'s own words when the composer failed', () => {
        // The web's rule: a composer failure must never cost the user their
        // work. Their brief becomes the prompt, its first line the title, and
        // the schedule is "run now".
        const p = proposalFrom('Check the invoices folder and flag anything odd', null);
        expect(p.title).toBe('Check the invoices folder and flag anything odd');
        expect(p.prompt).toBe('Check the invoices folder and flag anything odd');
        expect(p.payload?.startNow).toBe(true);
        expect(p.scheduleSentence).toBe('Now');
    });

    it('always yields a payload the server will accept', () => {
        // POST /api/cowork 400s without title, prompt or nextRunAt.
        const p = proposalFrom('do the thing', { repeatInterval: 'daily' });
        expect(p.payload?.title).toBeTruthy();
        expect(p.payload?.prompt).toBeTruthy();
        expect(p.payload?.nextRunAt).toBeTruthy();
    });
});
