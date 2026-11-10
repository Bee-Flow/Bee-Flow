import { describe, expect, it } from 'vitest';
import { cronFromPreset, presetFromCron } from './scheduleBuilderUtils';

describe('presetFromCron — an hour or minute out of range', () => {
    // The weekly and monthly forms clamp what they are given, so opening
    // `75 9 * * 1` as "Weekly" wrote `59 9 * * 1` back on mount.
    it.each(['75 9 * * 1', '0 24 * * 1,2', '99 99 * * 1', '60 9 15 * *', '0 99 15 * *'])('%s stays the raw expression', (cron) => {
        expect(presetFromCron(cron)).toEqual({ mode: 'custom', cron });
        expect(cronFromPreset(presetFromCron(cron))).toBe(cron);
    });

    it('still reads the last valid minute and hour as a preset', () => {
        expect(presetFromCron('59 23 * * 1,7')).toEqual({ mode: 'weekly', hour: 23, minute: 59, days: [1, 0] });
        expect(presetFromCron('59 23 15 * *')).toEqual({ mode: 'monthly', hour: 23, minute: 59, day: 15 });
    });
});
