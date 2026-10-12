import { describe, expect, it } from 'vitest';
import {
    connectorState, nextSweepAt, statusLabel, sweepIsLate, sweepText, toneOfConnector,
} from './connectorStatus';

const t = (_key: string, fallback: string, params?: Record<string, unknown>) =>
    Object.entries(params || {}).reduce((out, [k, v]) => out.split(`{${k}}`).join(String(v)), fallback);

const HOUR = 3_600_000;

describe('connectorStatus', () => {
    const at = '2026-09-14T06:00:00Z';

    it('reads the five states in order: off, never swept, failed, findings, collecting', () => {
        expect(connectorState(null)).toBe('off');
        expect(connectorState({ enabled: false, last_sweep_at: at, last_status: 'ok' })).toBe('off');
        expect(connectorState({ enabled: true })).toBe('never');
        expect(connectorState({ enabled: true, last_sweep_at: at, last_status: 'error', last_error: 'token expired' })).toBe('failed');
        expect(connectorState({ enabled: true, last_sweep_at: at, last_status: 'warn', last_error: '1 repo unprotected' })).toBe('findings');
        expect(connectorState({ enabled: true, last_sweep_at: at, last_status: 'ok' })).toBe('collecting');
    });

    it('an unknown last_status after a sweep is not "Never swept"', () => {
        expect(statusLabel(t, { enabled: true, last_sweep_at: at, last_status: 'partial' })).toBe('Collecting');
        expect(statusLabel(t, { enabled: true, last_sweep_at: at, last_status: null, last_error: 'x' })).toBe('Swept with findings');
        expect(statusLabel(t, { enabled: true, last_sweep_at: null })).toBe('Never swept');
        expect(statusLabel(t, { enabled: false })).toBe('Off');
        expect(statusLabel(t, { enabled: true, last_sweep_at: at, last_status: 'error' })).toBe('Last sweep failed');
    });

    it('tones follow the states', () => {
        expect(toneOfConnector({ enabled: false })).toBe('neutral');
        expect(toneOfConnector({ enabled: true })).toBe('warning');
        expect(toneOfConnector({ enabled: true, last_sweep_at: at, last_error: 'x' })).toBe('warning');
        expect(toneOfConnector({ enabled: true, last_sweep_at: at, last_status: 'error' })).toBe('error');
        expect(toneOfConnector({ enabled: true, last_sweep_at: at, last_status: 'ok' })).toBe('success');
    });

    it('expects the next sweep six hours on, and calls it late only after a whole interval more', () => {
        expect(nextSweepAt({ last_sweep_at: at })).toBe('2026-09-14T12:00:00.000Z');
        const swept = new Date(at).getTime();
        expect(sweepIsLate({ enabled: true, last_sweep_at: at }, swept + 11 * HOUR)).toBe(false);
        expect(sweepIsLate({ enabled: true, last_sweep_at: at }, swept + 13 * HOUR)).toBe(true);
        expect(sweepIsLate({ enabled: false, last_sweep_at: at }, swept + 30 * HOUR)).toBe(false);
        expect(sweepIsLate({ enabled: true }, swept)).toBe(false);
    });

    it('writes the sweep cell, leaving the day off a next sweep on the same day', () => {
        const local = new Date(2026, 8, 14, 8, 30).toISOString();
        expect(sweepText(t, { last_sweep_at: local }, 'en', new Date(2026, 8, 15).getTime())).toBe('Swept 14 Sep 08:30 · next ~14:30');
        const late = new Date(2026, 8, 14, 21, 5).toISOString();
        expect(sweepText(t, { last_sweep_at: late }, 'en', new Date(2026, 8, 15).getTime())).toBe('Swept 14 Sep 21:05 · next ~15 Sep 03:05');
        expect(sweepText(t, { last_sweep_at: null })).toBeNull();
    });
});
