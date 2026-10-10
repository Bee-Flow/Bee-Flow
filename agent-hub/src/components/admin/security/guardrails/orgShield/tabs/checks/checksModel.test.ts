import { describe, it, expect } from 'vitest';

import type { ShieldEvidence } from '../../activity/useShieldEvidence';
import { toolGapCount } from './checksModel';

const evidence = (toolPii: number, scannedCalls = 40): ShieldEvidence => ({
    days: 30, replaced: 0, stopped: 0, passed: 0, toolPii, piiNonEuCount: 0,
    totalCalls: 50, scannedCalls, local: 0, eu: 0, outside: 0, viaNetwork: 0, unknown: 0,
    toolKinds: {}, topToolKinds: [],
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
