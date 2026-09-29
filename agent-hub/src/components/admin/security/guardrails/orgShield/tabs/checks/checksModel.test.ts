import { describe, it, expect } from 'vitest';

import type { ShieldEvidence } from '../../activity/useShieldEvidence';
import { actionStep, lastCheckReadout, toolGapCount } from './checksModel';

const evidence = (toolPii: number, scannedCalls = 40): ShieldEvidence => ({
    days: 30, replaced: 0, stopped: 0, passed: 0, toolPii, piiNonEuCount: 0,
    totalCalls: 50, scannedCalls, local: 0, eu: 0, outside: 0, viaNetwork: 0, unknown: 0,
    toolKinds: {}, topToolKinds: [],
});

describe('actionStep', () => {
    it('follows the stored action', () => {
        expect(actionStep('tokenize', true)).toMatchObject({ fallback: 'Replace with placeholders', unlicensed: false });
        expect(actionStep('block', true)).toMatchObject({ fallback: 'Do not send the message', unlicensed: false });
    });

    it('flags placeholders that are stored but not in the plan — the server stops those messages', () => {
        expect(actionStep('tokenize', false).unlicensed).toBe(true);
        // Blocking needs no licence.
        expect(actionStep('block', false).unlicensed).toBe(false);
    });
});

describe('lastCheckReadout', () => {
    it('says off while the check is off, whatever mode is stored', () => {
        expect(lastCheckReadout(false, 'block').fallback).toBe('off');
    });

    it('names the mode while it is on', () => {
        expect(lastCheckReadout(true, 'ask').fallback).toBe('Ask');
        expect(lastCheckReadout(true, 'auto_redact').fallback).toBe('Hide it');
        expect(lastCheckReadout(true, 'block').fallback).toBe('Do not send');
    });

    it('does not guess at a mode it does not know', () => {
        expect(lastCheckReadout(true, 'something_new').fallback).toBe('on');
    });
});

describe('toolGapCount', () => {
    it('is unknown without the figures, never zero', () => {
        expect(toolGapCount(null)).toBeNull();
        expect(toolGapCount(undefined)).toBeNull();
    });

    it('gives the count when there is one', () => {
        expect(toolGapCount(evidence(83))).toBe(83);
        expect(toolGapCount(evidence(83, 0))).toBe(83);
    });

    it('trusts a zero only when calls in the window were checked', () => {
        expect(toolGapCount(evidence(0))).toBe(0);
        expect(toolGapCount(evidence(0, 0))).toBeNull();
    });
});
