import { describe, expect, it } from 'vitest';
import { isRunningRun, isTestLikeRun, isWaitingRun, stopDiscards } from './runStop';

describe('runStop', () => {
    it('offers Stop for running, queued and every waiting status, never for a finished run', () => {
        for (const status of ['running', 'queued']) expect(isRunningRun({ status })).toBe(true);
        for (const status of ['awaiting_form', 'awaiting_approval']) expect(isWaitingRun({ status })).toBe(true);
        for (const status of ['success', 'error', 'cancelled', 'awaiting_confirm']) {
            expect(isRunningRun({ status }) || isWaitingRun({ status })).toBe(false);
        }
    });

    it('a waiting test or dry run is discarded; a waiting production run is stopped', () => {
        expect(stopDiscards({ status: 'awaiting_form', isTest: true })).toBe(true);
        expect(stopDiscards({ status: 'awaiting_approval', mode: 'dry_run' })).toBe(true);
        expect(stopDiscards({ status: 'awaiting_form', isTest: false, mode: 'live' })).toBe(false);
        expect(stopDiscards({ status: 'running', isTest: true })).toBe(false);
    });

    it('the server profile wins over the row flags when present', () => {
        expect(isTestLikeRun({ isTest: false, profile: { kind: 'test' } })).toBe(true);
        expect(isTestLikeRun({ isTest: true, profile: { kind: 'production' } })).toBe(false);
        expect(isTestLikeRun(null)).toBe(false);
    });
});
