/**
 * The date shapes against the web's formatDates.ts (differential, locale
 * 'en', a fixed now) and the picker helpers.
 */

import * as port from './time';

jest.mock('../../../../../agent-hub/src/hooks/useTranslation', () => ({ __esModule: true, default: () => ({ resolvedLocale: 'en' }) }));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const web = require('../../../../../agent-hub/src/components/admin/compliance/shared/formatDates.ts');

const NOW = new Date(2026, 9, 5, 15, 30).getTime();
const VALUES = [
    '2026-08-19T20:38:05',
    new Date(2026, 8, 14, 9, 5, 7).toISOString(),
    '2025-03-03T08:00:00',
    '2026-12-02',
    '2024-02-29',
    '2026-13-45',
    new Date(2026, 0, 1, 0, 0, 0).getTime(),
    '',
    null,
    'nonsense',
];

describe('formatDates port matches the web', () => {
    it.each(VALUES.map((v) => [String(v), v]))('formatDay / formatDayTime / formatStamp(%s)', (_label, value) => {
        expect(port.formatDay(value, 'en', NOW)).toBe(web.formatDay(value, 'en', NOW));
        expect(port.formatDayTime(value, 'en', NOW)).toBe(web.formatDayTime(value, 'en', NOW));
        expect(port.formatStamp(value, 'en', NOW)).toBe(web.formatStamp(value, 'en', NOW));
    });

    it('writes the shapes the brief names', () => {
        expect(port.formatStamp('2026-08-19T20:38:05', 'en', NOW)).toBe('19 Aug 20:38:05');
        expect(port.formatDayTime('2026-10-05T14:03:00', 'en', NOW)).toBe('5 Oct 14:03');
        expect(port.formatDay('2025-03-03', 'en', NOW)).toBe('3 Mar 2025');
    });
});

describe('day helpers', () => {
    it('moves a day and falls back to today', () => {
        expect(port.shiftDay('2026-02-28', 1)).toBe('2026-03-01');
        expect(port.shiftDay('', -1, NOW)).toBe('2026-10-04');
        expect(port.isoDay(NOW)).toBe('2026-10-05');
    });

    it('adds calendar months, clamped to the month end', () => {
        expect(port.addMonthsDay(new Date(2026, 0, 31, 12).getTime(), 1)).toBe('2026-02-28');
        expect(port.addMonthsDay(NOW, 12)).toBe('2027-10-05');
    });
});
