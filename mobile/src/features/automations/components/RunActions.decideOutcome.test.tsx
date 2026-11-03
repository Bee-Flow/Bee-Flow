/**
 * Honest decisions. Approve on a run used to post without answers (a 400 for
 * an approval with required fields) and returned nothing, so a panel vote
 * looked like a decision. The answer is now read (api/readers.ts
 * readRunDecisionResult) and told as what it is (model/decisionOutcome.ts),
 * and an approval that asks for answers goes to the approvals screen with
 * its decide sheet open (approveRoute). The screen half (the post, the
 * toast, the redirect) is in screens/RunDetailScreen.test.tsx.
 */

import { screen, userEvent } from '@testing-library/react-native';
import React from 'react';

import { renderScreen } from '@/shared/testing/renderWithProviders';

import { RunActions } from './RunActions';
import { readRunDecisionResult, readRunPendingApproval } from '../api/readers';
import { approvalNeedsAnswers, approveRoute, decisionOutcome } from '../model/decisionOutcome';

const t = (_key: string, fallback: string) => fallback;

const text = (raw: unknown, decision: 'approve' | 'reject' = 'approve') => decisionOutcome(readRunDecisionResult(raw, decision), t);

describe('what a decision came to', () => {
    it('says a panel vote is a vote, and the run still waits', () => {
        expect(text({ accepted: true, decision: 'vote_recorded', votes: [] })).toEqual({
            text: 'Your vote is recorded. It still waits for the others.',
            tone: 'neutral',
        });
    });

    it('says a stage that passed moved on, and a panel that waits for its final approver', () => {
        expect(text({ decision: 'vote_recorded', stage: 'finance' }).text).toBe('Your vote is recorded. It moved to the next stage.');
        expect(text({ decision: 'vote_recorded', stage: 'final' }).text).toBe('Your vote is recorded. It now waits for the final approver.');
    });

    it('says a decision whose continuation is still going, and one that finished', () => {
        expect(text({ accepted: true, pending: true, runId: 'r2' }).text).toBe('Approved. The run continues.');
        expect(text({ accepted: true, decision: 'approve', run: { id: 'r2', status: 'success' } }).text).toBe('Approved. The run carried on.');
        expect(text({ accepted: true, decision: 'reject', run: { id: 'r1', status: 'error' } }, 'reject').text).toBe('Rejected');
        expect(text({ accepted: true, pending: true, runId: 'r2', decision: 'reject' }, 'reject').text).toBe('Rejected. The run continues on its rejected branch.');
    });

    it('reads an empty answer (an older server, the legacy confirm) as the decision that was sent', () => {
        expect(readRunDecisionResult(undefined, 'approve')).toEqual({ kind: 'decided', decision: 'approve', run: null });
    });
});

describe('where Approve goes', () => {
    const pending = (fields: unknown[]) => readRunPendingApproval({ approvalId: 'ap 1', prompt: 'Refund?', fields, canDecide: true });

    it('opens the approvals screen, sheet open, when the approval asks for answers', () => {
        expect(approveRoute(pending([{ name: 'amount', type: 'number', required: true }]))).toBe('/approvals/ap%201?decide=approve');
    });

    it('posts from the run when it asks nothing, only shows something, or the server did not say', () => {
        expect(approveRoute(pending([]))).toBeNull();
        expect(approvalNeedsAnswers(pending([{ name: 'note', type: 'info' }]))).toBe(false);
        expect(approveRoute(readRunPendingApproval(undefined))).toBeNull();
        expect(approveRoute(null)).toBeNull();
    });

    it('holds Approve while it is still finding out, and lets Reject through', async () => {
        const decide = { run: jest.fn(), pending: false, checking: true };
        const pause = { kind: 'approval' as const, canDecide: true, isTest: false, text: 'Waiting for your decision', hint: null, stopLabel: 'Stop this run', testLabel: null };
        await renderScreen(<RunActions pause={pause} live={false} decide={decide} stop={{ run: jest.fn(), pending: false }} retry={{ run: jest.fn(), pending: false }} />);
        const user = userEvent.setup();
        await user.press(screen.getByText('Approve'));
        expect(decide.run).not.toHaveBeenCalled();
        await user.press(screen.getByText('Reject'));
        expect(decide.run).toHaveBeenCalledWith('reject');
    });
});
