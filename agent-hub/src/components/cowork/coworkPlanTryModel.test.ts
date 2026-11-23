// What a try-out says: how each step went, the totals, and a step's time.
import { describe, expect, it } from 'vitest';
import { shortDuration, tryIsRunning, tryToneOf, tryTotals } from './coworkPlanTryModel';
import { supplierRadarTry } from './coworkPlan.fixture';

describe('tryToneOf', () => {
    it('a step that ran is done when it only reads, and held back when it would change or send', () => {
        expect(tryToneOf({ status: 'success', held: false })).toBe('ok');
        expect(tryToneOf({ status: 'success', held: true })).toBe('held');
    });

    it('a step that has not run is waiting, at work, failed or never reached, whatever it would have done', () => {
        const tones = ['pending', 'queued', 'running', 'error', 'handled_error', 'skipped', 'not_reached', 'cancelled'].map((status) => tryToneOf({ status, held: true }));
        expect(tones).toEqual(['pending', 'pending', 'running', 'failed', 'failed', 'skipped', 'skipped', 'skipped']);
    });
});

describe('tryTotals', () => {
    it('counts the steps that ran, the ones held back among them, and the failures', () => {
        expect(tryTotals(supplierRadarTry())).toEqual({ total: 7, ran: 7, held: 3, failed: 0 });
        const state = supplierRadarTry();
        state.steps[1] = { ...state.steps[1]!, status: 'error' };
        state.steps[2] = { ...state.steps[2]!, status: 'not_reached' };
        state.steps[3] = { ...state.steps[3]!, status: 'not_reached' };
        expect(tryTotals(state)).toEqual({ total: 7, ran: 4, held: 2, failed: 1 });
    });
});

describe('shortDuration', () => {
    it('reads seconds with one decimal under a minute, minutes and seconds from there', () => {
        expect(shortDuration(12)).toBe('<0.1 s');
        expect(shortDuration(60)).toBe('0.1 s');
        expect(shortDuration(1240)).toBe('1.2 s');
        expect(shortDuration(59_940)).toBe('59.9 s');
        expect(shortDuration(59_960)).toBe('1m 00s');
        expect(shortDuration(125_000)).toBe('2m 05s');
    });

    it('says nothing for a time that was not measured, and never a negative one', () => {
        for (const none of [null, undefined, Number.NaN]) expect(shortDuration(none)).toBe('');
        expect(shortDuration(-500)).toBe('<0.1 s');
    });
});

describe('tryIsRunning', () => {
    it('is at work from the moment it is started until the try-out is over', () => {
        expect(tryIsRunning(null, false)).toBe(false);
        expect(tryIsRunning(null, true)).toBe(true);
        expect(tryIsRunning(supplierRadarTry({ done: false, status: 'running' }), false)).toBe(true);
        expect(tryIsRunning(supplierRadarTry(), false)).toBe(false);
    });
});
