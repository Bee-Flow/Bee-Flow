/**
 * Differential: the port and agent-hub's upcomingWhen.js answer the same on
 * the same inputs. When this fails the web side changed — update when.ts.
 */

import path from 'node:path';

import { loadWebModule } from '@/shared/testing/webModule';

import { dateBlockParts, meetingDurationMinutes, parseWhen, timeRange } from './when';

const WEB = path.resolve(__dirname, '../../../../../agent-hub/src/pages/meeting-notes/lib/upcomingWhen.js');
const web = loadWebModule<{
    parseWhen: typeof parseWhen;
    meetingDurationMinutes: typeof meetingDurationMinutes;
    dateBlockParts: typeof dateBlockParts;
    timeRange: typeof timeRange;
}>(WEB);

const VALUES: unknown[] = [
    null,
    undefined,
    '',
    '   ',
    'not a date',
    '2026-07-18',
    '2026-07-18T14:00:00Z',
    '2026-07-18T14:00:00+02:00',
    new Date('2026-07-18T09:30:00Z'),
    new Date('nope'),
];

const PAIRS: [unknown, unknown][] = [
    ['2026-07-18T14:00:00Z', '2026-07-18T15:30:00Z'],
    ['2026-07-18T14:00:00Z', '2026-07-18T14:00:00Z'],
    ['2026-07-18T15:00:00Z', '2026-07-18T14:00:00Z'],
    ['2026-07-18', '2026-07-19'],
    ['2026-07-18T14:00:00Z', null],
    [null, '2026-07-18T14:00:00Z'],
    ['2026-07-18T14:00:00Z', '2026-07-18'],
];

describe('when.ts matches upcomingWhen.js', () => {
    it.each(VALUES.map((v) => [v]))('parseWhen(%p)', (value) => {
        expect(parseWhen(value)).toEqual(web.parseWhen(value));
    });

    it.each(VALUES.map((v) => [v]))('dateBlockParts(%p)', (value) => {
        expect(dateBlockParts(value)).toEqual(web.dateBlockParts(value));
    });

    it.each(PAIRS)('meetingDurationMinutes and timeRange(%p, %p)', (start, end) => {
        expect(meetingDurationMinutes(start, end)).toBe(web.meetingDurationMinutes(start, end));
        expect(timeRange(start, end)).toBe(web.timeRange(start, end));
    });

    it('reads a bare date as local midnight, never UTC', () => {
        const when = parseWhen('2026-07-18');
        expect(when?.dateOnly).toBe(true);
        expect(when?.date.getDate()).toBe(18);
    });
});
