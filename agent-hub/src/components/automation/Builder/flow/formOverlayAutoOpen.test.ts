import { describe, it, expect } from 'vitest';
import { shouldAutoOpenFormOverlay, dismissKey, awaitingFormStepId } from './formOverlayAutoOpen';

const base = {
    liveFromBuilder: true, runId: 'r1', awaitingStepId: 'fp_2', overlayOpen: false,
    dismissed: new Set<string>(),
};

describe('shouldAutoOpenFormOverlay', () => {
    it('opens for a live run from this builder that is parked on a form', () => {
        expect(shouldAutoOpenFormOverlay(base)).toBe(true);
    });
    it('never opens for a dry run or a run from elsewhere', () => {
        expect(shouldAutoOpenFormOverlay({ ...base, liveFromBuilder: false })).toBe(false);
    });
    it('does nothing while an overlay is already open', () => {
        expect(shouldAutoOpenFormOverlay({ ...base, overlayOpen: true })).toBe(false);
    });
    it('does nothing without a run id or a waiting step', () => {
        expect(shouldAutoOpenFormOverlay({ ...base, runId: null })).toBe(false);
        expect(shouldAutoOpenFormOverlay({ ...base, awaitingStepId: null })).toBe(false);
    });
    it('stays closed for a page the user dismissed, but opens for the next one', () => {
        const dismissed = new Set([dismissKey('r1', 'fp_2')]);
        expect(shouldAutoOpenFormOverlay({ ...base, dismissed })).toBe(false);
        expect(shouldAutoOpenFormOverlay({ ...base, dismissed, awaitingStepId: 'fp_3' })).toBe(true);
        expect(shouldAutoOpenFormOverlay({ ...base, dismissed, runId: 'r2' })).toBe(true);
    });
});

describe('awaitingFormStepId', () => {
    it('finds the parked row', () => {
        expect(awaitingFormStepId([{ stepId: 'a', status: 'success' }, { stepId: 'fp_2', status: 'awaiting_form' }])).toBe('fp_2');
    });
    it('is null when nothing is parked', () => {
        expect(awaitingFormStepId([{ stepId: 'a', status: 'running' }])).toBeNull();
        expect(awaitingFormStepId(null)).toBeNull();
    });
});
