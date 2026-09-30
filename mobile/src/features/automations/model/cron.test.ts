/**
 * The five schedule shapes a phone may edit: each one round-trips, anything
 * else is refused (so the picker leaves it alone), and every cron has words.
 */

import { cronFromSimple, DEFAULT_SIMPLE_SCHEDULE, describeCron, simpleFromCron, type SimpleSchedule } from './cron';

const shape = (over: Partial<SimpleSchedule>): SimpleSchedule => ({ ...DEFAULT_SIMPLE_SCHEDULE, ...over });

describe('cronFromSimple / simpleFromCron', () => {
    it.each([
        [shape({ kind: 'hourly', minute: 15 }), '15 * * * *'],
        [shape({ kind: 'daily', minute: 30, hour: 8 }), '30 8 * * *'],
        [shape({ kind: 'weekdays', minute: 0, hour: 9 }), '0 9 * * 1-5'],
        [shape({ kind: 'weekly', minute: 5, hour: 17, weekday: 5 }), '5 17 * * 5'],
        [shape({ kind: 'monthly', minute: 0, hour: 6, day: 28 }), '0 6 28 * *'],
    ])('round-trips %j as %s', (schedule, cron) => {
        expect(cronFromSimple(schedule)).toBe(cron);
        expect(simpleFromCron(cron)).toEqual(schedule);
    });

    it('clamps out-of-range fields into ones cron accepts', () => {
        expect(cronFromSimple(shape({ kind: 'monthly', minute: 75, hour: -2, day: 31 }))).toBe('59 0 28 * *');
    });

    it('folds weekday 7 into Sunday, as the server does', () => {
        expect(simpleFromCron('0 9 * * 7')?.weekday).toBe(0);
    });

    it.each(['', '0 9 * *', '*/5 * * * *', '0 9 * 1 *', '0 9 29 * *', '0 9 1 * 1', '0 9 * * 8', '0 9-17 * * *'])(
        'refuses %j, which the picker cannot represent',
        (cron) => {
            expect(simpleFromCron(cron)).toBeNull();
        },
    );
});

describe('describeCron', () => {
    it('says each shape in words, with the zone when there is one', () => {
        expect(describeCron('15 * * * *')).toBe('Every hour at :15');
        expect(describeCron('30 8 * * *', 'Europe/Amsterdam')).toBe('Every day at 08:30 (Europe/Amsterdam)');
        expect(describeCron('0 9 * * 1-5')).toBe('Every weekday at 09:00');
        expect(describeCron('5 17 * * 5')).toBe('Every Friday at 17:05');
        expect(describeCron('0 6 28 * *')).toBe('Day 28 of each month at 06:00');
    });

    it('shows any other expression verbatim, and says when there is none', () => {
        expect(describeCron('*/5 * * * *')).toBe('On a custom schedule: */5 * * * *');
        expect(describeCron(null)).toBe('On a schedule that has not been set');
    });
});
