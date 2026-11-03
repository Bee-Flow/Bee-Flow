// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { decisionOutcome, decisionOutcomeText, stillPending } from './decisionOutcome';
import type { TranslateFn } from '@/hooks/useTranslation';

/**
 * One reading of a decision's answer for the Approvals section and the
 * builder's approval bar (tests-and-docs F5): the bar used to say "the run is
 * continuing" for a vote that left the run waiting, and for a 202 it never read.
 * The reply shapes are approvalService.decide's (automation/approvalDecision.js,
 * approvalVotes.js).
 */

// The English fallback with its {params} filled in, as useTranslation does without a dictionary.
const t: TranslateFn = (_key, fallback, params) => {
    const text = typeof fallback === 'string' ? fallback : '';
    const values = (typeof fallback === 'object' ? fallback : params) || {};
    return text.replace(/\{(\w+)\}/g, (_m, k: string) => String(values[k] ?? `{${k}}`));
};

const STAGES = {
    kind: 'stages',
    position: { index: 2, total: 3 },
    stages: [{ key: 's1', name: 'Team lead' }, { key: 's2', name: 'Finance' }, { key: 's3', name: 'Director' }],
};

describe('decisionOutcome', () => {
    it('a panel vote leaves the approval waiting', () => {
        const o = decisionOutcome({ accepted: true, decision: 'vote_recorded', progress: { rule: 'all' } }, 'approve');
        expect(o).toEqual({ kind: 'vote_recorded' });
        expect(stillPending(o)).toBe(true);
        expect(decisionOutcomeText(o, t)).toBe('Your vote is in — waiting for the other approvers.');
    });

    it('a stage that passed names the stage now waiting', () => {
        const o = decisionOutcome({ decision: 'vote_recorded', stage: 's2', progress: STAGES }, 'approve');
        expect(o).toEqual({ kind: 'stage_advanced', stageName: 'Finance', index: 2, total: 3 });
        expect(stillPending(o)).toBe(true);
        expect(decisionOutcomeText(o, t)).toBe('This stage is done — it has moved on to Finance (stage 2 of 3).');
    });

    it('a panel that agreed waits for the final sign-off', () => {
        const o = decisionOutcome({ decision: 'vote_recorded', stage: 'final', progress: { rule: 'all' } }, 'approve');
        expect(o.kind).toBe('panel_final');
        expect(decisionOutcomeText(o, t)).toBe('The panel approved — waiting for the final sign-off.');
    });

    it('an approve answered with the continuation (200) or while it runs (202) continues the run', () => {
        const finished = decisionOutcome({ accepted: true, decision: 'approve', run: { id: 'child-1', status: 'success' } }, 'approve');
        expect(finished).toEqual({ kind: 'approved', runId: 'child-1', pending: false });
        const pending = decisionOutcome({ accepted: true, pending: true, runId: 'child-2', message: 'Resume started' }, 'approve');
        expect(pending).toEqual({ kind: 'approved', runId: 'child-2', pending: true });
        expect(stillPending(pending)).toBe(false);
        expect(decisionOutcomeText(pending, t)).toBe('Approved — the run is continuing.');
        expect(decisionOutcomeText(pending, t, { following: true })).toBe('Approved — following the run.');
    });

    it('a reject that ended the run says so', () => {
        const o = decisionOutcome({ accepted: true, decision: 'reject', run: { id: 'r1', status: 'error', errorClass: 'ApprovalRejected' } }, 'reject');
        expect(o).toEqual({ kind: 'rejected', runId: 'r1' });
        expect(decisionOutcomeText(o, t)).toBe('Rejected — the run has stopped.');
    });

    it('a reject that continued on the rejected branch says THAT, finished or still running', () => {
        const finished = decisionOutcome({ decision: 'reject', run: { id: 'child-3', status: 'success' } }, 'reject');
        expect(finished).toEqual({ kind: 'rejected_continued', runId: 'child-3', pending: false });
        const pending = decisionOutcome({ accepted: true, pending: true, runId: 'child-4', decision: 'reject' }, 'reject');
        expect(pending).toEqual({ kind: 'rejected_continued', runId: 'child-4', pending: true });
        expect(decisionOutcomeText(pending, t)).toBe('Rejected — the run continues on the rejected branch.');
        expect(decisionOutcomeText(pending, t, { following: true })).toBe('Rejected — following the run on the rejected branch.');
    });

    it('a reject of a run-less approval, or an unreadable answer, falls back on what was sent', () => {
        expect(decisionOutcome({ decision: 'reject', approval: { id: 'a1' } }, 'reject').kind).toBe('rejected');
        expect(decisionOutcome(null, 'reject').kind).toBe('rejected');
        expect(decisionOutcome(undefined, 'approve')).toEqual({ kind: 'approved', runId: null, pending: false });
    });
});
