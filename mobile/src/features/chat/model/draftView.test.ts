/** The typed view of a draft record the cards draw. */

import type { TranslateFn } from '@/core/i18n';

import { attendeesOf, checklistOf, contactName, eventDuration, text } from './draftView';

const t: TranslateFn = (_key, en, params) =>
    Object.entries(params ?? {}).reduce((out, [name, value]) => out.split(`{${name}}`).join(String(value)), en);

it('reads strings and nothing else', () => {
    expect(text({ to: 'a@x.nl', cc: 3 }, 'to')).toBe('a@x.nl');
    expect(text({ to: 'a@x.nl', cc: 3 }, 'cc')).toBe('');
});

it('says how long an event is, in the web\'s words', () => {
    expect(eventDuration('2026-03-02T10:00:00Z', '2026-03-02T10:45:00Z', t)).toBe('45 min');
    expect(eventDuration('2026-03-02T10:00:00Z', '2026-03-02T12:00:00Z', t)).toBe('2h');
    expect(eventDuration('2026-03-02T10:00:00Z', '2026-03-02T11:30:00Z', t)).toBe('1h 30m');
    expect(eventDuration('2026-03-02T10:00:00Z', '', t)).toBeNull();
});

it('splits attendees, names a contact and reads a checklist defensively', () => {
    expect(attendeesOf({ attendees: 'a@x.nl, b@y.nl,' })).toEqual(['a@x.nl', 'b@y.nl']);
    expect(contactName({ firstName: 'Anna', lastName: 'Jansen' }, t)).toBe('Anna Jansen');
    expect(contactName({}, t)).toBe('Contact');
    expect(checklistOf({ listItems: [{ text: 'Milk', checked: true }, null, { text: 4 }] })).toEqual([
        { text: 'Milk', checked: true },
        { text: '', checked: false },
        { text: '', checked: false },
    ]);
});
