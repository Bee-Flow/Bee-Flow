/**
 * DIFFERENTIAL lockstep: trigger names, the two renamed step names and their
 * keywords, the wait vocabulary and the schedule builder's cron helpers,
 * against the web builder's modules.
 */

import * as schedule from './schedule';
import * as names from './stepDisplayName';
import * as triggers from './triggerLabels';
import * as wait from './waitDuration';

const FLOW = '../../../../../agent-hub/src/components/automation/Builder/flow';
/* eslint-disable @typescript-eslint/no-require-imports */
const webTriggers = require(`${FLOW}/triggerLabels.js`);
const webNames = require(`${FLOW}/stepDisplayName.js`);
const webWait = require(`${FLOW}/waitDuration.js`);
const webSchedule = require(`${FLOW}/scheduleBuilderUtils.js`);
/* eslint-enable @typescript-eslint/no-require-imports */

describe('trigger labels', () => {
    it('the tables are the web\'s', () => {
        expect(triggers.TRIGGER_TYPE_LABEL).toEqual(webTriggers.TRIGGER_TYPE_LABEL);
        expect(triggers.TRIGGER_NAME).toEqual(webTriggers.TRIGGER_NAME);
        expect(triggers.APP_EVENT_TYPE_LABEL).toEqual(webTriggers.APP_EVENT_TYPE_LABEL);
    });

    const steps = [
        null, {}, { kind: 'schedule' }, { kind: 'bogus' }, { kind: 'app_event' },
        { kind: 'app_event', appEvent: { provider: 'gmail', event: 'mail.new' } },
        { kind: 'app_event', appEvent: { provider: 'gmail', event: 'nope' } },
        { kind: 'app_event', appEvent: { provider: 'gmail' } },
    ];
    it.each(steps.map((s) => [JSON.stringify(s), s] as const))('triggerTypeLabel(%s)', (_l, step) => {
        expect(triggers.triggerTypeLabel(step)).toBe(webTriggers.triggerTypeLabel(step));
    });

    it.each([undefined, null, 'form', 'layer_input', 'bogus'])('defaultTriggerLabel(%s)', (kind) => {
        expect(triggers.defaultTriggerLabel(kind)).toBe(webTriggers.defaultTriggerLabel(kind));
    });

    it.each(['', '  ', null, undefined, 'Trigger', 'Schedule', 'Schedule trigger', 'New email (Gmail)', 'My intake', 0])(
        'isGeneratedTriggerLabel(%j)',
        (label) => {
            expect(triggers.isGeneratedTriggerLabel(label)).toBe(webTriggers.isGeneratedTriggerLabel(label));
        },
    );
});

describe('step display names', () => {
    it('are the web\'s', () => {
        for (const key of ['SET_STEP_NAME', 'SET_STEP_DESC', 'ROUTE_STEP_NAME', 'ROUTE_STEP_DESC', 'ROUTE_STEP_KEYWORDS', 'SET_STEP_KEYWORDS'] as const) {
            expect((names as Record<string, unknown>)[key]).toBe(webNames[key]);
        }
    });
});

describe('wait duration', () => {
    it('the bounds and units are the web\'s', () => {
        expect([wait.WAIT_MIN_SECONDS, wait.WAIT_MAX_SECONDS]).toEqual([webWait.WAIT_MIN_SECONDS, webWait.WAIT_MAX_SECONDS]);
        expect(wait.WAIT_UNIT_FACTOR).toEqual(webWait.WAIT_UNIT_FACTOR);
    });

    it.each([0, -3, 0.4, 1, 59, 60, 61, 90, 120, 3600, 5400, 7200, 86400, 999999, NaN, '30', 'x', null])('%j', (value) => {
        expect(wait.formatWaitDuration(value)).toBe(webWait.formatWaitDuration(value));
        if (typeof value === 'number') {
            expect(wait.clampWaitSeconds(value)).toBe(webWait.clampWaitSeconds(value));
            expect(wait.waitUnitFor(value)).toBe(webWait.waitUnitFor(value));
        }
    });
});

describe('schedule builder', () => {
    const CRONS = [
        undefined, 42, '', '   ', '* * * * *', '*/5 * * * *', '*/0 * * * *', '*/60 * * * *', '15 * * * *', '75 * * * *',
        '0 9 * * *', '30 23 * * *', '0 25 * * *', '0 9 * * 1,3,5', '0 9 * * 7', '99 99 * * 1', '0 9 1 * *', '0 9 31 * *',
        '0 9 32 * *', '0 9 1 1 *', '0 9 * * MON', '0 0 1 1 * 2026', 'nonsense', '0 9 1-5 * *',
    ];
    it.each(CRONS.map((c) => [JSON.stringify(c), c] as const))('presetFromCron / describeCron %s', (_l, cron) => {
        expect(schedule.presetFromCron(cron)).toEqual(webSchedule.presetFromCron(cron));
        expect(schedule.describeCron(cron)).toBe(webSchedule.describeCron(cron));
        const preset = schedule.presetFromCron(cron);
        expect(schedule.cronFromPreset(preset)).toBe(webSchedule.cronFromPreset(preset));
    });

    const PRESETS = [
        null, 'x', {}, { mode: 'minute' }, { mode: 'minute', everyN: 90 }, { mode: 'hourly', minute: -4 }, { mode: 'daily', hour: 'a' },
        { mode: 'daily', hour: 30, minute: 7.8 }, { mode: 'weekly' }, { mode: 'weekly', days: [7, 3, 3, 'x', -1] },
        { mode: 'monthly', day: 40 }, { mode: 'custom', cron: '  1 2 3 4 5 ' }, { mode: 'custom', cron: ' ' }, { mode: 'yearly' },
    ];
    it.each(PRESETS.map((p) => [JSON.stringify(p), p] as const))('cronFromPreset %s', (_l, preset) => {
        expect(schedule.cronFromPreset(preset as never)).toBe(webSchedule.cronFromPreset(preset));
    });

    it('names a weekday in the viewer\'s language', () => {
        expect(schedule.weekdayLabel(1)).toBe('Mon');
        expect(schedule.weekdayLabel(0, (key, fb) => `${key}=${fb}`)).toBe('mobile.flow.weekday.0=Sun');
        expect(schedule.weekdayLabel(9)).toBe('9');
    });

    it('the constant lists are the web\'s', () => {
        expect(schedule.WEEKDAYS).toEqual(webSchedule.WEEKDAYS);
        expect([...schedule.SCHEDULE_MODES]).toEqual(webSchedule.SCHEDULE_MODES);
        expect(schedule.timezoneOptions()).toEqual(webSchedule.TIMEZONE_OPTIONS);
    });

    it('falls back to the curated zones without Intl.supportedValuesOf', () => {
        const intl = Intl as { supportedValuesOf?: unknown };
        const saved = intl.supportedValuesOf;
        try {
            intl.supportedValuesOf = undefined;
            expect(schedule.timezoneOptions()).toContain('Europe/Amsterdam');
            intl.supportedValuesOf = () => {
                throw new Error('no');
            };
            expect(schedule.timezoneOptions()[0]).toBe('UTC');
        } finally {
            intl.supportedValuesOf = saved;
        }
    });
});
